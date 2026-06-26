"""ProjectBaseline schemas。"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class BaselineCreate(BaseModel):
    project_id: str
    label: str = Field(..., max_length=100)
    reason: str | None = None


class BaselineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    project_id: str
    label: str
    reason: str | None = None
    snapshot: dict
    created_by: str | None = None
    created_at: datetime
