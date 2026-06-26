"""模板 Excel 导出 / 导入解析（FR-TX-001 ~ FR-TX-005）。

Sheet 约定（与前端 mock 校验逻辑一致）：
    1. 填写说明        — 字段说明（导入时跳过）
    2. 子项目清单      — 列：子项目名称 / 阶段 / 模块 / 默认负责角色 / 备注
    3. 任务清单        — 列：任务编号 / 任务名称 / 子项目名称 / 阶段 / 模块 /
                              默认工期(天) / 默认工时(d) / 是否里程碑 / 默认负责角色 / 备注
    4. 任务依赖        — 列：后继任务编号 / 前驱任务编号 / 类型 / 滞后天数
    5. 数据字典        — 阶段 / 模块 / 角色（仅供参考，导入时跳过）

导入校验规则：
    format    — 数据类型 / 必填 / 枚举值
    reference — 任务依赖中引用的 taskCode 必须存在；任务的子项目名称必须在子项目清单中
    logic     — 任务依赖不得形成环
    business  — 三级 WBS 强约束（子项目下只能有任务）
"""

from io import BytesIO
from typing import Any

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from app.schemas.template import ImportError as ImportErrorRow

# 字典（与 mock/dictionaries.ts 同步）
STAGES = ["临床前", "IND", "Ph1/2", "Ph3", "BLA", "商业化", "上市后"]
MODULES = ["细胞株", "USP", "DSP", "DP", "分析方法", "稳定性", "工艺验证", "CTD", "其他"]
ROLES = ["上游", "下游", "制剂", "分析", "稳定性", "工艺验证", "CMC综合"]
DEP_TYPES = ["FS", "SS", "FF", "SF"]


HEADER_FILL = PatternFill(start_color="2563EB", end_color="2563EB", fill_type="solid")
HEADER_FONT = Font(color="FFFFFF", bold=True, name="Microsoft YaHei")


# ============= 导出 =============

def template_structure_to_rows(root: dict[str, Any]) -> tuple[list[dict], list[dict], list[dict]]:
    """把 TemplateNode 树转成三张表 (子项目, 任务, 依赖)。"""
    sub_rows: list[dict] = []
    task_rows: list[dict] = []
    dep_rows: list[dict] = []

    children = root.get("children") or []
    for sub in children:
        sub_rows.append({
            "子项目名称": sub.get("name"),
            "阶段": sub.get("stage"),
            "模块": sub.get("module"),
            "默认负责角色": sub.get("defaultRole"),
            "备注": sub.get("notes"),
        })
        for task in sub.get("children") or []:
            task_rows.append({
                "任务编号": task.get("taskCode"),
                "任务名称": task.get("name"),
                "子项目名称": sub.get("name"),
                "阶段": task.get("stage") or sub.get("stage"),
                "模块": task.get("module") or sub.get("module"),
                "默认工期(天)": task.get("defaultDuration") or 0,
                "默认工时(d)": task.get("defaultEffort") or 0,
                "是否里程碑": "是" if task.get("isMilestone") else "否",
                "默认负责角色": task.get("defaultRole"),
                "备注": task.get("notes"),
            })
            for pred in task.get("predecessors") or []:
                dep_rows.append({
                    "后继任务编号": task.get("taskCode"),
                    "前驱任务编号": pred.get("taskCode"),
                    "类型": pred.get("type") or "FS",
                    "滞后天数": pred.get("lagDays") or 0,
                })
    return sub_rows, task_rows, dep_rows


def _write_sheet(wb: Workbook, name: str, columns: list[str], rows: list[dict]) -> None:
    ws = wb.create_sheet(name)
    for col_idx, col_name in enumerate(columns, start=1):
        cell = ws.cell(row=1, column=col_idx, value=col_name)
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.alignment = Alignment(horizontal="center", vertical="center")
        ws.column_dimensions[get_column_letter(col_idx)].width = 16
    for row_idx, row in enumerate(rows, start=2):
        for col_idx, col_name in enumerate(columns, start=1):
            ws.cell(row=row_idx, column=col_idx, value=row.get(col_name))
    ws.freeze_panes = "A2"


