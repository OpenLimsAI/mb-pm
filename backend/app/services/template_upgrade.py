"""Selective, optimistic and transactional template upgrades of executing projects.

Template IDs are identities. Never infer identity from labels or task names. Legacy
projects can bind each source node explicitly; deterministic instantiateTemplate IDs
are the only automatic fallback. Actual execution fields are never assigned here.
"""

import hashlib
import json
from collections import defaultdict, deque
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import uuid4

from fastapi import HTTPException

from app.models import (
    AuditLog,
    Project,
    SubProject,
    Task,
    TaskDependency,
    Template,
    TemplateVersion,
    User,
)
from app.models.planning import ProjectCalendar
from app.models.task_collaboration import TaskAcceptance, TaskActivity, TaskDeliverable
from app.models.template_upgrade import ProjectTemplateState
from app.schemas.structure import StructureSubIn, StructureTaskIn
from app.schemas.template import validate_template_structure
from app.services.planning import calendar_dict, is_workday, move_workdays
from app.services.rollup import recompute_project, recompute_subproject
from app.services.scope import is_full_access
from app.services.structure import _load, delete_block_reason
from app.services.team import team_ids

FIELDS = {
    "name": "名称",
    "code": "任务编号",
    "is_milestone": "里程碑",
    "estimated_effort": "预计工时（人日）",
    "cost_budget": "任务预算",
    "notes": "说明",
    "planned_end": "计划结束",
    "owner_id": "负责人",
    "sub_project_id": "所属子项目",
    "dependencies": "前置依赖",
}


def can_manage(project, actor):
    return is_full_access(actor) or (actor.role == "project_lead" and project.owner_id == actor.id)


def invalid(message):
    raise HTTPException(422, message)


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode()
    ).hexdigest()


# JSON saved through the browser is recursively snake-cased by the API client,
# while seeded/Excel template versions use the original TemplateNode camel keys.
# Normalize only known node/predecessor fields into an independent read model;
# the stored version JSON and stable node IDs are never modified or inferred.
NODE_ALIASES = {
    "taskCode": "task_code",
    "defaultDuration": "default_duration",
    "defaultEffort": "default_effort",
    "isMilestone": "is_milestone",
    "defaultRole": "default_role",
    "costBudget": "cost_budget",
    "ctdSection": "ctd_section",
    "regulatoryRef": "regulatory_ref",
    "milestoneLabel": "milestone_label",
    "isCriticalPath": "is_critical_path",
}
PREDECESSOR_ALIASES = {"taskCode": "task_code", "lagDays": "lag_days"}


def _known_aliases(value, aliases):
    if not isinstance(value, dict):
        invalid("模板节点或前置依赖格式无效")
    result = dict(value)
    for camel, snake in aliases.items():
        if camel in value and snake in value:
            # JSON booleans must not compare equal to numeric 0/1 here.
            different_type = isinstance(value[camel], bool) != isinstance(value[snake], bool)
            if different_type or value[camel] != value[snake]:
                invalid(f"模板字段 {camel} 与 {snake} 的值冲突，请明确保留一致的值")
        if snake in value:
            result[camel] = value[snake]
            result.pop(snake, None)
    return result


def normalized_tree(raw):
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (TypeError, ValueError):
            invalid("模板结构不是有效 JSON")
    count = 0

    def node(value, depth):
        nonlocal count
        count += 1
        if depth > 2 or count > 10000:
            invalid("模板只支持项目、子项目、任务三级且节点不超过 10000")
        result = _known_aliases(value, NODE_ALIASES)
        children = result.get("children")
        if children is not None:
            if not isinstance(children, list):
                invalid("模板子节点必须为列表")
            result["children"] = [node(child, depth + 1) for child in children]
        predecessors = result.get("predecessors")
        if predecessors is not None:
            if not isinstance(predecessors, list) or len(predecessors) > 200:
                invalid("模板前置依赖必须为列表且每项任务不超过 200 条")
            result["predecessors"] = [
                _known_aliases(pred, PREDECESSOR_ALIASES) for pred in predecessors
            ]
        return result

    tree = node(raw, 0)
    try:
        validate_template_structure(tree)
    except ValueError as error:
        invalid(str(error))
    return tree


