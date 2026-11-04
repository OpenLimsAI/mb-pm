"""Round-trip an existing project plan through a bounded, explicit Excel format.

Only task fields are editable. Missing rows never delete data; identity, revisions,
permissions and the resulting records are checked again at the apply boundary.
"""

import hashlib
import json
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from io import BytesIO
from zipfile import BadZipFile

from fastapi import HTTPException
from openpyxl import Workbook, load_workbook
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.models import Project, SubProject, Task, TaskDependency, User
from app.models.task_collaboration import TaskAcceptance
from app.schemas.business_values import validate_date_patch
from app.schemas.task import TaskUpdate
from app.services.excel import _check_xlsx_archive, _write_sheet
from app.services.scope import visible_project_ids_for
from app.services.team import team_ids

FORMAT = "CMC-PMS-PROJECT-ROUNDTRIP-1"
MAX_ROWS = 10000
MAX_ERRORS = 200
SHEET = "项目任务"
IDENTITY = {"任务ID": "id", "修订号": "revision", "任务编号": "code", "子项目": "sub_project_id"}
FIELDS = {
    "任务名称": "name",
    "负责人": "owner_id",
    "计划开始": "planned_start",
    "计划结束": "planned_end",
    "状态": "status",
    "进度(%)": "progress",
    "预计工时(人天)": "estimated_effort",
    "实际开始": "actual_start",
    "实际结束": "actual_end",
    "实际工时(人天)": "actual_effort",
    "任务预算(万元)": "cost_budget",
    "实际花费(万元)": "actual_cost",
    "优先级": "priority",
    "备注": "notes",
}
DATES = {"planned_start", "planned_end", "actual_start", "actual_end"}
NUMBERS = {"estimated_effort", "actual_effort", "cost_budget", "actual_cost"}
REQUIRED = {
    "name",
    "owner_id",
    "planned_start",
    "planned_end",
    "status",
    "progress",
    "estimated_effort",
    "priority",
}


def json_value(value):
    if isinstance(value, date | datetime):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


def project_state(db: Session, user: User, project_id: str, lock: bool = False):
    query = db.query(Project).filter_by(id=project_id)
    project = (query.populate_existing().with_for_update() if lock else query).first()
    if not project or project_id not in visible_project_ids_for(user, db):
        raise HTTPException(404, "项目不存在或不可访问")
    if user.role not in ("admin", "cmc_lead") and (
        user.role != "project_lead" or project.owner_id != user.id
    ):
        raise HTTPException(403, "项目 Excel 由管理员、CMC 负责人或本项目负责人维护")
    subs = db.query(SubProject).filter_by(project_id=project_id).all()
    query = db.query(Task).filter(Task.sub_project_id.in_([s.id for s in subs])).order_by(Task.id)
    tasks = (query.populate_existing().with_for_update() if lock else query).all()
    if len(tasks) > MAX_ROWS:
        raise HTTPException(422, "项目超过 10000 项任务，请拆分项目后导出；未截断导出数据")
    users = db.query(User).filter(User.id.in_(team_ids(db, project))).all()
    acceptances = (
        db.query(TaskAcceptance).filter(TaskAcceptance.task_id.in_([t.id for t in tasks])).all()
    )
    return project, subs, tasks, users, {a.task_id: a for a in acceptances}


