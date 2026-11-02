"""ProjectFinance schemas。金额单位万元。"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

FINANCE_CATEGORIES = ("人力", "设备", "原材料", "外部服务", "其他")
Category = Literal["人力", "设备", "原材料", "外部服务", "其他"]
MAX_AMOUNT = 99_999_999


class ProjectFinanceBase(BaseModel):
    project_id: str
    total_budget: float = Field(default=0, ge=0, le=MAX_AMOUNT, allow_inf_nan=False)
    spent: float = Field(default=0, ge=0, allow_inf_nan=False)
    committed: float = Field(default=0, ge=0, le=MAX_AMOUNT, allow_inf_nan=False)
    breakdown: dict[str, float] = Field(default_factory=dict)
    fiscal_year: str | None = None
    notes: str | None = None

    @field_validator("breakdown")
    @classmethod
    def valid_breakdown(cls, value):
        if any(
            key not in FINANCE_CATEGORIES or not 0 <= amount <= MAX_AMOUNT
            for key, amount in value.items()
        ):
            raise ValueError("成本结构类别或金额无效")
        return value


class ProjectFinanceOut(ProjectFinanceBase):
    """spent = 任务实际花费合计（实时汇总）；task_budget = 任务预算合计。"""

    model_config = ConfigDict(from_attributes=True)
    task_budget: float = 0


class ProjectFinanceUpdate(BaseModel):
    """管理员 / CMC 负责人维护的项目预算。已花费由任务实际花费自动汇总，不接受手工填写。"""

    model_config = ConfigDict(extra="forbid")

    total_budget: float = Field(ge=0, le=MAX_AMOUNT)
    committed: float = Field(default=0, ge=0, le=MAX_AMOUNT)
    breakdown: dict[Category, float] = Field(default_factory=dict)
    fiscal_year: str | None = Field(default=None, max_length=20)
    notes: str | None = Field(default=None, max_length=200)

    @field_validator("total_budget", "committed")
    @classmethod
    def _amount(cls, value: float) -> float:
        return round(value, 2)

    @field_validator("breakdown")
    @classmethod
    def _breakdown(cls, value: dict[str, float]) -> dict[str, float]:
        if any(not 0 <= amount <= MAX_AMOUNT for amount in value.values()):
            raise ValueError(f"成本结构金额需在 0–{MAX_AMOUNT:,} 万元之间")
        # 始终带齐全部类别，缺省记 0
        return {c: round(float(value.get(c, 0)), 2) for c in FINANCE_CATEGORIES}

    @field_validator("fiscal_year", "notes")
    @classmethod
    def _text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError("不能包含换行等控制字符")
        return value or None
