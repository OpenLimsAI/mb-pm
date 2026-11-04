"""Organization-wide feedback and its image attachments."""

from datetime import UTC, datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class Feedback(Base):
    __tablename__ = "feedback"
    __table_args__ = (
        Index("ix_feedback_issuer_issue_number", "issuer", "issue_number", unique=True),
        Index(
            "ix_feedback_create_request", "issuer", "author_id", "client_request_id", unique=True
        ),
    )
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    issuer: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    author_id: Mapped[str] = mapped_column(String(255), nullable=False)
    author_name: Mapped[str] = mapped_column(String(255), nullable=False)
    category: Mapped[str] = mapped_column(String(20), nullable=False)
    application: Mapped[str | None] = mapped_column(String(32), nullable=True)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="open", nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC), nullable=False
    )
    issue_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    client_request_id: Mapped[str | None] = mapped_column(String(64))
    request_hash: Mapped[str | None] = mapped_column(String(64))
    workflow_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    revision: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    source_context: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    steps_to_reproduce: Mapped[str] = mapped_column(Text, default="", nullable=False)
    expected_result: Mapped[str] = mapped_column(Text, default="", nullable=False)
    actual_result: Mapped[str] = mapped_column(Text, default="", nullable=False)
    problem_to_solve: Mapped[str] = mapped_column(Text, default="", nullable=False)
    expected_benefit: Mapped[str] = mapped_column(Text, default="", nullable=False)
    assignee_id: Mapped[str | None] = mapped_column(String(255))
    assignee_name: Mapped[str | None] = mapped_column(String(255))
    priority: Mapped[str] = mapped_column(String(8), default="p2", nullable=False)
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolution: Mapped[str] = mapped_column(Text, default="", nullable=False)
    verification_steps: Mapped[str] = mapped_column(Text, default="", nullable=False)
    release_version: Mapped[str] = mapped_column(String(100), default="", nullable=False)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    votes: Mapped[list["FeedbackVote"]] = relationship(cascade="all, delete-orphan")
    watches: Mapped[list["FeedbackWatch"]] = relationship(cascade="all, delete-orphan")
    read_states: Mapped[list["FeedbackRead"]] = relationship(cascade="all, delete-orphan")
    notices: Mapped[list["FeedbackNotice"]] = relationship(cascade="all, delete-orphan")
    images: Mapped[list["FeedbackImage"]] = relationship(
        cascade="all, delete-orphan", order_by="FeedbackImage.id"
    )

    activities: Mapped[list["FeedbackActivity"]] = relationship(cascade="all, delete-orphan")


class FeedbackActivity(Base):
    """Append-only replies and status transitions, scoped through their feedback."""

    __tablename__ = "feedback_activities"
    __table_args__ = (
        UniqueConstraint("feedback_id", "client_request_id", name="uq_feedback_activity_request"),
    )
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    feedback_id: Mapped[str] = mapped_column(
        ForeignKey("feedback.id", ondelete="CASCADE"), nullable=False, index=True
    )
    author_id: Mapped[str] = mapped_column(String(255), nullable=False)
    author_name: Mapped[str] = mapped_column(String(255), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False, default="")
    from_status: Mapped[str | None] = mapped_column(String(20))
    to_status: Mapped[str | None] = mapped_column(String(20))
    details: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    images: Mapped[list["FeedbackActivityImage"]] = relationship(cascade="all, delete-orphan")
    client_request_id: Mapped[str | None] = mapped_column(String(64))
    request_hash: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC), nullable=False, index=True
    )


class FeedbackImage(Base):
    __tablename__ = "feedback_images"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    feedback_id: Mapped[str] = mapped_column(
        ForeignKey("feedback.id", ondelete="CASCADE"), nullable=False, index=True
    )
    archived: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    content_type: Mapped[str] = mapped_column(String(30), nullable=False)
    content: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)


class FeedbackCounter(Base):
    __tablename__ = "feedback_counters"
    issuer: Mapped[str] = mapped_column(String(255), primary_key=True)
    value: Mapped[int] = mapped_column(Integer, nullable=False)


class FeedbackVote(Base):
    __tablename__ = "feedback_votes"
    feedback_id: Mapped[str] = mapped_column(
        ForeignKey("feedback.id", ondelete="CASCADE"), primary_key=True
    )
    subject: Mapped[str] = mapped_column(String(255), primary_key=True)


class FeedbackWatch(Base):
    __tablename__ = "feedback_watches"
    feedback_id: Mapped[str] = mapped_column(
        ForeignKey("feedback.id", ondelete="CASCADE"), primary_key=True
    )
    subject: Mapped[str] = mapped_column(String(255), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class FeedbackRead(Base):
    __tablename__ = "feedback_reads"
    feedback_id: Mapped[str] = mapped_column(
        ForeignKey("feedback.id", ondelete="CASCADE"), primary_key=True
    )
    subject: Mapped[str] = mapped_column(String(255), primary_key=True)
    read_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class FeedbackNotice(Base):
    __tablename__ = "feedback_notices"
    __table_args__ = (
        UniqueConstraint("activity_id", "subject", name="uq_feedback_notice_recipient"),
    )
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    feedback_id: Mapped[str] = mapped_column(
        ForeignKey("feedback.id", ondelete="CASCADE"), nullable=False, index=True
    )
    activity_id: Mapped[str] = mapped_column(
        ForeignKey("feedback_activities.id", ondelete="CASCADE"), nullable=False
    )
    issuer: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    subject: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(UTC)
    )
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class FeedbackActivityImage(Base):
    __tablename__ = "feedback_activity_images"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    activity_id: Mapped[str] = mapped_column(
        ForeignKey("feedback_activities.id", ondelete="CASCADE"), nullable=False, index=True
    )
    content_type: Mapped[str] = mapped_column(String(30), nullable=False)
    content: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
