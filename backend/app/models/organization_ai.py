"""Organization-shared model registry; legacy personal model rows stay untouched."""

from sqlalchemy import Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class OrganizationAISettings(Base):
    __tablename__ = "organization_ai_settings"
    issuer: Mapped[str] = mapped_column(String(255), primary_key=True)
    organization: Mapped[str] = mapped_column(String(255), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    encrypted_payload: Mapped[str] = mapped_column(Text, nullable=False)
