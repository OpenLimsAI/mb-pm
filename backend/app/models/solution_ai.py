"""Encrypted per-IAM-identity report model settings, separate from PM AI settings."""

from sqlalchemy import Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class SolutionAISettings(Base):
    __tablename__ = "solution_ai_settings"
    issuer: Mapped[str] = mapped_column(String(255), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    encrypted_payload: Mapped[str] = mapped_column(Text, nullable=False)
