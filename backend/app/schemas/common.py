"""通用响应模型 — 分页 / 错误。"""

import hashlib
import json
from collections.abc import Sequence
from typing import Generic, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")


class PageMeta(BaseModel):
    page: int = 1
    page_size: int = 20
    total: int = 0
    snapshot: str | None = None


def list_snapshot(ids: Sequence[str]) -> str:
    return hashlib.sha256(json.dumps(ids, separators=(",", ":")).encode()).hexdigest()


class Page(BaseModel, Generic[T]):
    items: list[T]
    meta: PageMeta


class APIError(BaseModel):
    detail: str = Field(..., description="错误描述")
    code: str | None = None