def export_template_to_xlsx(template_name: str, version_number: str, structure_json: dict) -> bytes:
    """导出一个版本到 xlsx 字节流。"""
    sub_rows, task_rows, dep_rows = template_structure_to_rows(structure_json)

    wb = Workbook()
    # 默认 sheet 改成"填写说明"
    ws = wb.active
    ws.title = "填写说明"
    ws["A1"] = f"模板：{template_name} ({version_number})"
    ws["A1"].font = Font(bold=True, size=14, name="Microsoft YaHei")
    ws["A3"] = "本文件由 CMC-PMS 后端导出。"
    ws["A4"] = "Sheet 含义：子项目清单 / 任务清单 / 任务依赖 / 数据字典"
    ws.column_dimensions["A"].width = 60

    _write_sheet(wb, "子项目清单",
                 ["子项目名称", "阶段", "模块", "默认负责角色", "备注"], sub_rows)
    _write_sheet(wb, "任务清单",
                 ["任务编号", "任务名称", "子项目名称", "阶段", "模块",
                  "默认工期(天)", "默认工时(d)", "是否里程碑", "默认负责角色", "备注"],
                 task_rows)
    _write_sheet(wb, "任务依赖",
                 ["后继任务编号", "前驱任务编号", "类型", "滞后天数"], dep_rows)

    # 数据字典 sheet（参考用）
    dict_ws = wb.create_sheet("数据字典")
    dict_ws["A1"] = "阶段"; dict_ws["B1"] = "模块"; dict_ws["C1"] = "角色"; dict_ws["D1"] = "依赖类型"
    for c in ("A1", "B1", "C1", "D1"):
        dict_ws[c].fill = HEADER_FILL
        dict_ws[c].font = HEADER_FONT
    for i, v in enumerate(STAGES, start=2): dict_ws.cell(row=i, column=1, value=v)
    for i, v in enumerate(MODULES, start=2): dict_ws.cell(row=i, column=2, value=v)
    for i, v in enumerate(ROLES, start=2): dict_ws.cell(row=i, column=3, value=v)
    for i, v in enumerate(DEP_TYPES, start=2): dict_ws.cell(row=i, column=4, value=v)

    out = BytesIO()
    wb.save(out)
    return out.getvalue()


def generate_blank_template_xlsx() -> bytes:
    """生成一个空白的导入模板（仅含表头 + 字典 + 示例 1 行）。"""
    wb = Workbook()
    ws = wb.active
    ws.title = "填写说明"
    ws["A1"] = "CMC-PMS 模板导入标准格式 V1.0"
    ws["A1"].font = Font(bold=True, size=14, name="Microsoft YaHei")
    instructions = [
        "",
        "本文件用于批量导入模板结构。请按以下顺序填写：",
        "  1. 子项目清单：先列出 Lv2 节点（按阶段+模块切分）",
        "  2. 任务清单：每个任务必须指定其所属子项目名称",
        "  3. 任务依赖：可选，描述任务间的 FS/SS/FF/SF 关系",
        "",
        "注意：",
        "  - 「任务编号」必须全局唯一",
        "  - 「子项目名称」必须与子项目清单完全一致（关联 Lv2）",
        "  - 「阶段」/「模块」/「角色」必须使用数据字典中的合法值",
        "  - 「是否里程碑」填「是」/「否」（不区分大小写）",
        "  - 数据字典 sheet 仅供参考，不参与导入",
    ]
    for i, line in enumerate(instructions, start=3):
        ws.cell(row=i, column=1, value=line)
    ws.column_dimensions["A"].width = 80

    _write_sheet(wb, "子项目清单",
                 ["子项目名称", "阶段", "模块", "默认负责角色", "备注"],
                 [{"子项目名称": "（示例）IND-USP 上游开发", "阶段": "IND", "模块": "USP", "默认负责角色": "上游"}])
    _write_sheet(wb, "任务清单",
                 ["任务编号", "任务名称", "子项目名称", "阶段", "模块",
                  "默认工期(天)", "默认工时(d)", "是否里程碑", "默认负责角色", "备注"],
                 [{"任务编号": "T001", "任务名称": "（示例）培养基筛选", "子项目名称": "（示例）IND-USP 上游开发",
                   "阶段": "IND", "模块": "USP", "默认工期(天)": 30, "默认工时(d)": 20,
                   "是否里程碑": "否", "默认负责角色": "上游"}])
    _write_sheet(wb, "任务依赖",
                 ["后继任务编号", "前驱任务编号", "类型", "滞后天数"],
                 [{"后继任务编号": "T002", "前驱任务编号": "T001", "类型": "FS", "滞后天数": 0}])

    dict_ws = wb.create_sheet("数据字典")
    dict_ws["A1"] = "阶段"; dict_ws["B1"] = "模块"; dict_ws["C1"] = "角色"; dict_ws["D1"] = "依赖类型"
    for c in ("A1", "B1", "C1", "D1"):
        dict_ws[c].fill = HEADER_FILL
        dict_ws[c].font = HEADER_FONT
    for i, v in enumerate(STAGES, start=2): dict_ws.cell(row=i, column=1, value=v)
    for i, v in enumerate(MODULES, start=2): dict_ws.cell(row=i, column=2, value=v)
    for i, v in enumerate(ROLES, start=2): dict_ws.cell(row=i, column=3, value=v)
    for i, v in enumerate(DEP_TYPES, start=2): dict_ws.cell(row=i, column=4, value=v)

    out = BytesIO()
    wb.save(out)
    return out.getvalue()


