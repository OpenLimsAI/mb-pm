"""Checkpointed PM analysis over an immutable authorized snapshot.

Workflow JSON is private durable state. Only public_view is exposed; validated final
results and explicit change previews remain the only path to business writes.
"""

import copy
import json
import re
import time
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import update

from app.db.session import SessionLocal
from app.models.pm_ai import PMAIRun
from app.services import ai, pm_ai_generation
from app.services.pm_ai_context import ContextRequest, build_context, fingerprint, recheck_user

WINDOW_CALLS = 12
WINDOW_TOKENS = 131072
WINDOW_SECONDS = 600
JOB_CALLS = 64
JOB_TOKENS = 2097152
MAX_STEPS = 64
MAX_DEPTH = 6
BATCH_CHARS = 16000
COLLECTIONS = (
    "projects",
    "sub_projects",
    "tasks",
    "members",
    "dependencies",
    "calendars",
    "register_entries",
    "activities",
    "register_history",
    "deliverables",
    "acceptances",
    "baselines",
)
BLOCKED = {
    "snapshot_changed",
    "model_changed",
    "job_call_limit",
    "job_step_limit",
    "job_token_limit",
    "maximum_split_depth",
    "action_conflict",
    "authorization_changed",
    "workflow_result_limit",
    "step_input_limit",
}


class Paused(ai.AIError):
    def __init__(self, reason):
        super().__init__("分步分析已保存检查点；请查看暂停原因后继续或新建分析。", code=reason)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def model_fingerprint(config):
    provider = config["provider"]
    # Includes credentials only inside a one-way digest, never in the checkpoint.
    return fingerprint(
        {
            "provider": provider,
            "profile": config["providers"][provider],
            "revision": config.get("revision"),
        }
    )


def mentioned_positions(context, material):
    matches = []
    for task in sorted(context.get("tasks", []), key=lambda row: -len(row.get("name", ""))):
        name = task.get("name", "")
        if not name:
            continue
        suffix = r"(?![a-zA-Z0-9])" if name[-1].isascii() and name[-1].isalnum() else ""
        for match in re.finditer(re.escape(name) + suffix, material):
            if not any(match.start() < end and match.end() > start for start, end, _ in matches):
                matches.append((match.start(), match.end(), task["id"]))
    return sorted(matches)


def subset(context, rows, material=None, material_start=None):
    part = {
        key: copy.deepcopy(value)
        for key, value in context.items()
        if key not in {*COLLECTIONS, "source", "material", "_raw_indices"}
    }
    for key in COLLECTIONS:
        part[key] = copy.deepcopy(rows.get(key, []))
    part["_raw_indices"] = {key: list(range(len(part[key]))) for key in COLLECTIONS}
    part["material"] = context.get("material", "") if material is None else material
    start = context.get("_material_start", 0) if material_start is None else material_start
    part["_material_start"] = start
    task_ids = {
        row.get("task_id")
        for key in ("activities", "deliverables", "acceptances")
        for row in part[key]
    }
    for row in part["dependencies"]:
        task_ids.update((row.get("predecessor_id"), row.get("successor_id")))
    if part["material"]:
        task_ids.update(
            identifier for _, _, identifier in mentioned_positions(context, part["material"])
        )
    known = {row["id"] for row in part["tasks"]}
    for row in context.get("tasks", []):
        if row["id"] in task_ids and row["id"] not in known:
            part["tasks"].append(
                {key: copy.deepcopy(value) for key, value in row.items() if key != "notes"}
            )
    project_ids = {row.get("project_id") for key in COLLECTIONS for row in part[key]}
    sub_ids = {row.get("sub_project_id") for row in part["tasks"]}
    for key, needed in (("sub_projects", sub_ids), ("projects", project_ids)):
        known = {row["id"] for row in part[key]}
        for row in context.get(key, []):
            if row["id"] in needed and row["id"] not in known:
                part[key].append(copy.deepcopy(row))
    owner_ids = {
        row.get("owner_id")
        for key in ("tasks", "projects", "register_entries")
        for row in part[key]
    }
    known = {row["id"] for row in part["members"]}
    part["members"].extend(
        copy.deepcopy(row)
        for row in context.get("members", [])
        if row["id"] in owner_ids and row["id"] not in known
    )
    evidence = {row.get("evidence_id") for key in COLLECTIONS for row in part[key]}
    refs = []
    end = start + len(part["material"])
    for original in context["source"]["refs"]:
        ref = copy.deepcopy(original)
        if ref.get("type") == "material" and part["material"]:
            left, right = ref.get("start_offset", start), ref.get("end_offset", end)
            if left < end and right > start:
                ref["excerpt"] = part["material"][
                    max(0, left - start) : min(len(part["material"]), right - start)
                ]
                refs.append(ref)
        elif ref["id"] in evidence:
            refs.append(ref)
    part["source"] = {**copy.deepcopy(context["source"]), "refs": refs}
    part["workflow_batch"] = (
        "只分析当前批次所含资料和任务；其他批次单独处理，不重复创建其更新。派生结论不是新证据，引用仍须来自原始source.refs。"
    )
    return part


