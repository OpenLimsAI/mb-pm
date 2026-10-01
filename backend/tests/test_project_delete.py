"""项目删除：仅 admin / cmc_lead；级联删除子项目 / 任务 / 依赖 / 团队 / 财务 / 基线，保留用户账号。

跑在 conftest 选定的库上（默认临时 SQLite；CI 设 TEST_DATABASE_URL 即为 PostgreSQL），
每个用例使用独立项目并在结束时清理。SQLite 默认不执行外键级联，正好覆盖「财务 / 基线
残留孤儿行」这类只在 SQLite 上暴露的问题。
"""

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models import User

ROLE_USERS = {
    "admin": "del-admin",
    "cmc_lead": "del-cmc",
    "project_lead": "del-pl",
    "rd": "del-rd",
    "production": "del-prod",
    "qa_qc": "del-qa",
}
FULL = {
    "project": 1,
    "members": 1,
    "sub_projects": 1,
    "tasks": 2,
    "dependencies": 1,
    "finances": 1,
    "baselines": 1,
}


@pytest.fixture
def project_id(iam_user, project_factory, project_rows):
    for role, user_id in ROLE_USERS.items():
        iam_user(user_id, role)
    # 项目负责人是 owner，研发是成员 —— 两者都不应有删除权限。
    pid = project_factory(owner_id=ROLE_USERS["project_lead"], member_ids=(ROLE_USERS["rd"],))
    assert project_rows(pid) == FULL
    return pid


@pytest.mark.parametrize("role", ["admin", "cmc_lead"])
def test_admin_and_cmc_lead_delete_project_with_all_children(
    client, bearer, project_rows, project_id, role
):
    headers = bearer(ROLE_USERS[role], role)
    response = client.delete(f"/api/v1/projects/{project_id}", headers=headers)
    assert response.status_code == 204, response.text
    assert set(project_rows(project_id).values()) == {0}
    assert client.get(f"/api/v1/projects/{project_id}", headers=headers).status_code == 404
    listed = client.get("/api/v1/projects", params={"page_size": 2000}, headers=headers).json()
    assert project_id not in {p["id"] for p in listed["items"]}
    finances = client.get("/api/v1/finances", headers=headers).json()
    assert project_id not in {f["project_id"] for f in finances}
    db = SessionLocal()
    try:  # 团队成员与负责人的账号保留
        assert db.get(User, ROLE_USERS["rd"]) is not None
        assert db.get(User, ROLE_USERS["project_lead"]) is not None
    finally:
        db.close()


@pytest.mark.parametrize("role", ["project_lead", "rd", "production", "qa_qc"])
def test_other_roles_cannot_delete_even_as_owner_or_member(
    client, bearer, project_rows, project_id, role
):
    response = client.delete(
        f"/api/v1/projects/{project_id}", headers=bearer(ROLE_USERS[role], role)
    )
    assert response.status_code == 403
    assert project_rows(project_id) == FULL


def test_unauthenticated_delete_is_rejected(client, project_rows, project_id):
    assert client.delete(f"/api/v1/projects/{project_id}").status_code == 401
    assert project_rows(project_id) == FULL


def test_missing_project_returns_404(client, bearer, project_id):
    headers = bearer(ROLE_USERS["admin"], "admin")
    assert client.delete("/api/v1/projects/does-not-exist", headers=headers).status_code == 404


def test_integrity_error_returns_409_and_rolls_back(
    client, bearer, project_rows, project_id, monkeypatch
):
    headers = bearer(ROLE_USERS["admin"], "admin")

    def fail_commit(self):
        raise IntegrityError("DELETE FROM projects", {}, Exception("still referenced"))

    with monkeypatch.context() as m:
        m.setattr(Session, "commit", fail_commit)
        response = client.delete(f"/api/v1/projects/{project_id}", headers=headers)
    assert response.status_code == 409
    assert project_rows(project_id) == FULL
