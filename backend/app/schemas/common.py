"""通用响应模型 — 分页 / 错误。"""

from typing import Generic, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")


class PageMeta(BaseModel):
    page: int = 1
    page_size: int = 20
    total: int = 0


class Page(BaseModel, Generic[T]):
    items: list[T]
    meta: PageMeta


class APIError(BaseModel):
    detail: str = Field(..., description="错误描述")
    code: str | None = None