def atoms(context):
    values = []
    raw = context.get("_raw_indices")
    for key in COLLECTIONS:
        rows = context.get(key, [])
        for index in raw.get(key, []) if raw is not None else range(len(rows)):
            pending = [copy.deepcopy(rows[index])]
            while pending:
                row = pending.pop(0)
                fields = [
                    (len(value), name)
                    for name, value in row.items()
                    if name in {"notes", "body", "mitigation", "closure"}
                    and isinstance(value, str)
                    and len(value) > 1
                ]
                if len(encoded(row)) > BATCH_CHARS // 2 and fields:
                    _, name = max(fields)
                    text = row[name]
                    pending[0:0] = [
                        {**row, name: text[: len(text) // 2]},
                        {**row, name: text[len(text) // 2 :]},
                    ]
                else:
                    values.append((key, row))
    material = context.get("material", "")
    offset = context.get("_material_start", 0)
    for line in (piece for piece in re.findall(r"[^。；;\n]*(?:[。；;\n]|$)", material) if piece):
        pieces = [(offset, line)]
        while pieces:
            start, fragment = pieces.pop(0)
            matches = mentioned_positions(context, fragment)
            if len({identifier for _, _, identifier in matches}) > 8:
                boundary = matches[len(matches) // 2][0]
                pieces[0:0] = [
                    (start, fragment[:boundary]),
                    (start + boundary, fragment[boundary:]),
                ]
                continue
            boundary = min(2000, len(fragment))
            for left, right, _ in matches:
                if left < boundary < right:
                    boundary = left if left else right
                    break
            values.append(("material", (start, fragment[:boundary])))
            if boundary < len(fragment):
                pieces.insert(0, (start + boundary, fragment[boundary:]))
        offset += len(line)
    return values


def from_atoms(context, values):
    rows = {key: [] for key in COLLECTIONS}
    fragments = []
    for key, value in values:
        if key == "material":
            fragments.append(value)
        else:
            rows[key].append(value)
    return subset(
        context,
        rows,
        material="".join(value[1] for value in fragments),
        material_start=fragments[0][0] if fragments else 0,
    )


def split_context(context):
    values = atoms(context)
    if len(values) > 1:
        middle = len(values) // 2
        return [from_atoms(context, values[:middle]), from_atoms(context, values[middle:])]
    if values and values[0][0] == "material":
        start, text = values[0][1]
        if len(text) > 1:
            middle = len(text) // 2
            return [
                from_atoms(context, [("material", (start, text[:middle]))]),
                from_atoms(context, [("material", (start + middle, text[middle:]))]),
            ]
    return []


def step(identifier, kind, context, depth=0, children=None):
    return {
        "id": identifier,
        "kind": kind,
        "title": ("资料分析 " if kind == "analysis" else "分层汇总 ") + identifier,
        "state": "pending",
        "depth": depth,
        "input": context,
        "result": None,
        "children": children or [],
        "calls": 0,
        "duration_ms": 0,
    }


def new_window(number):
    return {"number": number, "calls_used": 0, "token_budget_used": 0, "started_at": None}


def initialize(context, config):
    if len(encoded(context)) <= BATCH_CHARS and (
        not context.get("material") or len(context.get("tasks", [])) <= 8
    ):
        ready = [step("1", "analysis", copy.deepcopy(context))]
    else:
        ready, pending = [], []
        for value in atoms(context):
            candidate = from_atoms(context, [*pending, value])
            if pending and (
                len(encoded(candidate)) > BATCH_CHARS
                or (candidate.get("material") and len(candidate["tasks"]) > 8)
            ):
                ready.append(step(str(len(ready) + 1), "analysis", from_atoms(context, pending)))
                pending = []
            pending.append(value)
        if pending:
            ready.append(step(str(len(ready) + 1), "analysis", from_atoms(context, pending)))
        if len(ready) > MAX_STEPS // 2 or any(
            len(encoded(item["input"])) > BATCH_CHARS * 2 for item in ready
        ):
            raise HTTPException(422, "资料超过分步分析硬容量，请缩小范围；系统未裁剪输入")
    return {
        "version": 1,
        "phase": "analysis",
        "steps": ready,
        "ledger": [],
        "snapshot_fingerprint": context["source"]["fingerprint"],
        "model_fingerprint": model_fingerprint(config),
        "window": new_window(1),
        "calls_used": 0,
        "token_budget_used": 0,
        "pause_reason": None,
        "recovery_used": False,
    }


def public_view(value, state):
    if not isinstance(value, dict) or value.get("version") != 1:
        return None
    steps = value.get("steps", [])
    window = value.get("window", {})
    sections = []
    for item in steps:
        result = item.get("result")
        if (
            item.get("state") == "completed"
            and item.get("kind") == "analysis"
            and isinstance(result, dict)
        ):
            refs = sorted(
                {ref for finding in result.get("findings", []) for ref in finding["evidence_ids"]}
            )
            sections.append(
                {"title": item["title"], "summary": result["summary"], "evidence_ids": refs}
            )
    return {
        "version": 1,
        "phase": value.get("phase", "analysis"),
        "completed_steps": sum(item["state"] == "completed" for item in steps),
        "total_steps": sum(item["state"] != "split" for item in steps),
        "calls_used": value.get("calls_used", 0),
        "call_limit": JOB_CALLS,
        "token_budget_used": value.get("token_budget_used", 0),
        "window": {key: window.get(key, 0) for key in ("number", "calls_used", "token_budget_used")}
        | {
            "call_limit": WINDOW_CALLS,
            "token_limit": WINDOW_TOKENS,
            "seconds_limit": WINDOW_SECONDS,
        },
        "pause_reason": value.get("pause_reason"),
        "can_resume": state == "paused" and value.get("pause_reason") not in BLOCKED,
        "steps": [
            {
                key: item[key]
                for key in ("id", "title", "kind", "state", "depth", "calls", "duration_ms")
            }
            for item in steps
        ],
        "sections": sections,
    }


def checkpoint(run_id, claim, workflow, *, state="running", result=None, error=""):
    with SessionLocal.begin() as db:
        changed = db.execute(
            update(PMAIRun)
            .where(PMAIRun.id == run_id, PMAIRun.claim == claim, PMAIRun.state == "running")
            .values(
                workflow=copy.deepcopy(workflow),
                state=state,
                result=result,
                error=error,
                claim=claim if state == "running" else None,
                finished_at=datetime.now(UTC)
                if state in {"succeeded", "failed", "cancelled"}
                else None,
            )
        )
        if changed.rowcount != 1:
            raise Paused("generation_cancelled")


def merged_actions(results):
    actions, by_target = [], {}
    for result in results:
        for original in result["draft_actions"]:
            action = copy.deepcopy(original)
            key = (action["kind"], action.get("task_id") or action.get("entry_id"))
            if key[0] not in {"task_update", "register_update"}:
                if action not in actions:
                    actions.append(action)
                continue
            if key not in by_target:
                actions.append(action)
                by_target[key] = action
                continue
            target = by_target[key]
            for field, value in action.items():
                if field in {"reason", "evidence_ids"}:
                    continue
                if field in target and target[field] != value:
                    raise Paused("action_conflict")
                target[field] = value
            target["evidence_ids"] = sorted(
                set(target["evidence_ids"]) | set(action["evidence_ids"])
            )
            if action["reason"] not in target["reason"]:
                target["reason"] += "；" + action["reason"]
    return actions


def synthesis_context(context, children):
    refs = {
        ref
        for child in children
        for finding in [*child["result"]["findings"], *child["result"]["draft_actions"]]
        for ref in finding["evidence_ids"]
    }
    part = subset(context, {key: [] for key in COLLECTIONS}, material="")
    part["projects"], part["sub_projects"], part["members"] = [], [], []
    part["source"]["refs"] = [
        {"id": ref["id"], "type": ref.get("type")}
        for ref in context["source"]["refs"]
        if ref["id"] in refs
    ]
    part["derived"] = [
        {
            "summary": child["result"]["summary"],
            "evidence_ids": sorted(
                {
                    ref
                    for item in [*child["result"]["findings"], *child["result"]["draft_actions"]]
                    for ref in item["evidence_ids"]
                }
            ),
        }
        for child in children
    ]
    part["workflow_batch"] = (
        "这些是已校验批次的派生结论，不是新证据。仅汇总关键结论并保留真实source.refs引用；draft_actions必须为[]，全部变更由系统逐项合并，不能删改。"
    )
    return part


def ensure_next(workflow, context):
    active = [item for item in workflow["steps"] if item["state"] != "split"]
    if any(item["state"] != "completed" for item in active):
        return False
    consumed = {identifier for item in active for identifier in item.get("children", [])}
    roots = [item for item in active if item["id"] not in consumed]
    if len(roots) == 1:
        return True
    groups = [roots[index : index + 2] for index in range(0, len(roots), 2)]
    for group in groups:
        if len(group) == 1:
            continue
        if len(workflow["steps"]) >= MAX_STEPS:
            raise Paused("job_step_limit")
        identifier = str(len(workflow["steps"]) + 1)
        workflow["steps"].append(
            step(
                identifier,
                "synthesis",
                synthesis_context(context, group),
                children=[item["id"] for item in group],
            )
        )
    workflow["phase"] = "synthesis"
    return False


def execute(run_id, claim):
    from app.services import pm_ai_runs

    with SessionLocal() as db:
        run = db.get(PMAIRun, run_id)
        if run is None or run.state != "running" or run.claim != claim:
            return
        workflow, context, request = copy.deepcopy(run.workflow), run.context, run.request
        try:
            config = ai.load_settings(db)
            provider, profile = config["provider"], config["providers"][config["provider"]]
            if not profile.get("model"):
                raise ValueError("empty model")
        except Exception:
            workflow["pause_reason"] = "model_configuration"
            checkpoint(
                run_id,
                claim,
                workflow,
                state="paused",
                error="模型配置当前不可用；已保存步骤，请恢复配置后继续。",
            )
            return
    if workflow["window"]["started_at"] is None:
        workflow["window"]["started_at"] = time.time()
    window_deadline = time.monotonic() + max(
        0, WINDOW_SECONDS - (time.time() - workflow["window"]["started_at"])
    )
    try:
        while True:
            if ensure_next(workflow, context):
                analyses = [
                    item["result"]
                    for item in workflow["steps"]
                    if item["kind"] == "analysis" and item["state"] == "completed"
                ]
                roots = [
                    item
                    for item in workflow["steps"]
                    if item["state"] == "completed"
                    and not any(
                        item["id"] in other.get("children", []) for other in workflow["steps"]
                    )
                ]
                findings = []
                for result in [*analyses, roots[-1]["result"]]:
                    for finding in result["findings"]:
                        if finding not in findings:
                            findings.append(finding)
                final = {
                    "summary": roots[-1]["result"]["summary"],
                    "findings": findings,
                    "draft_actions": merged_actions(analyses),
                }
                workflow["phase"] = "finalizing"
                final = pm_ai_runs.validate_result(
                    encoded(final), context, require_complete=True, workflow=True
                )
                with SessionLocal() as db:
                    current = db.get(PMAIRun, run_id)
                    if current.state != "running" or current.claim != claim:
                        return
                    pm_ai_runs.authorize_run(db, recheck_user(db, current.created_by), current)
                workflow["phase"], workflow["pause_reason"] = "complete", None
                checkpoint(run_id, claim, workflow, state="succeeded", result=final)
                return
            current_step = next(item for item in workflow["steps"] if item["state"] == "pending")
            current_step["state"] = "running"
            checkpoint(run_id, claim, workflow)
            attempt_state = {"call_number": 0, "last_ledger": None}
            started = time.monotonic()

            def before_attempt(*, _step=current_step, _state=attempt_state):
                with SessionLocal.begin() as db:
                    row = db.query(PMAIRun).filter_by(id=run_id).with_for_update().one()
                    if row.state != "running" or row.claim != claim:
                        raise Paused("generation_cancelled")
                    pm_ai_runs.authorize_run(db, recheck_user(db, row.created_by), row)
                    if model_fingerprint(ai.load_settings(db)) != workflow["model_fingerprint"]:
                        raise Paused("model_changed")
                    window = workflow["window"]
                    budget = (
                        16384
                        if _state["call_number"]
                        or request["scenario"] == "explain"
                        or provider == "kimi"
                        else 8192
                    )
                    reserved = (
                        len(encoded(_step["input"]).encode())
                        + len(pm_ai_runs.SYSTEM_PROMPT.encode())
                        + len(request["question"].encode())
                        + 16384
                        + budget
                    )
                    if reserved > WINDOW_TOKENS:
                        raise Paused("step_input_limit")
                    for condition, reason in (
                        (
                            time.monotonic() >= window_deadline
                            or time.time() - window["started_at"] >= WINDOW_SECONDS,
                            "window_time_limit",
                        ),
                        (window["calls_used"] >= WINDOW_CALLS, "window_call_limit"),
                        (
                            window["token_budget_used"] + reserved > WINDOW_TOKENS,
                            "window_token_limit",
                        ),
                        (workflow["calls_used"] >= JOB_CALLS, "job_call_limit"),
                        (workflow["token_budget_used"] + reserved > JOB_TOKENS, "job_token_limit"),
                    ):
                        if condition:
                            raise Paused(reason)
                    if _state["call_number"]:
                        workflow["recovery_used"] = True
                    _state["call_number"] += 1
                    window["calls_used"] += 1
                    workflow["calls_used"] += 1
                    window["token_budget_used"] += reserved
                    workflow["token_budget_used"] += reserved
                    _step["calls"] += 1
                    _state["last_ledger"] = {
                        "step_id": _step["id"],
                        "attempt": _state["call_number"],
                        "reserved_tokens": reserved,
                        "state": "reserved",
                        "usage": {},
                    }
                    workflow["ledger"].append(_state["last_ledger"])
                    row.workflow = copy.deepcopy(workflow)
                    row.provider, row.model = provider, profile["model"]

            def progress(metadata, usage, *, _state=attempt_state):
                last_ledger = _state["last_ledger"]
                if last_ledger is not None and metadata["attempts"]:
                    attempt = metadata["attempts"][-1]
                    last_ledger.update(
                        state="completed" if attempt["finish_reason"] else "reserved",
                        usage=attempt["usage"],
                        finish_reason=attempt["finish_reason"],
                        error_code=attempt["error_code"],
                    )
                with SessionLocal.begin() as db:
                    row = db.query(PMAIRun).filter_by(id=run_id).with_for_update().one()
                    if row.state != "running" or row.claim != claim:
                        raise Paused("generation_cancelled")
                    row.workflow = copy.deepcopy(workflow)
                    totals = pm_ai_generation.totals(
                        [{"usage": item["usage"]} for item in workflow["ledger"]]
                    )
                    row.usage = pm_ai_generation.safe_usage({**totals, "_generation": metadata})

            try:
                text, _ = pm_ai_runs.generate_analysis(
                    provider,
                    profile,
                    request,
                    current_step["input"],
                    before_attempt=before_attempt,
                    on_progress=progress,
                    max_attempts=1 if workflow["recovery_used"] else 2,
                    workflow_step=True,
                    total_seconds=max(
                        1,
                        min(240, window_deadline - time.monotonic()),
                    ),
                )
                result = pm_ai_runs.validate_result(
                    text, current_step["input"], require_complete=True
                )
                if current_step["kind"] == "synthesis" and result["draft_actions"]:
                    raise Paused("action_conflict")
                if request["scenario"] == "meeting" and current_step["kind"] == "analysis":
                    material = current_step["input"].get("material", "")
                    if any(word in material for word in ("进度", "更新", "备注", "进展说明")):
                        updated = {
                            action.get("task_id")
                            for action in result["draft_actions"]
                            if action["kind"] == "task_update"
                        }
                        expected = {
                            identifier
                            for _, _, identifier in mentioned_positions(
                                current_step["input"], material
                            )
                        }
                        if not expected <= updated:
                            raise Paused("meeting_incomplete")
                current_step["result"], current_step["state"] = result, "completed"
                current_step["duration_ms"] += max(0, round((time.monotonic() - started) * 1000))
                checkpoint(run_id, claim, workflow)
            except ai.AIError as exc:
                if exc.code in {
                    "output_limit",
                    "model_output_format",
                    "model_empty_response",
                    "meeting_incomplete",
                    "step_input_limit",
                }:
                    children = (
                        split_context(current_step["input"])
                        if current_step["kind"] == "analysis"
                        else []
                    )
                    if (
                        children
                        and current_step["depth"] < MAX_DEPTH
                        and len(workflow["steps"]) + len(children) <= MAX_STEPS
                    ):
                        current_step["state"] = "split"
                        for child in children:
                            identifier = str(len(workflow["steps"]) + 1)
                            workflow["steps"].append(
                                step(identifier, "analysis", child, current_step["depth"] + 1)
                            )
                        checkpoint(run_id, claim, workflow)
                        continue
                    if children:
                        raise Paused("maximum_split_depth") from None
                raise
    except Exception as exc:
        reason = (
            exc.code
            if isinstance(exc, ai.AIError)
            else "authorization_changed"
            if isinstance(exc, HTTPException)
            else "model_error"
        )
        if reason == "generation_cancelled":
            return
        workflow["pause_reason"] = reason
        for item in workflow["steps"]:
            if item["state"] == "running":
                item["state"] = "pending"
        # Unsafe semantic results are never checkpoints and never repaired.
        checkpoint(
            run_id,
            claim,
            workflow,
            state="paused",
            error="本轮分步分析未完成，已保存可验证的步骤和调用预算；未应用业务变更。",
        )


def resume(db, user, run):
    from app.services import pm_ai_runs

    if db.bind.dialect.name == "postgresql":
        from sqlalchemy import text

        db.execute(text("SELECT pg_advisory_xact_lock(7211202610)"))
    row = db.query(PMAIRun).filter_by(id=run.id).with_for_update().populate_existing().one()
    pm_ai_runs.authorize_run(db, user, row)
    if row.state in {"queued", "running"}:
        return row
    if row.state != "paused" or not row.workflow:
        raise HTTPException(409, "该记录当前不能继续，请新建分析")
    workflow = copy.deepcopy(row.workflow)
    if workflow.get("pause_reason") in BLOCKED:
        raise HTTPException(409, "原资料或预算条件不再适用，请新建分析")
    current = build_context(db, user, ContextRequest.model_validate(row.request), workflow=True)
    reason = (
        "snapshot_changed"
        if current["source"]["fingerprint"] != workflow["snapshot_fingerprint"]
        else None
    )
    try:
        if model_fingerprint(ai.load_settings(db)) != workflow["model_fingerprint"]:
            reason = "model_changed"
    except Exception:
        workflow["pause_reason"] = "model_configuration"
        row.workflow = workflow
        db.commit()
        raise HTTPException(409, "模型配置当前不可用，检查点已保留，请恢复配置后继续") from None
    if reason:
        workflow["pause_reason"] = reason
        row.workflow = workflow
        db.commit()
        raise HTTPException(409, "原项目资料或模型设置已变化，请新建分析，不能混合旧步骤")
    active = db.query(PMAIRun).filter(PMAIRun.state.in_(["queued", "running"]))
    if active.filter(PMAIRun.created_by == user.id).count():
        raise HTTPException(409, "当前账号已有其他分析正在处理，请先完成或取消")
    if active.count() >= 16:
        raise HTTPException(429, "分析队列已满，请稍后继续")
    if workflow["calls_used"] >= JOB_CALLS or len(workflow["steps"]) >= MAX_STEPS:
        raise HTTPException(409, "本分析已到达累计硬上限，请缩小范围新建分析")
    workflow["window"] = new_window(workflow["window"]["number"] + 1)
    workflow["pause_reason"] = None
    for item in workflow["steps"]:
        if item["state"] == "running":
            item["state"] = "pending"
    row.workflow, row.state, row.error = workflow, "queued", ""
    row.claim, row.started_at, row.finished_at = None, None, None
    db.commit()
    return row
