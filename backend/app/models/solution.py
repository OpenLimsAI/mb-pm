"""Knowledge solutions: private evidence, immutable versions and per-user conversations."""

from datetime import UTC, datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


def now():
    return datetime.now(UTC)


class SolutionActor(Base):
    __tablename__ = "solution_actors"
    issuer: Mapped[str] = mapped_column(String(255), primary_key=True)
    subject: Mapped[str] = mapped_column(String(255), primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)


class KnowledgeSolution(Base):
    __tablename__ = "knowledge_solutions"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    issuer: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    owner_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    owner_name: Mapped[str] = mapped_column(String(255), nullable=False)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    project_name: Mapped[str] = mapped_column(String(200), default="", nullable=False)
    product_name: Mapped[str] = mapped_column(String(200), default="", nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="draft", nullable=False)
    requires_kb: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    revision: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    sections: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    formula: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    references: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reviewer_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    reviewer_name: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    review_notes: Mapped[str] = mapped_column(Text, default="", nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now, nullable=False
    )


class SolutionSource(Base):
    __tablename__ = "solution_sources"
    __table_args__ = (UniqueConstraint("issuer", "owner_id", "publication_key"),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    issuer: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    owner_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    authors: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    date: Mapped[str] = mapped_column(String(40), default="", nullable=False)
    project_name: Mapped[str] = mapped_column(String(200), default="", nullable=False)
    tags: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    locator: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    version: Mapped[str] = mapped_column(String(80), default="1", nullable=False)
    url: Mapped[str] = mapped_column(String(2000), default="", nullable=False)
    publication_key: Mapped[str | None] = mapped_column(String(100), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now, nullable=False
    )


class SolutionVersion(Base):
    __tablename__ = "solution_versions"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    solution_id: Mapped[str] = mapped_column(ForeignKey("knowledge_solutions.id"), index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    actor_name: Mapped[str] = mapped_column(String(255), nullable=False)
    note: Mapped[str] = mapped_column(Text, nullable=False)
    snapshot: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now, nullable=False
    )


class SolutionAnswer(Base):
    __tablename__ = "solution_answers"
    __table_args__ = (
        Index("ix_solution_answers_solution_conversation", "solution_id", "conversation_id"),
    )
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    solution_id: Mapped[str] = mapped_column(ForeignKey("knowledge_solutions.id"), index=True)
    issuer: Mapped[str] = mapped_column(String(255), nullable=False)
    owner_id: Mapped[str] = mapped_column(String(255), nullable=False)
    conversation_id: Mapped[str | None] = mapped_column(String(80), nullable=True)
    question: Mapped[str] = mapped_column(Text, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    mode: Mapped[str] = mapped_column(String(20), nullable=False)
    references: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    context: Mapped[str] = mapped_column(Text, default="", nullable=False)
    scope: Mapped[str] = mapped_column(String(1000), nullable=False)
    model: Mapped[str] = mapped_column(String(160), default="", nullable=False)
    answer_mode: Mapped[str] = mapped_column(
        String(20), nullable=False, default="", server_default=""
    )
    requested_mode: Mapped[str] = mapped_column(
        String(20), nullable=False, default="", server_default=""
    )
    mode_reason: Mapped[str] = mapped_column(
        String(200), nullable=False, default="", server_default=""
    )
    web_references: Mapped[list] = mapped_column(
        JSON, nullable=False, default=list, server_default="[]"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now, nullable=False
    )


class SolutionEvent(Base):
    __tablename__ = "solution_events"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    solution_id: Mapped[str] = mapped_column(ForeignKey("knowledge_solutions.id"), index=True)
    actor_id: Mapped[str] = mapped_column(String(255), nullable=False)
    action: Mapped[str] = mapped_column(String(40), nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    details: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now, nullable=False
    )
