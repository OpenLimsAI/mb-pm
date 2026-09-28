"""项目健康度按「当天」判定（不再是固定的演示日期 2026-05-10）。"""

from datetime import date, timedelta

from app.models import Task
from app.services.rollup import _derive_health


def _task(days_from_today: int, *, milestone: bool, status: str = "进行中") -> Task:
    end = date.today() + timedelta(days=days_from_today)
    return Task(
        id=f"t{days_from_today}{milestone}",
        is_milestone=milestone,
        status=status,
        progress=0,
        planned_start=end - timedelta(days=10),
        planned_end=end,
    )


def test_health_uses_the_real_current_date():
    # 昨天到期、未完成的里程碑 → 红（旧的固定锚点 2026-05-10 下会被误判为绿）
    assert _derive_health([_task(-1, milestone=True)]) == "red"
    # 昨天到期的普通任务 → 黄；两周内到期的里程碑 → 黄
    assert _derive_health([_task(-1, milestone=False)]) == "yellow"
    assert _derive_health([_task(10, milestone=True)]) == "yellow"
    # 已完成的逾期里程碑不再算风险；远期里程碑 → 绿
    assert _derive_health([_task(-1, milestone=True, status="已验证")]) == "green"
    assert _derive_health([_task(60, milestone=True)]) == "green"


def test_explicit_today_still_supported():
    anchor = date(2026, 5, 10)
    ms = Task(
        id="m",
        is_milestone=True,
        status="未开始",
        progress=0,
        planned_start=anchor,
        planned_end=anchor - timedelta(days=1),
    )
    assert _derive_health([ms], today=anchor) == "red"


def test_project_health_is_derived_live_on_read(client, iam_user, bearer, project_factory):
    """已存 health 会随日期过期：接口读出时按当天重新派生（不必等任务被编辑）。"""
    from app.db.session import SessionLocal
    from app.models import Project

    admin = iam_user("hl-admin", "admin")
    pid = project_factory(owner_id=admin)
    db = SessionLocal()
    try:
        assert db.get(Project, pid).health == "green"  # 已存值
        ms = db.get(Task, f"{pid}-t2")
        ms.is_milestone = True
        ms.planned_start = ms.planned_end = date.today() - timedelta(days=1)  # 昨天到期、未完成
        db.commit()
    finally:
        db.close()

    headers = bearer(admin, "admin")
    assert client.get(f"/api/v1/projects/{pid}", headers=headers).json()["health"] == "red"
    listed = client.get("/api/v1/projects", params={"page_size": 2000}, headers=headers).json()
    assert {p["id"]: p["health"] for p in listed["items"]}[pid] == "red"
    red_only = client.get(
        "/api/v1/projects", params={"page_size": 2000, "health": "red"}, headers=headers
    ).json()
    assert pid in {p["id"] for p in red_only["items"]}
    green_only = client.get(
        "/api/v1/projects", params={"page_size": 2000, "health": "green"}, headers=headers
    ).json()
    assert pid not in {p["id"] for p in green_only["items"]}