def flatten(version):
    root = normalized_tree(version.structure_json)
    subs, nodes, codes = {}, {}, {}
    for sub in root.get("children", []):
        sid = sub.get("id")
        if not isinstance(sid, str) or not sid or sid in subs or sid in nodes:
            invalid("模板子项目缺少唯一稳定 ID，须先修正模板")
        subs[sid] = sub
        for node in sub.get("children", []):
            nid, code = node.get("id"), node.get("taskCode")
            if not isinstance(nid, str) or not nid or nid in nodes or nid in subs:
                invalid("模板任务缺少唯一稳定 ID，须先修正模板")
            if not isinstance(code, str) or not code or code in codes:
                invalid("模板任务编号缺失或重复，须先修正模板")
            nodes[nid] = {**node, "_sub": sid}
            codes[code] = nid
    if len(nodes) > 5000 or len(subs) > 200:
        invalid("单次模板升级最多支持 5000 个任务、200 个子项目")
    return subs, nodes, codes


def versions(db, project, source, target):
    if not project.template_id:
        invalid("空白项目未关联模板，不能直接升级；请先使用模板创建项目")
    rows = db.query(TemplateVersion).filter_by(template_id=project.template_id).all()
    by_number = {v.version_number: v for v in rows}
    if source not in by_number or target not in by_number:
        invalid("来源或目标模板版本不存在，请重新选择")
    return by_number[source], by_number[target]


def provenance(db, project, source, tasks, subs, request=None):
    old_subs, old_nodes, _ = flatten(source)
    state = db.get(ProjectTemplateState, project.id)
    mapping = dict(state.task_mapping or {}) if state else {}
    sub_mapping = dict(state.sub_mapping or {}) if state else {}
    removed = set(state.removed_nodes or []) if state else set()
    task_ids, sub_ids = {t.id for t in tasks}, {s.id for s in subs}
    # Existing instances generated by the shipped instantiation engine use these
    # exact IDs. Copies/manual legacy projects require an explicit binding.
    for nid, node in old_nodes.items():
        expected = f"{project.id}-{node['taskCode']}"
        if nid not in mapping and nid not in removed and expected in task_ids:
            mapping[nid] = expected
    for sid in old_subs:
        expected = f"{project.id}-{sid}"
        if sid not in sub_mapping and expected in sub_ids:
            sub_mapping[sid] = expected
    if request:
        if len({row.node_id for row in request.mappings}) != len(request.mappings) or len(
            {row.node_id for row in request.sub_mappings}
        ) != len(request.sub_mappings):
            invalid("同一模板节点不能重复绑定")
        for row in request.mappings:
            if row.node_id not in old_nodes and row.node_id not in mapping:
                invalid("只能绑定来源模板中已有的任务节点")
            if row.task_id:
                if row.task_id not in task_ids:
                    invalid("绑定任务不属于当前项目")
                mapping[row.node_id] = row.task_id
                removed.discard(row.node_id)
            else:
                mapping.pop(row.node_id, None)
        for row in request.sub_mappings:
            if row.node_id not in old_subs and row.node_id not in sub_mapping:
                invalid("只能绑定来源模板中已有的子项目节点")
            if row.sub_project_id not in sub_ids:
                invalid("绑定子项目不属于当前项目")
            sub_mapping[row.node_id] = row.sub_project_id
    live_mapping = {k: v for k, v in mapping.items() if v in task_ids}
    live_subs = {k: v for k, v in sub_mapping.items() if v in sub_ids}
    if len(set(live_mapping.values())) != len(live_mapping):
        invalid("同一任务不能绑定到多个模板节点")
    if len(set(live_subs.values())) != len(live_subs):
        invalid("同一子项目不能绑定到多个模板节点")
    return live_mapping, live_subs, removed


