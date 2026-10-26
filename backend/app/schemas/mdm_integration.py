"""Explicit execution fields; no generated defaults for business input."""

from datetime import date
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

ProductType = Literal["单抗", "多抗", "其他"]
Stage = Literal["临床前", "IND", "Ph1/2", "Ph3", "BLA", "商业化", "上市后"]
PRODUCT_TYPES = ["单抗", "多抗", "其他"]
STAGES = ["临床前", "IND", "Ph1/2", "Ph3", "BLA", "商业化", "上市后"]


class MDMExecutionProject(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    code: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=1, max_length=200)
    product_type: ProductType
    current_stage: Stage
    target_stage: Stage
    owner_id: str = Field(min_length=1, max_length=64)
    planned_start: date
    planned_end: date
    description: str | None = Field(default=None, max_length=4000)

    @model_validator(mode="after")
    def valid_dates(self):
        if self.planned_end < self.planned_start:
            raise ValueError("计划结束不能早于计划开始")
        return self


class MDMProjectCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    request_id: UUID
    source_id: str = Field(
        default="mdm", min_length=1, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]*$"
    )
    source_project_id: str = Field(min_length=1, max_length=64, pattern=r"^[1-9][0-9]*$")
    project: MDMExecutionProject
