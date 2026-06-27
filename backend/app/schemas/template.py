"""Template / TemplateVersion schemas。"""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


# ============= TemplateVersion =============


class TemplateVersionBase(BaseModel):
    version_number: str = Field(..., max_length=20)
    structure_json: dict[str, Any]
    change_summary: str | None = None
    change_source: Literal["visual_edit", "excel_import"] = "visual_edit"


class TemplateVersionCreate(TemplateVersionBase):
    """追加新版本时用 — 后端写入 modified_by / modified_at / is_current。"""


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
