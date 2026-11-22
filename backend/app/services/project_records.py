"""Domain-owned Project persistence helpers for cross-domain callers."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.project import Project


def get_project(db: Session, project_id: str) -> Project | None:
    return db.get(Project, project_id)


def project_code_exists(db: Session, code: str) -> bool:
    return bool(db.scalar(select(Project.id).where(Project.code == code)))


def create_mdm_project(db: Session, *, project_id: str, **fields) -> Project:
    project = Project(
        id=project_id,
        **fields,
        status="活跃",
        health="green",
        progress=0,
    )
    db.add(project)
    db.flush()
    return project
