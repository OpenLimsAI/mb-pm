"""Narrow, structured inputs for an Agent to propose project changes."""

from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, model_validator

from app.schemas.ai import AnalysisInput

Identifier = Annotated[str, Field(min_length=1, max_length=64)]
RequestID = Annotated[str, Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9._:-]+$")]
Digest = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]


class AgentInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class SchedulePreview(AgentInput):
    task_id: Identifier
    new_start: date | None = None
    new_end: date | None = None
    delay_workdays: int | None = Field(default=None, strict=True, ge=1, le=365)
    locked_ids: list[Identifier] = Field(default_factory=list, max_length=200)

    @model_validator(mode="after")
    def date_or_delay(self):
        if self.delay_workdays is None:
            if not self.new_start or not self.new_end or self.new_end < self.new_start:
                raise ValueError("请填写有效的计划起止日期，或指定延期工作日")
        elif self.new_start or self.new_end:
            raise ValueError("计划日期与延期工作日只需提供一种")
        return self


class ScheduleChange(SchedulePreview):
    kind: Literal["schedule"]
    fingerprint: Digest | None = None


class CreateTask(AgentInput):
    kind: Literal["create_task"]
    sub_project_id: Identifier
    name: str = Field(min_length=1, max_length=200)
    owner_id: Identifier
    planned_start: date
    planned_end: date
    notes: str = Field(default="", max_length=5000)

    @model_validator(mode="after")
    def ordered_dates(self):
        if self.planned_end < self.planned_start:
            raise ValueError("计划结束不能早于开始")
        return self


class TaskChange(AgentInput):
    task_id: Identifier
    expected_revision: int = Field(strict=True, ge=1)


class UpdateProgress(TaskChange):
    kind: Literal["update_progress"]
    progress: int = Field(strict=True, ge=0, le=100)
    progress_note: str = Field(default="", max_length=5000)


class ReassignTask(TaskChange):
    kind: Literal["reassign_task"]
    owner_id: Identifier


class RegisterRisk(AgentInput):
    kind: Literal["register_risk"]
    title: str = Field(min_length=1, max_length=200)
    owner_id: Identifier
    due_date: date
    severity: Literal["high", "medium", "low"] = "medium"
    mitigation: str = Field(default="", max_length=5000)


class AttachDeliverable(TaskChange):
    kind: Literal["attach_deliverable"]
    title: str = Field(min_length=1, max_length=200)
    url: str = Field(min_length=1, max_length=2000)
    notes: str = Field(default="", max_length=5000)


class SubmitAcceptance(TaskChange):
    kind: Literal["submit_acceptance"]
    expected_acceptance_updated_at: datetime
    deliverable_ids: list[Identifier] = Field(min_length=1, max_length=100)


Action = Annotated[
    ScheduleChange
    | CreateTask
    | UpdateProgress
    | ReassignTask
    | RegisterRisk
    | AttachDeliverable
    | SubmitAcceptance,
    Field(discriminator="kind"),
]


class Propose(AgentInput):
    request_id: RequestID
    reason: str = Field(min_length=1, max_length=2000)
    action: Action


class RetryProposal(AgentInput):
    request_id: RequestID


class ConfirmProposal(AgentInput):
    review_key: Digest


def explicit_model_processing(value):
    if value is not True:
        raise ValueError("必须明确授权将项目分析快照交给企业配置的模型处理")
    return value


ModelConsent = Annotated[Literal[True], BeforeValidator(explicit_model_processing)]


class StartAnalysis(AnalysisInput, AgentInput):
    request_id: RequestID
    allow_model_processing: ModelConsent


class RetryAnalysis(RetryProposal):
    allow_model_processing: ModelConsent
