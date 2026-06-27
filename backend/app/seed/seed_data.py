"""从 seed.json 灌入种子数据 —— 与前端 Lite 完全一致。

seed.json 由前端脚本生成：
    cd <Lite 前端> && npx tsx scripts/dump-seed.mjs

运行（手动重灌）：
    python -m app.seed.seed_data
"""

import json
from datetime import date, datetime
from pathlib import Path

from app.db.session import SessionLocal
from app.models import (
    Project,
    ProjectFinance,
    ProjectMember,
    SubProject,
    Task,
    TaskDependency,
    Template,
    TemplateVersion,
    User,
)

SEED_PATH = Path(__file__).parent / "seed.json"


def _date(s: str | None) -> date | None:
    return date.fromisoformat(s) if s else None


def _dt(s: str | None) -> datetime | None:
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def seed() -> None:
    """幂等重灌：先清空再插入（启动钩子仅在库为空时调用）。"""
    data = json.loads(SEED_PATH.read_text(encoding="utf-8"))
    db = SessionLocal()
    try:
        # 清空（按外键依赖顺序）
        db.query(TaskDependency).delete()
        db.query(Task).delete()
        db.query(SubProject).delete()
        db.query(ProjectFinance).delete()
        db.query(ProjectMember).delete()
        db.query(Project).delete()
        db.query(TemplateVersion).delete()
        db.query(Template).delete()
        db.query(User).delete()
        db.flush()

        # —— Users —— #
        for u in data["users"]:
            db.add(
                User(
                    id=u["id"],
                    username=u["username"],
                    display_name=u["displayName"],
                    email=u["email"],
                    role=u["role"],
                    specialty_group=u.get("specialtyGroup"),
                    weekly_available_hours=u.get("weeklyAvailableHours", 40),
                    is_active=u.get("isActive", True),
                    avatar_color=u.get("avatarColor"),
                )
            )
        db.flush()

        # —— Templates + versions —— #
        for t in data["templates"]:
            db.add(
                Template(
                    id=t["id"],
                    name=t["name"],
                    product_type=t["productType"],
                    current_version=t["currentVersion"],
                    description=t.get("description"),
                    is_active=t.get("isActive", True),
                    created_by=t.get("createdBy"),
                )
            )
            db.flush()
            for v in t["versions"]:
                db.add(
                    TemplateVersion(
                        id=v["id"],
                        template_id=t["id"],
                        version_number=v["versionNumber"],
                        structure_json=v["structureJson"],
                        change_summary=v.get("changeSummary"),
                        change_source=v.get("changeSource", "visual_edit"),
                        modified_by=v.get("modifiedBy"),
                        modified_at=_dt(v["modifiedAt"]),
                        is_current=v.get("isCurrent", False),
                    )
                )
        db.flush()

        # —— Projects + members —— #
        for p in data["projects"]:
            db.add(
                Project(
                    id=p["id"],
                    code=p["code"],
                    name=p["name"],
                    product_type=p["productType"],
                    current_stage=p["currentStage"],
                    target_stage=p["targetStage"],
                    owner_id=p["ownerId"],
                    status=p["status"],
                    health=p["health"],
                    progress=p.get("progress", 0),
                    planned_start=_date(p["plannedStart"]),
                    planned_end=_date(p["plannedEnd"]),
                    template_id=p.get("templateId"),
                    template_version=p.get("templateVersion"),
                    description=p.get("description"),
                )
            )
            db.flush()
            for mid in p.get("memberIds", []):
                if mid == p["ownerId"]:
                    continue
                db.add(ProjectMember(project_id=p["id"], user_id=mid))
        db.flush()

        # —— SubProjects —— #
        for s in data["subProjects"]:
            db.add(
                SubProject(
                    id=s["id"],
                    name=s["name"],
                    project_id=s["projectId"],
                    stage=s["stage"],
                    module=s["module"],
                    owner_id=s.get("ownerId"),
                    status=s["status"],
                    progress=s.get("progress", 0),
                    sort_order=s.get("sortOrder", 0),
                )
            )
        db.flush()

        # —— Tasks —— #
        for t in data["tasks"]:
            db.add(
                Task(
                    id=t["id"],
                    code=t["code"],
                    name=t["name"],
                    sub_project_id=t["subProjectId"],
                    owner_id=t["ownerId"],
                    collaborator_ids=t.get("collaboratorIds"),
                    status=t["status"],
                    priority=t["priority"],
                    planned_start=_date(t["plannedStart"]),
                    planned_end=_date(t["plannedEnd"]),
                    actual_start=_date(t.get("actualStart")),
                    actual_end=_date(t.get("actualEnd")),
                    estimated_effort=t.get("estimatedEffort", 0),
                    actual_effort=t.get("actualEffort"),
                    cost_budget=t.get("costBudget"),
                    progress=t.get("progress", 0),
                    is_milestone=t.get("isMilestone", False),
                    is_critical_path=t.get("isCriticalPath", False),
                    notes=t.get("notes"),
                    tags=t.get("tags"),
                )
            )
        db.flush()

        # —— TaskDependencies —— #
        for d in data["taskDependencies"]:
            db.add(
                TaskDependency(
                    id=d["id"],
                    predecessor_id=d["predecessorId"],
                    successor_id=d["successorId"],
                    type=d["type"],
                    lag_days=d.get("lagDays", 0),
                )
            )

        # —— ProjectFinances —— #
        for f in data.get("projectFinances", []):
            db.add(
                ProjectFinance(
                    project_id=f["projectId"],
                    total_budget=f.get("totalBudget", 0),
                    spent=f.get("spent", 0),
                    committed=f.get("committed", 0),
                    breakdown=f.get("breakdown", {}),
                    fiscal_year=f.get("fiscalYear"),
                    notes=f.get("notes"),
                )
            )

        db.commit()
        print(
            f"✅ Seed complete — {len(data['users'])} users, "
            f"{len(data['projects'])} projects, {len(data['subProjects'])} sub-projects, "
            f"{len(data['tasks'])} tasks, {len(data['taskDependencies'])} dependencies, "
            f"{len(data['templates'])} template(s)"
        )
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    seed()
