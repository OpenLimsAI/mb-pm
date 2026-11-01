"""Bounded, explicit task conversation inputs."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class TaskInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(default="新任务", min_length=1, max_length=200)
    instructions: str = Field(default="", max_length=4000)

    @field_validator("title")
    @classmethod
    def present(cls, value):
        if not value.strip():
            raise ValueError("任务名称不能为空")
        return value.strip()


class TaskCreate(TaskInput):
    id: UUID


class TaskSave(TaskInput):
    revision: int = Field(ge=1, le=2147483646)


class TaskRevision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=1, le=2147483646)


class TaskQuestion(TaskRevision):
    model_config = ConfigDict(extra="forbid", protected_namespaces=())
    request_id: UUID
    data_sources: list[Literal["knowledge"]] = Field(default_factory=list, max_length=1)
    question: str = Field(min_length=1, max_length=12000)
    context: str = Field(default="", max_length=20000)
    model_profile_id: str | None = Field(default=None, min_length=1, max_length=100)

    @field_validator("data_sources")
    @classmethod
    def unique_sources(cls, value):
        return sorted(set(value))

    @field_validator("question")
    @classmethod
    def present(cls, value):
        if not value.strip():
            raise ValueError("请输入任务要求")
        return value.strip()
