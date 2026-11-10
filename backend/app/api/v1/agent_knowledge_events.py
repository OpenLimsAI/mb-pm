"""Read sources and resume project event subscriptions as the delegated user."""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel

from app.api.v1.agent_projects import DB, AgentUser, IDPath
from app.services import agent_events, agent_knowledge

router = APIRouter(prefix="/agent", tags=["agent"])


def knowledge_subject(request: Request, _user: AgentUser) -> str:
    subject = getattr(request.state, "agent_subject", None)
    agent_knowledge.check_access(subject)
    return subject


KnowledgeSubject = Annotated[str, Depends(knowledge_subject)]


class KnowledgeSource(BaseModel):
    source_id: str
    title: str
    version: str | None
    url: str | None
    source_url: str | None
    document_type: str | None
    applicability: list[str]
    updated_at: str | None
    excerpt: str | None


class KnowledgeSearch(BaseModel):
    items: list[KnowledgeSource]
    next_offset: int | None
    incomplete: bool


class KnowledgeRead(BaseModel):
    source: KnowledgeSource
    text: str
    offset: int
    next_offset: int | None
    total_characters: int
    position_unit: str


class ProjectEvent(BaseModel):
    id: str
    kind: agent_events.EventKind
    task_id: str
    project_id: str
    occurred_at: datetime
    url: str
    changes: dict[str, dict[str, str | int | bool | None]]
    summary: str


class ProjectChanges(BaseModel):
    items: list[ProjectEvent]
    next_cursor: str
    has_more: bool


@router.get("/knowledge/search", response_model=KnowledgeSearch)
def search_knowledge(
    subject: KnowledgeSubject,
    q: Annotated[str, Query(min_length=1, max_length=500)],
    offset: Annotated[int, Query(ge=0, le=1_000_000)] = 0,
    limit: Annotated[int, Query(ge=1, le=30)] = 10,
):
    return agent_knowledge.search(subject, q, offset, limit)


@router.get("/knowledge/read", response_model=KnowledgeRead)
def read_knowledge(
    subject: KnowledgeSubject,
    source_id: Annotated[str, Query(min_length=1, max_length=1024)],
    version: Annotated[str | None, Query(pattern=agent_knowledge.HASH_PATTERN)] = None,
    offset: Annotated[int, Query(ge=0, le=4_000_000)] = 0,
    limit: Annotated[int, Query(ge=1, le=24000)] = 6000,
):
    return agent_knowledge.read(subject, source_id, version, offset, limit)


@router.get("/projects/{project_id}/changes", response_model=ProjectChanges)
def project_changes(
    project_id: IDPath,
    db: DB,
    user: AgentUser,
    cursor: Annotated[str | None, Query(max_length=2048)] = None,
    kind: agent_events.EventKind | None = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
    days: Annotated[int, Query(ge=1, le=agent_events.HISTORY_DAYS)] = 7,
):
    return agent_events.changes(db, user, project_id, cursor, kind, limit, days)
