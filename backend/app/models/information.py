"""Organization-shared collection metadata; personal state is separately keyed.

Binary originals are content-addressed in INFORMATION_DATA_DIR, never JSON or static assets.
The worker lease is database-wide so direct and tunnel instances cannot double-collect.
"""

from sqlalchemy import JSON, Float, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class InformationEntry(Base):
    __tablename__ = "information_entries"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    tenant: Mapped[str] = mapped_column(String(64), nullable=False)
    kind: Mapped[str] = mapped_column(String(24), nullable=False)
    data: Mapped[dict] = mapped_column(JSON, nullable=False)
    updated_at: Mapped[float] = mapped_column(Float, nullable=False)
    __table_args__ = (Index("ix_information_tenant_kind", "tenant", "kind"),)


class InformationLease(Base):
    __tablename__ = "information_leases"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    expires_at: Mapped[float] = mapped_column(Float, nullable=False, default=0)


class InformationText(Base):
    __tablename__ = "information_texts"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    tenant: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    document_id: Mapped[str] = mapped_column(String(64), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
