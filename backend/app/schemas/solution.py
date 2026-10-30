"""Bounded payloads; content and evidence are validated again against authorized sources."""

from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Section(Input):
    id: str = Field(min_length=1, max_length=80)
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(default="", max_length=50000)


class FormulaRow(Input):
    id: str = Field(min_length=1, max_length=80)
    material: str = Field(default="", max_length=300)
    purpose: str = Field(default="", max_length=500)
    specification: str = Field(default="", max_length=500)
    amount: str = Field(default="", max_length=100)
    unit: str = Field(default="", max_length=100)
    basis: str = Field(default="", max_length=300)
    range: str = Field(default="", max_length=200)
    rationale: str = Field(default="", max_length=5000)
    evidence_ids: list[str] = Field(default_factory=list, max_length=100)
    verification: Literal["pending", "confirmed"] = "pending"


class Reference(Input):
    id: str = Field(min_length=1, max_length=80)
    source_id: str = Field(min_length=1, max_length=1200)
    title: str = Field(min_length=1, max_length=1000)
    excerpt: str = Field(min_length=1, max_length=12000)
    locator: str = Field(default="", max_length=1200)
    source_version: str = Field(min_length=1, max_length=80)
    section_id: str = Field(min_length=1, max_length=80)


class SolutionInput(Input):
    title: str = Field(min_length=1, max_length=300)
    project_name: str = Field(default="", max_length=200)
    product_name: str = Field(default="", max_length=200)
    sections: list[Section] = Field(default_factory=list, max_length=60)
    formula: list[FormulaRow] = Field(default_factory=list, max_length=200)
    references: list[Reference] = Field(default_factory=list, max_length=300)

    @field_validator("title")
    @classmethod
    def nonempty(cls, value):
        if not value.strip():
            raise ValueError("报告标题不能为空")
        return value.strip()

    @model_validator(mode="after")
    def integrity(self):
        for rows in (self.sections, self.formula, self.references):
            if len({row.id for row in rows}) != len(rows):
                raise ValueError("章节、配方和引用标识不可重复")
        if sum(len(row.content) for row in self.sections) > 200000:
            raise ValueError("报告正文过长，请拆分报告")
        section_ids = {row.id for row in self.sections}
        refs = {row.id for row in self.references}
        if any(ref.section_id not in section_ids for ref in self.references):
            raise ValueError("引用必须关联已有章节")
        if any(set(row.evidence_ids) - refs for row in self.formula):
            raise ValueError("配方依据必须关联已有引用")
        return self


class SolutionRevision(Input):
    revision: int = Field(ge=1)


class SolutionSave(SolutionInput):
    revision: int = Field(ge=1)


class SourceInput(Input):
    title: str = Field(min_length=1, max_length=300)
    kind: Literal["paper", "practice", "note", "solution"]
    authors: str = Field(default="", max_length=500)
    date: str = Field(default="", max_length=40)
    project_name: str = Field(default="", max_length=200)
    tags: list[str] = Field(default_factory=list, max_length=30)
    content: str = Field(min_length=1, max_length=300000)
    locator: str = Field(default="", max_length=500)
    url: str = Field(default="", max_length=2000)

    @field_validator("title", "content")
    @classmethod
    def nonempty(cls, value):
        if not value.strip():
            raise ValueError("标题和正文不能为空")
        return value.strip()

    @field_validator("tags")
    @classmethod
    def bounded_tags(cls, tags):
        if any(len(tag) > 80 for tag in tags):
            raise ValueError("标签过长")
        return tags

    @field_validator("url")
    @classmethod
    def safe_url(cls, value):
        if value:
            parts = urlsplit(value)
            if (
                parts.scheme not in ("http", "https")
                or not parts.hostname
                or parts.username
                or parts.password
            ):
                raise ValueError("来源链接必须是 HTTP/HTTPS 地址")
        return value


class AskInput(Input):
    model_config = ConfigDict(protected_namespaces=("model_validate", "model_dump"))
    model_profile_id: str | None = Field(default=None, min_length=1, max_length=80)
    conversation_id: str | None = Field(
        default=None, min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_-]+$"
    )
    question: str = Field(min_length=1, max_length=4000)
    context: str = Field(default="", max_length=16000)
    source_ids: list[str] = Field(default_factory=list, max_length=100)
    project_name: str = Field(default="", max_length=200)
    section_id: str = Field(min_length=1, max_length=80)

    @field_validator("question")
    @classmethod
    def question_present(cls, value):
        if not value.strip():
            raise ValueError("请输入问题")
        return value.strip()


class PolishInput(Input):
    model_config = ConfigDict(protected_namespaces=("model_validate", "model_dump"))
    model_profile_id: str | None = Field(default=None, min_length=1, max_length=80)
    section_id: str = Field(min_length=1, max_length=80)
    text: str = Field(min_length=1, max_length=5000)
    instruction: str = Field(default="", max_length=1000)

    @field_validator("text")
    @classmethod
    def text_present(cls, value):
        if not value.strip():
            raise ValueError("请选择要润色的文字")
        return value


class ReviewAction(Input):
    action: Literal["submit", "withdraw", "approve", "return", "revise", "archive", "restore"]
    revision: int = Field(ge=1)
    note: str = Field(default="", max_length=8000)
    reviewer_id: str | None = Field(default=None, max_length=255)
    version_id: str | None = Field(default=None, max_length=64)