def notes(node):
    labels = (
        ("description", "描述"),
        ("ctdSection", "CTD"),
        ("regulatoryRef", "监管"),
        ("output", "输出物"),
        ("milestoneLabel", "里程碑"),
    )
    return " · ".join(f"{label}：{node[key]}" for key, label in labels if node.get(key)) or None


def static_fields(node):
    return {
        "name": node.get("name"),
        "is_milestone": bool(node.get("isMilestone")),
        "estimated_effort": node.get("defaultEffort") or 0,
        "cost_budget": node.get("costBudget"),
        "notes": notes(node),
    }


def predecessor_nodes(node, codes):
    out = []
    for pred in node.get("predecessors") or []:
        kind, lag = pred.get("type", "FS"), pred.get("lagDays", 0)
        if kind not in ("FS", "SS", "FF", "SF") or not isinstance(lag, int) or abs(lag) > 36500:
            invalid("模板依赖类型或滞后天数无效")
        out.append([codes.get(pred.get("taskCode"), f"external:{pred.get('taskCode')}"), kind, lag])
    return sorted(out)


def json_value(value):
    return float(value) if isinstance(value, Decimal) else value


def deletion_reason(db, task):
    reason = delete_block_reason(task)
    if reason or task.actual_effort is not None:
        return reason or "已录实际工时"
    if any(
        db.query(model).filter_by(task_id=task.id).first()
        for model in (TaskActivity, TaskDeliverable, TaskAcceptance)
    ):
        return "已有讨论、交付或验收记录，请保留该任务"
    return None


def catalog(db, project):
    template = db.get(Template, project.template_id) if project.template_id else None
    if not template:
        return {
            "template_id": None,
            "template_name": None,
            "source_version": project.template_version,
            "versions": [],
            "tasks": [],
            "sub_projects": [],
            "members": [],
        }
    all_versions = (
        db.query(TemplateVersion)
        .filter_by(template_id=template.id)
        .order_by(TemplateVersion.modified_at.desc())
        .all()
    )
    subs, tasks, _ = _load(db, project.id)
    source = next((v for v in all_versions if v.version_number == project.template_version), None)
    mapping, sub_mapping, removed = (
        provenance(db, project, source, tasks, subs) if source else ({}, {}, set())
    )
    return {
        "template_id": template.id,
        "template_name": template.name,
        "source_version": project.template_version,
        "versions": [
            {
                "version": v.version_number,
                "summary": v.change_summary,
                "nodes": [
                    {
                        "node_id": n,
                        "code": node["taskCode"],
                        "name": node["name"],
                        "sub_node_id": node["_sub"],
                    }
                    for n, node in flatten(v)[1].items()
                ],
                "subs": [{"node_id": sid, "name": s["name"]} for sid, s in flatten(v)[0].items()],
            }
            for v in all_versions
        ],
        "mappings": [{"node_id": k, "task_id": v} for k, v in mapping.items()],
        "sub_mappings": [{"node_id": k, "sub_project_id": v} for k, v in sub_mapping.items()],
        "removed_nodes": sorted(removed),
        "tasks": [{"id": t.id, "code": t.code, "name": t.name} for t in tasks],
        "sub_projects": [{"id": s.id, "name": s.name} for s in subs],
        "members": [
            {"id": u.id, "name": u.display_name}
            for u in db.query(User)
            .filter(User.id.in_(team_ids(db, project)), User.is_active.is_(True))
            .all()
        ],
    }