# ============= 导入 + 校验 =============

def parse_excel(file_bytes: bytes) -> tuple[dict[str, Any] | None, list[ImportErrorRow]]:
    """解析 xlsx 字节流。

    返回 (structure, errors)：
      - 校验失败时 structure=None，errors 列出所有问题
      - 校验成功时 structure 是可直接持久化的 TemplateNode 树根
    """
    errors: list[ImportErrorRow] = []
    try:
        wb = load_workbook(BytesIO(file_bytes), data_only=True)
    except Exception as e:
        return None, [ImportErrorRow(sheet="-", row="-", col="-", level="format",
                                     message=f"无法解析 xlsx 文件: {e}")]

    sheet_names = set(wb.sheetnames)
    required = {"子项目清单", "任务清单"}
    missing = required - sheet_names
    if missing:
        return None, [ImportErrorRow(sheet=", ".join(missing), row="-", col="-", level="format",
                                     message=f"缺少必需的 sheet：{', '.join(missing)}")]

    # —— Sheet 1: 子项目清单 —— #
    sub_ws = wb["子项目清单"]
    sub_headers = [c.value for c in sub_ws[1]]
    sub_required = ["子项目名称", "阶段", "模块"]
    for h in sub_required:
        if h not in sub_headers:
            errors.append(ImportErrorRow(sheet="子项目清单", row=1, col=h, level="format",
                                         message=f"缺少必需列「{h}」"))

    sub_idx = {h: sub_headers.index(h) if h in sub_headers else -1 for h in sub_headers if h}
    sub_rows_dict: dict[str, dict] = {}
    for row_num, row in enumerate(sub_ws.iter_rows(min_row=2, values_only=True), start=2):
        if row is None or all(v is None or str(v).strip() == "" for v in row):
            continue
        name = str(row[sub_idx["子项目名称"]] or "").strip() if sub_idx.get("子项目名称", -1) >= 0 else ""
        stage = str(row[sub_idx["阶段"]] or "").strip() if sub_idx.get("阶段", -1) >= 0 else ""
        module = str(row[sub_idx["模块"]] or "").strip() if sub_idx.get("模块", -1) >= 0 else ""

        if not name:
            errors.append(ImportErrorRow(sheet="子项目清单", row=row_num, col="子项目名称",
                                         level="format", message="必填字段不能为空"))
            continue
        if name in sub_rows_dict:
            errors.append(ImportErrorRow(sheet="子项目清单", row=row_num, col="子项目名称",
                                         level="business", message=f"子项目名称 {name!r} 重复"))
            continue
        if stage and stage not in STAGES:
            errors.append(ImportErrorRow(sheet="子项目清单", row=row_num, col="阶段",
                                         level="format",
                                         message=f"{stage!r} 不在数据字典中（合法值：{'/'.join(STAGES)}）"))
        if module and module not in MODULES:
            errors.append(ImportErrorRow(sheet="子项目清单", row=row_num, col="模块",
                                         level="format",
                                         message=f"{module!r} 不在数据字典中（合法值：{'/'.join(MODULES)}）"))

        role = str(row[sub_idx["默认负责角色"]] or "").strip() if sub_idx.get("默认负责角色", -1) >= 0 else ""
        notes = str(row[sub_idx.get("备注", -1)] or "").strip() if sub_idx.get("备注", -1) >= 0 else ""
        sub_rows_dict[name] = {
            "id": f"sp-{len(sub_rows_dict)+1}",
            "name": name, "stage": stage, "module": module,
            "defaultRole": role or None,
            "notes": notes or None,
            "children": [],
        }

    # —— Sheet 2: 任务清单 —— #
    task_ws = wb["任务清单"]
    task_headers = [c.value for c in task_ws[1]]
    task_required = ["任务编号", "任务名称", "子项目名称"]
    for h in task_required:
        if h not in task_headers:
            errors.append(ImportErrorRow(sheet="任务清单", row=1, col=h, level="format",
                                         message=f"缺少必需列「{h}」"))

    t_idx = {h: task_headers.index(h) if h in task_headers else -1 for h in task_headers if h}
    task_codes: dict[str, dict] = {}
    for row_num, row in enumerate(task_ws.iter_rows(min_row=2, values_only=True), start=2):
        if row is None or all(v is None or str(v).strip() == "" for v in row):
            continue
        code = str(row[t_idx["任务编号"]] or "").strip() if t_idx.get("任务编号", -1) >= 0 else ""
        name = str(row[t_idx["任务名称"]] or "").strip() if t_idx.get("任务名称", -1) >= 0 else ""
        sub_name = str(row[t_idx["子项目名称"]] or "").strip() if t_idx.get("子项目名称", -1) >= 0 else ""

        if not code:
            errors.append(ImportErrorRow(sheet="任务清单", row=row_num, col="任务编号",
                                         level="format", message="必填字段不能为空"))
            continue
        if code in task_codes:
            errors.append(ImportErrorRow(sheet="任务清单", row=row_num, col="任务编号",
                                         level="business", message=f"任务编号 {code!r} 重复"))
            continue
        if not name:
            errors.append(ImportErrorRow(sheet="任务清单", row=row_num, col="任务名称",
                                         level="format", message="必填字段不能为空"))
            continue
        if not sub_name or sub_name not in sub_rows_dict:
            errors.append(ImportErrorRow(sheet="任务清单", row=row_num, col="子项目名称",
                                         level="reference",
                                         message=f"子项目 {sub_name!r} 在子项目清单中不存在"))
            continue

        # 类型校验
        def _opt_int(col: str) -> int | None:
            idx = t_idx.get(col, -1)
            if idx < 0: return None
            v = row[idx]
            if v is None or str(v).strip() == "": return None
            try:
                return int(v)
            except (ValueError, TypeError):
                errors.append(ImportErrorRow(sheet="任务清单", row=row_num, col=col,
                                             level="format",
                                             message=f"{v!r} 不是有效数字"))
                return None

        duration = _opt_int("默认工期(天)") or 0
        effort = _opt_int("默认工时(d)") or 0

        is_ms_raw = str(row[t_idx.get("是否里程碑", -1)] or "").strip() if t_idx.get("是否里程碑", -1) >= 0 else ""
        is_milestone = is_ms_raw.lower() in ("是", "true", "yes", "y", "1")

        stage = str(row[t_idx.get("阶段", -1)] or "").strip() if t_idx.get("阶段", -1) >= 0 else ""
        module = str(row[t_idx.get("模块", -1)] or "").strip() if t_idx.get("模块", -1) >= 0 else ""
        if stage and stage not in STAGES:
            errors.append(ImportErrorRow(sheet="任务清单", row=row_num, col="阶段",
                                         level="format", message=f"{stage!r} 不在数据字典中"))
        if module and module not in MODULES:
            errors.append(ImportErrorRow(sheet="任务清单", row=row_num, col="模块",
                                         level="format", message=f"{module!r} 不在数据字典中"))

        role = str(row[t_idx.get("默认负责角色", -1)] or "").strip() if t_idx.get("默认负责角色", -1) >= 0 else ""
        notes = str(row[t_idx.get("备注", -1)] or "").strip() if t_idx.get("备注", -1) >= 0 else ""

        task_node = {
            "id": f"tk-{code}",
            "taskCode": code, "name": name,
            "stage": stage or None, "module": module or None,
            "defaultDuration": duration, "defaultEffort": effort,
            "isMilestone": is_milestone,
            "defaultRole": role or None,
            "notes": notes or None,
            "predecessors": [],
        }
        task_codes[code] = task_node
        sub_rows_dict[sub_name]["children"].append(task_node)

    # —— Sheet 3: 任务依赖（可选）—— #
    if "任务依赖" in sheet_names:
        dep_ws = wb["任务依赖"]
        dep_headers = [c.value for c in dep_ws[1]]
        d_idx = {h: dep_headers.index(h) if h in dep_headers else -1 for h in dep_headers if h}
        for row_num, row in enumerate(dep_ws.iter_rows(min_row=2, values_only=True), start=2):
            if row is None or all(v is None or str(v).strip() == "" for v in row):
                continue
            succ = str(row[d_idx.get("后继任务编号", -1)] or "").strip() if d_idx.get("后继任务编号", -1) >= 0 else ""
            pred = str(row[d_idx.get("前驱任务编号", -1)] or "").strip() if d_idx.get("前驱任务编号", -1) >= 0 else ""
            dep_type = str(row[d_idx.get("类型", -1)] or "FS").strip() if d_idx.get("类型", -1) >= 0 else "FS"
            try:
                lag = int(row[d_idx.get("滞后天数", -1)] or 0) if d_idx.get("滞后天数", -1) >= 0 else 0
            except (ValueError, TypeError):
                lag = 0
                errors.append(ImportErrorRow(sheet="任务依赖", row=row_num, col="滞后天数",
                                             level="format", message="滞后天数必须是整数"))

            if not succ or succ not in task_codes:
                errors.append(ImportErrorRow(sheet="任务依赖", row=row_num, col="后继任务编号",
                                             level="reference",
                                             message=f"任务编号 {succ!r} 不存在"))
                continue
            if not pred or pred not in task_codes:
                errors.append(ImportErrorRow(sheet="任务依赖", row=row_num, col="前驱任务编号",
                                             level="reference",
                                             message=f"任务编号 {pred!r} 不存在"))
                continue
            if dep_type not in DEP_TYPES:
                errors.append(ImportErrorRow(sheet="任务依赖", row=row_num, col="类型",
                                             level="format",
                                             message=f"{dep_type!r} 不在数据字典中（合法值：FS/SS/FF/SF）"))
                continue
            task_codes[succ]["predecessors"].append({
                "taskCode": pred, "type": dep_type, "lagDays": lag,
            })

    # —— 循环依赖检测（DFS）—— #
    def _has_cycle() -> str | None:
        """如有环，返回环路径字符串。"""
        WHITE, GRAY, BLACK = 0, 1, 2
        color: dict[str, int] = {c: WHITE for c in task_codes}
        stack: list[str] = []

        def dfs(u: str) -> str | None:
            color[u] = GRAY
            stack.append(u)
            for pre in task_codes[u].get("predecessors") or []:
                v = pre["taskCode"]
                if color.get(v) == GRAY:
                    # 找到环
                    return " → ".join(stack[stack.index(v):] + [v])
                if color.get(v) == WHITE:
                    res = dfs(v)
                    if res:
                        return res
            stack.pop()
            color[u] = BLACK
            return None

        for c in task_codes:
            if color[c] == WHITE:
                cycle = dfs(c)
                if cycle:
                    return cycle
        return None

    cycle = _has_cycle()
    if cycle:
        errors.append(ImportErrorRow(sheet="任务依赖", row="-", col="-",
                                     level="logic",
                                     message=f"检测到循环依赖：{cycle}"))

    if errors:
        return None, errors

    # 组装最终树
    structure = {
        "id": "root",
        "name": "导入根节点",
        "children": list(sub_rows_dict.values()),
    }
    return structure, []


def count_nodes(structure: dict) -> dict[str, int]:
    """统计 子项目数 / 任务数 / 里程碑数。"""
    subs = structure.get("children") or []
    tasks = 0
    milestones = 0
    for s in subs:
        for t in s.get("children") or []:
            tasks += 1
            if t.get("isMilestone"):
                milestones += 1
    return {"subProjects": len(subs), "tasks": tasks, "milestones": milestones}
