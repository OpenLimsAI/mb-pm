"""Bounded collaboration and note-link payloads."""

from typing import Literal

from pydantic import Field, field_validator

from app.schemas.solution import Input


class MemberInput(Input):
    role: Literal["editor", "commenter", "removed"]


class CommentInput(Input):
    section_id: str = Field(min_length=1, max_length=80)
    quote: str = Field(default="", max_length=12000)
    content: str = Field(min_length=1, max_length=8000)
    parent_id: str | None = Field(default=None, min_length=1, max_length=64)

    @field_validator("content")
    @classmethod
    def nonempty(cls, value):
        if not value.strip():
            raise ValueError("请输入批注内容")
        return value.strip()


class ResolveCommentInput(Input):
    revision: int = Field(ge=1)
    resolved: bool


class PresenceInput(Input):
    section_id: str = Field(min_length=1, max_length=80)


class NoteLinkInput(PresenceInput):
    note_id: str = Field(min_length=1, max_length=64)
    expected_revision: int | None = Field(default=None, ge=1)