def export_project(db: Session, state) -> bytes:
    project, subs, tasks, users, _ = state
    names = {u.id: u.display_name for u in users}
    sub_names = {s.id: s.name for s in subs}
    wb = Workbook()
    ws = wb.active
    ws.title = "填写说明"
    instructions = [
        "项目计划与执行数据往返：先导出、编辑「项目任务」、上传预览、确认应用。",
        "仅更新已有任务，不新增或删除任务；删除工作表中的行不会删除系统数据。",
        "任务ID、修订号、任务编号、子项目不可修改。列可重排，表头不可改名或删除。",
        "负责人可填团队成员姓名或账号ID；同名时请使用「项目团队」中的账号ID。",
        "日期使用 YYYY-MM-DD；进度填 0–100；工时单位人天，费用单位万元。",
        "实际日期、实际工时、费用与备注可清空；明确填写 0 会保留为 0。",
        "文件不包含协作讨论及交付物；依赖、团队和项目资料表仅供参考，不接受回写。",
        "有任何错误整批不写入；任务已变化时重新导出，避免覆盖他人的工作。",
        "已验收里程碑发生变更会退回待提交验收；导入不能绕过指定验收人。",
        "支持 .xlsx，最大 10 MiB、10000 项任务。公式单元格不支持导入。",
    ]
    for index, value in enumerate(instructions, 1):
        cell = ws.cell(index, 1, value)
        cell.data_type = "s"
    ws.column_dimensions["A"].width = 110
    _write_sheet(
        wb,
        "项目信息",
        ["字段", "值"],
        [
            {"字段": "格式标识", "值": FORMAT},
            {"字段": "项目ID", "值": project.id},
            {"字段": "项目编号", "值": project.code},
            {"字段": "项目名称", "值": project.name},
        ],
    )
    rows = []
    for task in tasks:
        row = {label: json_value(getattr(task, field)) for label, field in IDENTITY.items()}
        row.update({label: json_value(getattr(task, field)) for label, field in FIELDS.items()})
        # ID and name together remain usable when two members have the same name.
        row["负责人"] = f"{names.get(task.owner_id, task.owner_id)} [{task.owner_id}]"
        rows.append(row)
    _write_sheet(wb, SHEET, [*IDENTITY, *FIELDS], rows)
    wb[SHEET].column_dimensions["E"].width = 42
    _write_sheet(
        wb,
        "项目团队",
        ["账号ID", "姓名", "是否启用"],
        [
            {"账号ID": u.id, "姓名": u.display_name, "是否启用": "是" if u.is_active else "否"}
            for u in users
        ],
    )
    _write_sheet(
        wb,
        "子项目参考",
        ["子项目ID", "名称"],
        [{"子项目ID": sid, "名称": name} for sid, name in sub_names.items()],
    )
    ids = [t.id for t in tasks]
    deps = db.query(TaskDependency).filter(TaskDependency.successor_id.in_(ids)).all()
    _write_sheet(
        wb,
        "依赖参考",
        ["前置任务ID", "后续任务ID", "类型", "滞后天数"],
        [
            {
                "前置任务ID": d.predecessor_id,
                "后续任务ID": d.successor_id,
                "类型": d.type,
                "滞后天数": d.lag_days,
            }
            for d in deps
        ],
    )
    output = BytesIO()
    wb.save(output)
    return output.getvalue()


def _parse_value(value, field, users):
    if value is None or value == "":
        if field in REQUIRED:
            raise ValueError("不能为空")
        return None
    if field in DATES:
        if isinstance(value, datetime):
            return value.date()
        if isinstance(value, date):
            return value
        return date.fromisoformat(str(value).strip())
    if field in NUMBERS or field == "progress":
        if isinstance(value, bool):
            raise ValueError("请填写有效数字")
        try:
            number = Decimal(str(value))
        except InvalidOperation:
            raise ValueError("请填写有效数字") from None
        if not number.is_finite():
            raise ValueError("请填写有限数字")
        if field == "progress":
            if number != number.to_integral_value():
                raise ValueError("进度须为整数")
            return int(number)
        if number != number.quantize(Decimal("0.01")):
            raise ValueError("最多保留两位小数")
        return number
    text = str(value) if field in ("name", "notes") else str(value).strip()
    if field in REQUIRED and not text.strip():
        raise ValueError("不能为空")
    if field == "owner_id":
        matches = [u for u in users if text in (u.id, u.display_name, f"{u.display_name} [{u.id}]")]
        if len(matches) != 1:
            raise ValueError("负责人不在团队或姓名重复，请使用项目团队中的账号ID")
        return matches[0].id
    if len(text) > (5000 if field == "notes" else 200):
        raise ValueError("内容过长")
    return text


