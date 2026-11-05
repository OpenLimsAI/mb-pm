"""Bounded inventory and selected-archive deletion; no backup execution or policy input."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator
from pydantic.alias_generators import to_camel

OpaqueId = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
PreviewToken = Annotated[str, Field(min_length=32, max_length=256, pattern=r"^[A-Za-z0-9_-]+$")]
Timestamp = Annotated[str, Field(max_length=80)]
Bytes = Annotated[int, Field(ge=0, strict=True)]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, alias_generator=to_camel)


class DeletePreviewInput(Input):
    archive_ids: list[OpaqueId] = Field(min_length=1, max_length=100)
    catalog_revision: OpaqueId

    @field_validator("archive_ids")
    @classmethod
    def distinct_ids(cls, value):
        if len(set(value)) != len(value):
            raise ValueError("不能重复选择同一份备份")
        return value


class DeletionInput(Input):
    token: PreviewToken
    confirmation: str = Field(pattern=r"^删除 ([1-9][0-9]?|100) 份备份$")
    request_id: UUID


class PublicMetadata(BaseModel):
    # Unexpected diagnostics, commands, paths or secrets are never part of public output.
    model_config = ConfigDict(extra="ignore", populate_by_name=True, alias_generator=to_camel)


class Plan(PublicMetadata):
    status: Literal["active", "disabled", "unknown", "conflict"]
    source: Literal["cron"]
    timezone: str = Field(max_length=80)
    summary: str = Field(max_length=1000)
    retention_summary: str = Field(max_length=1000)
    checked_at: Timestamp | None = None


class Storage(PublicMetadata):
    total_bytes: Bytes
    free_bytes: Bytes
    backup_bytes: Bytes
    archive_bytes: Bytes
    other_bytes: Bytes


class Root(PublicMetadata):
    id: str = Field(min_length=1, max_length=80)
    label: str = Field(max_length=120)
    archive_count: int = Field(ge=0, strict=True)
    size_bytes: Bytes
    disk_bytes: Bytes
    other_bytes: Bytes


class ArchiveContent(PublicMetadata):
    name: str = Field(max_length=120)
    kind: Literal["database", "files", "configuration"]
    detail: str = Field(max_length=1000)


class PreviewItem(PublicMetadata):
    id: OpaqueId
    name: str = Field(min_length=1, max_length=255)
    root_label: str = Field(max_length=120)
    size_bytes: Bytes
    disk_bytes: Bytes


class Archive(PreviewItem):
    created_at: Timestamp | None = None
    status: Literal["verified", "pending", "unreadable", "unknown"]
    contents: list[ArchiveContent] = Field(max_length=100)
    verified_at: Timestamp | None = None
    protected: StrictBool
    protection_reason: str | None = Field(default=None, max_length=1000)


class DeletePreview(PublicMetadata):
    token: PreviewToken
    item_count: int = Field(ge=1, le=100, strict=True)
    size_bytes: Bytes
    disk_bytes: Bytes
    items: list[PreviewItem] = Field(min_length=1, max_length=100)
    expires_at: Timestamp


class Deletion(PublicMetadata):
    id: str = Field(min_length=1, max_length=80)
    actor: str = Field(max_length=255)
    created_at: Timestamp | None = None
    status: Literal["succeeded", "partial", "failed"]
    deleted_count: int = Field(ge=0, le=100, strict=True)
    deleted_bytes: Bytes
    error: str | None = Field(default=None, max_length=2000)


class Snapshot(PublicMetadata):
    connected: Literal[True]
    generated_at: Timestamp | None = None
    catalog_revision: OpaqueId
    plan: Plan
    storage: Storage
    roots: list[Root] = Field(max_length=50)
    archives: list[Archive] = Field(max_length=1000)
    deletions: list[Deletion] = Field(max_length=200)
    alerts: list[Annotated[str, Field(max_length=1000)]] = Field(max_length=100)
