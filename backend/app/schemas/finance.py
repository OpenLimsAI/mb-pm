"""ProjectFinance schemas。"""

from pydantic import BaseModel, ConfigDict, Field


class ProjectFinanceBase(BaseModel):
    project_id: str
    total_budget: float = 0
    spent: float = 0
    committed: float = 0
    breakdown: dict[str, float] = Field(default_factory=dict)
    fiscal_year: str | None = None
    notes: str | None = None


class ProjectFinanceOut(ProjectFinanceBase):
    model_config = ConfigDict(from_attributes=True)