def preview(db, project, request):
    source, target = versions(db, project, request.source_version, request.target_version)
    old_subs, old_nodes, old_codes = flatten(source)
    new_subs, new_nodes, new_codes = flatten(target)
    subs, tasks, deps = _load(db, project.id)
    by_task, by_sub = {t.id: t for t in tasks}, {s.id: s for s in subs}
    mapping, sub_mapping, removed = provenance(db, project, source, tasks, subs, request)
    calendar = calendar_dict(db.get(ProjectCalendar, project.id))
    changes, unmapped = [], []
    owners = {row.node_id: row.owner_id for row in request.owner_overrides}
    if len(owners) != len(request.owner_overrides):
        invalid("同一模板节点不能重复配置负责人")
    if set(owners) - new_nodes.keys():
        invalid("负责人配置包含目标模板中不存在的节点")
    team = team_ids(db, project)
    active_users = {
        u.id for u in db.query(User).filter(User.id.in_(team), User.is_active.is_(True)).all()
    }
    if set(owners.values()) - active_users:
        invalid("新负责人必须为项目团队内的启用成员")
    # Require complete explicit provenance of the source before any change. A
    # missing task must not be confused with an intentionally deleted template node.
    for nid, node in old_nodes.items():
        if nid not in mapping and nid not in removed:
            unmapped.append({"node_id": nid, "name": node["name"], "kind": "task"})
    for sid, sub in old_subs.items():
        if sid not in sub_mapping:
            unmapped.append({"node_id": sid, "name": sub["name"], "kind": "sub"})

    def add(nid, kind, field, before, after, name, blocked=None, requires=None):
        if before == after:
            return
        changes.append(
            {
                "id": f"{kind}:{nid}:{field}",
                "node_id": nid,
                "kind": kind,
                "field": field,
                "label": FIELDS.get(field, field),
                "name": name,
                "before": before,
                "after": after,
                "blocked": blocked,
                "requires": requires or [],
            }
        )

    planned_cache = {}

    def added_dates(nid, visiting=None):
        if nid in mapping:
            task = by_task[mapping[nid]]
            return task.planned_start, task.planned_end
        if nid in planned_cache:
            return planned_cache[nid]
        visiting = set(visiting or ())
        if nid in visiting:
            invalid("目标模板依赖形成循环")
        visiting.add(nid)
        if len(visiting) > 200:
            invalid("新增任务的依赖链超过 200 层，请拆分模板升级")
        node = new_nodes[nid]
        stage_offset = {
            "临床前": 0,
            "IND": 360,
            "Ph1/2": 540,
            "Ph3": 720,
            "BLA": 900,
            "商业化": 1080,
            "上市后": 1260,
        }.get(node.get("stage"), 0)
        try:
            start = project.planned_start + timedelta(days=stage_offset)
        except OverflowError:
            invalid("模板阶段计划超出有效日期范围")
        duration = 0 if node.get("isMilestone") else int(node.get("defaultDuration") or 0)
        for pred, kind, lag in predecessor_nodes(node, new_codes):
            if pred not in new_nodes:
                continue  # surfaced as an unavailable prerequisite below
            pstart, pend = added_dates(pred, visiting)
            needed = move_workdays(pend if kind in ("FS", "FF") else pstart, lag, calendar)
            if kind in ("FF", "SF"):
                needed = move_workdays(needed, -duration, calendar)
            start = max(start, needed)
        if not is_workday(start, calendar):
            start = move_workdays(start, 1, calendar)
        planned_cache[nid] = start, move_workdays(start, duration, calendar)
        return planned_cache[nid]

    for sid, sub in new_subs.items():
        if sid not in sub_mapping:
            if sid not in old_subs:
                add(
                    sid,
                    "sub",
                    "add",
                    None,
                    {
                        "name": sub["name"],
                        "module": sub.get("module") or "其他",
                        "stage": sub.get("stage") or "临床前",
                    },
                    sub["name"],
                )
            continue
        obj = by_sub[sub_mapping[sid]]
        old = old_subs.get(sid, {})
        for field in ("name", "module", "stage"):
            if sub.get(field) != old.get(field):
                add(
                    sid,
                    "sub",
                    field,
                    getattr(obj, field),
                    sub.get(field) or ("其他" if field == "module" else "临床前"),
                    sub["name"],
                )
    for nid, node in new_nodes.items():
        tid = mapping.get(nid)
        required_sub = [] if node["_sub"] in sub_mapping else [f"sub:{node['_sub']}:add"]
        if not tid:
            if nid not in old_nodes:
                start, end = added_dates(nid)
                new = {
                    **static_fields(node),
                    "owner_id": owners.get(nid, project.owner_id),
                    "planned_start": start.isoformat(),
                    "planned_end": end.isoformat(),
                    "sub_node_id": node["_sub"],
                    "code": f"{project.code}-{node['taskCode']}",
                    "dependencies": predecessor_nodes(node, new_codes),
                }
                requirements = required_sub + [
                    f"task:{p}:add" for p, _, _ in new["dependencies"] if p not in mapping
                ]
                blocked = (
                    "模板引用未包含的前置任务，须先修正目标模板"
                    if any(p.startswith("external:") for p, _, _ in new["dependencies"])
                    else None
                )
                if new["owner_id"] not in active_users:
                    blocked = "新负责人未启用，请从项目团队选择负责人"
                add(nid, "task", "add", None, new, node["name"], blocked, requirements)
            continue
        task = by_task[tid]
        old = old_nodes.get(nid, {})
        if old and old.get("taskCode") != node.get("taskCode"):
            add(nid, "task", "code", task.code, f"{project.code}-{node['taskCode']}", task.name)
        for field, value in static_fields(node).items():
            if static_fields(old).get(field) != value:
                block = (
                    "已开始任务不能改变里程碑类型"
                    if field == "is_milestone" and delete_block_reason(task)
                    else None
                )
                add(nid, "task", field, json_value(getattr(task, field)), value, task.name, block)
        if old.get("defaultDuration", 0) != node.get("defaultDuration", 0) or old.get(
            "isMilestone"
        ) != node.get("isMilestone"):
            end = (
                task.planned_start
                if node.get("isMilestone")
                else move_workdays(
                    task.planned_start, int(node.get("defaultDuration") or 0), calendar
                )
            )
            add(
                nid,
                "task",
                "planned_end",
                task.planned_end.isoformat(),
                end.isoformat(),
                task.name,
                "已完成任务保留原计划" if task.status in ("已完成", "已验证") else None,
            )
        if nid in owners:
            add(nid, "task", "owner_id", task.owner_id, owners[nid], task.name)
        desired_sub = sub_mapping.get(node["_sub"], f"new:{node['_sub']}")
        if old.get("_sub") != node["_sub"]:
            add(
                nid,
                "task",
                "sub_project_id",
                task.sub_project_id,
                desired_sub,
                task.name,
                requires=required_sub,
            )
        if predecessor_nodes(old, old_codes) != predecessor_nodes(node, new_codes):
            desired = predecessor_nodes(node, new_codes)
            current = sorted(
                [
                    [
                        next(
                            (n for n, t in mapping.items() if t == d.predecessor_id),
                            f"unmapped:{d.predecessor_id}",
                        ),
                        d.type,
                        d.lag_days,
                    ]
                    for d in deps
                    if d.successor_id == task.id
                ]
            )
            add(
                nid,
                "task",
                "dependencies",
                current,
                desired,
                task.name,
                "模板引用未包含的前置任务，须先修正目标模板"
                if any(p.startswith("external:") for p, _, _ in desired)
                else None,
                requires=[f"task:{p}:add" for p, _, _ in desired if p not in mapping],
            )
    for nid in old_nodes:
        if nid not in new_nodes and nid in mapping:
            task = by_task[mapping[nid]]
            add(
                nid,
                "task",
                "delete",
                {"id": task.id, "name": task.name},
                None,
                task.name,
                "存在跨项目依赖，请先单独处理"
                if any(
                    task.id in (d.predecessor_id, d.successor_id)
                    and (d.predecessor_id not in by_task or d.successor_id not in by_task)
                    for d in deps
                )
                else deletion_reason(db, task),
            )
    # Empty removed subprojects are intentionally retained; business work outside
    # the template must not disappear as a side effect of upgrading a template.
    fingerprint = digest(
        {
            "source": source.structure_json,
            "target": target.structure_json,
            "source_id": source.id,
            "target_id": target.id,
            "project": [
                project.id,
                project.template_version,
                project.owner_id,
                project.planned_start,
                project.code,
            ],
            "tasks": [[t.id, t.revision, t.updated_at] for t in tasks],
            "subs": [[s.id, s.name, s.module, s.stage, s.updated_at] for s in subs],
            "deps": [
                [d.id, d.predecessor_id, d.successor_id, d.type, d.lag_days]
                for d in sorted(deps, key=lambda d: d.id)
            ],
            "mapping": mapping,
            "sub_mapping": sub_mapping,
            "removed": sorted(removed),
            "calendar": calendar,
            "owners": owners,
            "team": sorted(active_users),
            "changes": changes,
        }
    )
    return (
        {
            "source_version": request.source_version,
            "target_version": request.target_version,
            "fingerprint": fingerprint,
            "changes": changes,
            "unmapped": unmapped,
        },
        mapping,
        sub_mapping,
        removed,
    )


