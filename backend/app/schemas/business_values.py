"""Business invariants shared by individual and bulk write boundaries."""

from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, model_validator

TaskStatus = Literal["未开始", "进行中", "阻塞", "延迟", "已完成", "已验证"]
ProjectStatus = Literal["活跃", "暂停", "已完成", "已归档"]
Priority = Literal["高", "中", "低"]
Health = Literal["green", "yellow", "red"]
MAX_COST = 99_999_999
MAX_EFFORT = Decimal("9999.99")  # NUMERIC(6,2)


def validate_dates(values):
    for prefix, label in (("planned", "计划"), ("actual", "实际")):
        start, end = values.get(f"{prefix}_start"), values.get(f"{prefix}_end")
        if start is not None and end is not None and end < start:
            raise ValueError(f"{label}结束日期不能早于{label}开始日期")


class DatedInput(BaseModel):
    @model_validator(mode="after")
    def dates_ordered(self):
        validate_dates(self.model_dump())
        return self


def validate_date_patch(row, changes):
    """Check the resulting record, including an unchanged counterpart date."""
    from fastapi import HTTPException

    values = {
        key: changes.get(key, getattr(row, key, None))
        for key in ("planned_start", "planned_end", "actual_start", "actual_end")
    }
    try:
        validate_dates(values)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


def reject_null_fields(model, names):
    if any(name in model.model_fields_set and getattr(model, name) is None for name in names):
        raise ValueError("必填业务字段不能设为空值")
    return model