def preview_project(data: bytes, state):
    project, _, tasks, users, acceptances = state
    tasks_by_id = {t.id: t for t in tasks}
    errors, changes, patches = [], [], []
    invalid_rows = set()

    def error(row, column, message):
        invalid_rows.add(row)
        if len(errors) < MAX_ERRORS:
            errors.append({"row": row, "column": column, "message": message})

    wb = None
    row_count = 0
    try:
        _check_xlsx_archive(data)
        wb = load_workbook(BytesIO(data), read_only=True, data_only=False, keep_links=False)
        for sheet in wb:
            if sheet.title not in ("项目信息", SHEET):
                continue
            if (sheet.max_row or 0) > MAX_ROWS + 1 or (sheet.max_column or 0) > 40:
                raise ValueError("每张工作表最多 10000 行数据、40 列")
        if "项目信息" not in wb.sheetnames or SHEET not in wb.sheetnames:
            raise ValueError("请上传本项目导出的项目工作簿；模板 Excel 不能用于回导")
        metadata = {}
        for row in wb["项目信息"].iter_rows(min_row=2, max_col=2):
            if row[0].data_type == "f" or row[1].data_type == "f":
                raise ValueError("项目信息不能包含公式")
            metadata[row[0].value] = row[1].value
        if metadata.get("格式标识") != FORMAT or metadata.get("项目ID") != project.id:
            raise ValueError("文件格式或项目不匹配，请重新导出当前项目")
        sheet = wb[SHEET]
        headers = [c.value for c in next(sheet.iter_rows(min_row=1, max_row=1, max_col=40))]
        while headers and headers[-1] is None:
            headers.pop()
        if len(headers) != len(set(headers)) or set(headers) != set(IDENTITY) | set(FIELDS):
            raise ValueError("项目任务表头缺失、重复或被修改；允许调整列顺序，请保留原表头")
        seen = set()
        for index, cells in enumerate(
            sheet.iter_rows(min_row=2, max_row=MAX_ROWS + 2, max_col=len(headers)), 2
        ):
            if not any(c.value is not None for c in cells):
                continue
            if index > MAX_ROWS + 1:
                raise ValueError("每张工作表最多 10000 行数据")
            row_count += 1
            row = dict(zip(headers, [c.value for c in cells], strict=True))
            if any(c.data_type == "f" for c in cells):
                error(index, "-", "不支持公式，请粘贴为实际值")
                continue
            task = tasks_by_id.get(str(row.get("任务ID", "")))
            if not task:
                error(index, "任务ID", "任务不存在或不属于本项目；不支持新增任务")
                continue
            if task.id in seen:
                error(index, "任务ID", "同一任务只能出现一行")
                continue
            seen.add(task.id)
            for label, field in IDENTITY.items():
                expected = getattr(task, field)
                if str(row[label]) != str(expected):
                    message = (
                        "任务已变化，请重新导出后修改" if field == "revision" else "身份列不能修改"
                    )
                    error(index, label, message)
            values = {}
            for label, field in FIELDS.items():
                try:
                    values[field] = _parse_value(row[label], field, users)
                except (ValueError, OverflowError, InvalidOperation) as exc:
                    error(index, label, str(exc))
            if index in invalid_rows:
                continue
            try:
                values = TaskUpdate.model_validate(values).model_dump(exclude_unset=True)
                validate_date_patch(task, values)
                owner = next(u for u in users if u.id == values["owner_id"])
                if values["owner_id"] != task.owner_id and not owner.is_active:
                    raise ValueError("不能改派给已停用成员")
                patch = {key: value for key, value in values.items() if getattr(task, key) != value}
                acceptance = acceptances.get(task.id)
                if acceptance and values["status"] == "已验证":
                    if task.status != "已验证" or acceptance.state != "accepted":
                        raise ValueError("此里程碑须由指定验收人验收，不能通过 Excel 标记已验证")
                    if patch:
                        patch["status"] = "已完成"
                if patch:
                    patches.append((task, patch))
                    reverse = {field: label for label, field in FIELDS.items()}
                    changes.append(
                        {
                            "row": index,
                            "task_id": task.id,
                            "task_name": task.name,
                            "changes": [
                                {
                                    "field": reverse[k],
                                    "before": json_value(getattr(task, k)),
                                    "after": json_value(v),
                                }
                                for k, v in patch.items()
                            ],
                            "resubmit_acceptance": bool(
                                acceptance and acceptance.state in ("submitted", "accepted")
                            ),
                        }
                    )
            except ValidationError as exc:
                for item in exc.errors():
                    column = (
                        next(
                            (label for label, field in FIELDS.items() if field == item["loc"][0]),
                            "-",
                        )
                        if item["loc"]
                        else "-"
                    )
                    error(index, column, item["msg"])
            except (ValueError, HTTPException) as exc:
                error(index, "-", str(exc.detail) if isinstance(exc, HTTPException) else str(exc))
        if row_count == 0:
            error(1, "-", "项目任务表没有数据")
    except (ValueError, BadZipFile, KeyError) as exc:
        error(0, "文件", str(exc))
    except Exception:
        error(0, "文件", "无法解析 xlsx 文件，请检查文件格式")
    finally:
        if wb is not None:
            wb.close()
    snapshot = {
        "file": hashlib.sha256(data).hexdigest(),
        "project": project.id,
        "owner": project.owner_id,
        "tasks": [(t.id, t.revision) for t in tasks],
        "team": sorted((u.id, u.display_name, u.is_active) for u in users),
        "acceptance": sorted((a.task_id, a.state, str(a.updated_at)) for a in acceptances.values()),
    }
    fingerprint = hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest()
    result = {
        "project_id": project.id,
        "row_count": row_count,
        "changed_count": len(changes),
        "changes": changes,
        "errors": errors,
        "error_limit": MAX_ERRORS,
        "fingerprint": fingerprint,
        "can_apply": not errors and bool(changes),
    }
    return result, patches