def apply(db, project, request, actor):
    db.query(Project).filter_by(id=project.id).with_for_update().populate_existing().one()
    if not can_manage(project, actor):
        raise HTTPException(403, "仅当前项目负责人或管理员可升级项目模板")
    task_ids = [t.id for t in _load(db, project.id)[1]]
    db.query(Task).filter(Task.id.in_(task_ids)).order_by(
        Task.id
    ).with_for_update().populate_existing().all()
    result, mapping, sub_mapping, removed = preview(db, project, request)
    if result["fingerprint"] != request.fingerprint:
        raise HTTPException(409, "项目、模板或人员已变化，请重新预览；本次未保存")
    if result["unmapped"]:
        invalid("请先明确全部来源节点与现有项目的绑定关系")
    available = {c["id"]: c for c in result["changes"]}
    selected = set(request.selected_ids)
    if len(selected) != len(request.selected_ids) or selected - available.keys():
        invalid("选择项已失效，请重新预览")
    if not selected and (available or project.template_version == request.target_version):
        invalid("请选择至少一项变更")
    chosen = [c for c in result["changes"] if c["id"] in selected]
    if any(c["blocked"] for c in chosen):
        invalid("选中项含保护任务，不能应用")
    for c in chosen:
        if set(c["requires"]) - selected:
            invalid(f"「{c['name']}」还需同时选择新增子项目或前置任务")
    subs, tasks, deps = _load(db, project.id)
    by_task = {t.id: t for t in tasks}
    values = {
        t.id: {
            "id": t.id,
            "key": t.id,
            "code": t.code,
            "name": t.name,
            "is_milestone": t.is_milestone,
            "owner_id": t.owner_id,
            "planned_start": t.planned_start,
            "planned_end": t.planned_end,
            "estimated_effort": t.estimated_effort,
            "cost_budget": t.cost_budget,
            "notes": t.notes,
            "sub_project_id": t.sub_project_id,
        }
        for t in tasks
    }
    sub_values = {s.id: {"name": s.name, "module": s.module, "stage": s.stage} for s in subs}
    before_values = {tid: dict(v) for tid, v in values.items()}
    new_tasks, deleted = set(), set()
    for c in chosen:
        nid, field, after = c["node_id"], c["field"], c["after"]
        if c["kind"] == "sub":
            if field == "add":
                sid = f"sp-{uuid4().hex[:20]}"
                sub_mapping[nid] = sid
                sub_values[sid] = dict(after)
            else:
                sub_values[sub_mapping[nid]][field] = after
    # Allocate all IDs before resolving forward dependency references.
    for c in chosen:
        if c["kind"] == "task" and c["field"] == "add":
            mapping[c["node_id"]] = f"tk-{uuid4().hex[:20]}"
    for c in chosen:
        if c["kind"] != "task":
            continue
        nid, field, after = c["node_id"], c["field"], c["after"]
        tid = mapping[nid]
        if field == "add":
            v = {k: v for k, v in after.items() if k not in ("sub_node_id", "dependencies")}
            v.update(id=tid, key=tid, sub_project_id=sub_mapping[after["sub_node_id"]])
            values[tid] = v
            new_tasks.add(tid)
        elif field == "delete":
            deleted.add(tid)
        elif field == "sub_project_id":
            values[tid][field] = sub_mapping[after[4:]] if after.startswith("new:") else after
        elif field != "dependencies":
            values[tid][field] = after
    for tid in deleted:
        del values[tid]
    # Validate every resulting task through the same field rules as structure
    # editing, without invoking its internal commit or touching other fields.
    codes = set()
    for value in values.values():
        parsed = StructureTaskIn.model_validate(value)
        value.update(parsed.model_dump(exclude={"predecessors"}))
        if value["sub_project_id"] not in sub_values:
            invalid("任务子项目不存在")
        if value["code"] in codes:
            invalid("升级后任务编号重复")
        codes.add(value["code"])
        if parsed.is_milestone and parsed.planned_start != parsed.planned_end:
            invalid("里程碑类型及计划结束须同时选择，使起止日期一致")
    for sid, value in sub_values.items():
        StructureSubIn.model_validate({"id": sid, "key": sid, **value})
    edge_values = {
        (d.predecessor_id, d.successor_id): [d.type, d.lag_days]
        for d in deps
        if d.predecessor_id not in deleted and d.successor_id not in deleted
    }
    for c in chosen:
        if c["kind"] != "task" or c["field"] not in ("add", "dependencies"):
            continue
        tid = mapping[c["node_id"]]
        preds = c["after"]["dependencies"] if c["field"] == "add" else c["after"]
        edge_values = {key: v for key, v in edge_values.items() if key[1] != tid}
        for nid, kind, lag in preds:
            pred = mapping.get(nid)
            if pred not in values or pred == tid:
                invalid("选中的前置任务缺失或自依赖，请调整选择")
            edge_values[(pred, tid)] = [kind, lag]
    # Include paths through other projects, without rewriting those edges.
    all_edges = {
        (d.predecessor_id, d.successor_id)
        for d in db.query(TaskDependency).all()
        if d.predecessor_id not in deleted
        and d.successor_id not in deleted
        and d.predecessor_id not in by_task
        and d.successor_id not in by_task
    }
    all_edges.update(edge_values)
    indegree, outgoing = {}, defaultdict(list)
    for pred, succ in all_edges:
        indegree.setdefault(pred, 0)
        indegree[succ] = indegree.get(succ, 0) + 1
        outgoing[pred].append(succ)
    queue = deque(tid for tid, count in indegree.items() if not count)
    visited = 0
    while queue:
        tid = queue.popleft()
        visited += 1
        for successor in outgoing[tid]:
            indegree[successor] -= 1
            if not indegree[successor]:
                queue.append(successor)
    if visited != len(indegree):
        invalid("升级后依赖形成循环，本次未保存")
    calendar = calendar_dict(db.get(ProjectCalendar, project.id))
    # Check only touched dependencies/dates; historic unrelated violations are
    # not silently shifted. The user can run the separate schedule preview.
    touched = {
        mapping[c["node_id"]]
        for c in chosen
        if c["kind"] == "task"
        and c["field"] in ("add", "planned_start", "planned_end", "dependencies", "is_milestone")
    }
    for (pred, succ), (kind, lag) in edge_values.items():
        if pred not in values or succ not in values or not ({pred, succ} & touched):
            continue
        a, b = values[pred], values[succ]
        anchor = a["planned_end"] if kind in ("FS", "FF") else a["planned_start"]
        actual = b["planned_start"] if kind in ("FS", "SS") else b["planned_end"]
        if actual < move_workdays(anchor, lag, calendar):
            invalid("升级后的计划与前置依赖冲突，请先在延迟推演调整现有计划，或分次选择变更")
    # All checks completed before any mutation.
    sub_ids = {s.id for s in subs}
    for sid, value in sub_values.items():
        if sid not in sub_ids:
            db.add(
                SubProject(
                    id=sid,
                    project_id=project.id,
                    status="未开始",
                    progress=0,
                    sort_order=len(sub_ids) + 1,
                    **value,
                )
            )
        else:
            obj = next(s for s in subs if s.id == sid)
            for key, val in value.items():
                setattr(obj, key, val)
    db.flush()
    for tid, value in values.items():
        fields = {k: v for k, v in value.items() if k not in ("id", "key")}
        if tid in new_tasks:
            db.add(
                Task(
                    id=tid,
                    status="未开始",
                    progress=0,
                    priority="中",
                    is_critical_path=False,
                    sort_order=max(
                        (
                            t.sort_order or 0
                            for t in tasks
                            if t.sub_project_id == fields["sub_project_id"]
                        ),
                        default=0,
                    )
                    + 1,
                    **fields,
                )
            )
        else:
            task = by_task[tid]
            for key, val in fields.items():
                if getattr(task, key) != val:
                    setattr(task, key, val)
            changes = {
                key: {"before": json_value(before_values[tid].get(key)), "after": json_value(val)}
                for key, val in fields.items()
                if before_values[tid].get(key) != val
            }
            if changes:
                db.add(
                    TaskActivity(
                        id=f"ta-{uuid4().hex}",
                        task_id=tid,
                        actor_id=actor.id,
                        kind="fields",
                        body=f"模板升级：{request.reason}",
                        changes=json.loads(json.dumps(changes, default=str)),
                        mention_ids=[],
                    )
                )
    db.flush()
    for d in deps:
        pair = (d.predecessor_id, d.successor_id)
        if pair not in edge_values:
            db.delete(d)
        elif [d.type, d.lag_days] != edge_values[pair]:
            d.type, d.lag_days = edge_values[pair]
    pairs = {(d.predecessor_id, d.successor_id) for d in deps}
    for pair, (kind, lag) in edge_values.items():
        if pair not in pairs:
            db.add(
                TaskDependency(
                    id=f"dep-{uuid4().hex[:20]}",
                    predecessor_id=pair[0],
                    successor_id=pair[1],
                    type=kind,
                    lag_days=lag,
                )
            )
    for tid in deleted:
        db.delete(by_task[tid])
    for nid, tid in list(mapping.items()):
        if tid in deleted:
            mapping.pop(nid)
            removed.add(nid)
    state = db.get(ProjectTemplateState, project.id)
    if state is None:
        state = ProjectTemplateState(project_id=project.id)
        db.add(state)
    state.task_mapping, state.sub_mapping, state.removed_nodes = (
        mapping,
        sub_mapping,
        sorted(removed),
    )
    db.flush()
    for sid in sub_values:
        recompute_subproject(db, sid)
    recompute_project(db, project.id)
    db.flush()
    remaining, _, _, _ = preview(db, project, request)
    if not remaining["changes"] and not remaining["unmapped"]:
        project.template_version = request.target_version
    db.add(
        AuditLog(
            id=f"log-{uuid4().hex[:12]}",
            actor_id=actor.id,
            action="模板选择升级",
            target="项目",
            target_id=project.id,
            detail=json.dumps(
                {
                    "source_version": request.source_version,
                    "target_version": request.target_version,
                    "reason": request.reason,
                    "changes": chosen,
                    "mapping": mapping,
                    "sub_mapping": sub_mapping,
                },
                ensure_ascii=False,
                default=str,
            ),
            created_at=datetime.now(UTC),
        )
    )
    db.commit()
    return {
        "applied": len(chosen),
        "remaining": len(remaining["changes"]),
        "template_version": project.template_version,
    }
