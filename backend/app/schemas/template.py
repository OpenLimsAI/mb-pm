"""Template / TemplateVersion schemas。"""

from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.business_values import MAX_EFFORT


def validate_template_structure(root: dict[str, Any]) -> dict[str, Any]:
    """Bound the template tree and numeric inputs for both JSON and Excel writes."""
    count = 0

    def walk(node, depth):
        nonlocal count
        count += 1
        if not isinstance(node, dict) or depth > 2 or count > 10000:
            raise ValueError("模板只支持项目、子项目、任务三级且总节点不超过 10000")
        for key, maximum in (("defaultDuration", 36500), ("defaultEffort", MAX_EFFORT)):
            value = node.get(key)
            if value is None:
                continue
            try:
                number = Decimal(str(value))
                if not number.is_finite() or not 0 <= number <= maximum:
                    raise ValueError()
                if key == "defaultDuration" and number != number.to_integral_value():
                    raise ValueError()
            except (InvalidOperation, ValueError):
                raise ValueError(f"{key} 必须为 0 到 {maximum} 之间的有效数值") from None
        children = node.get("children") or []
        if not isinstance(children, list):
            raise ValueError("模板子节点必须是列表")
        for child in children:
            walk(child, depth + 1)

    walk(root, 0)
    return root


# ============= TemplateVersion =============


class TemplateVersionBase(BaseModel):
    version_number: str = Field(..., max_length=20)
    structure_json: dict[str, Any]
    change_summary: str | None = None
    change_source: Literal["visual_edit", "excel_import"] = "visual_edit"


class TemplateVersionCreate(TemplateVersionBase):
    """追加新版本时用 — 后端写入 modified_by / modified_at / is_current。"""

    @field_validator("structure_json")
    @classmethod
    def valid_structure(cls, value):
        return validate_template_structure(value)


class TemplateVersionOut(TemplateVersionBase):
    model_config = ConfigDict(from_attributes=True)
    id: str
    template_id: str
    modified_by: str | None
    modified_at: datetime
    is_current: bool


# ============= Template =============


class TemplateBase(BaseModel):
    name: str = Field(..., max_length=120)
    product_type: str
    description: str | None = None
    is_active: bool = True


class TemplateCreate(TemplateBase):
    """创建 — 必须带初始结构（作为 V1.0）。"""

    initial_structure: dict[str, Any] = Field(..., description="V1.0 的 TemplateNode 树根")
    id: str | None = None

    @field_validator("initial_structure")
    @classmethod
    def valid_structure(cls, value):
        return validate_template_structure(value)


class TemplateUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    is_active: bool | None = None


class TemplateOut(TemplateBase):
    model_config = ConfigDict(from_attributes=True)
    id: str
    current_version: str
    created_by: str | None
    created_at: datetime
    updated_at: datetime
    versions: list[TemplateVersionOut] = Field(default_factory=list)


# ============= Excel 导入校验 =============


class ImportError(BaseModel):
    sheet: str
    row: int | str
    col: str
    level: Literal["format", "reference", "logic", "business"]
    message: str


class ImportResult(BaseModel):
    """Excel 导入结果。

    success=True 时 template_id / version_id 表示新创建/覆盖的记录。
    success=False 时 errors 列出所有问题。
    """

    success: bool
    template_id: str | None = None
    version_id: str | None = None
    errors: list[ImportError] = Field(default_factory=list)
    summary: dict[str, int] = Field(
        default_factory=dict, description="如 {'subProjects': 5, 'tasks': 16, 'milestones': 4}"
    )
