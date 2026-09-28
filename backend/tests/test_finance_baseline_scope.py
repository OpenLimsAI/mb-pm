"""财务 / 基线按可见项目收窄：接入 IAM 后，非全局角色读不到、改不了无关项目的预算与基线。"""

import pytest


@pytest.fixture
def projects(iam_user, project_factory):
    lead, other_lead, rd = (
        iam_user("sc-pl", "project_lead"),
        iam_user("sc-pl2", "project_lead"),
        iam_user("sc-rd", "rd"),
    )
    iam_user("sc-admin", "admin")
    mine = project_factory(owner_id=lead, member_ids=(rd,))
    other = project_factory(owner_id=other_lead)
    return mine, other


def _finance_ids(client, headers):
    return {f["project_id"] for f in client.get("/api/v1/finances", headers=headers).json()}


def _baseline_ids(client, headers):
    return {b["project_id"] for b in client.get("/api/v1/baselines", headers=headers).json()}


@pytest.mark.parametrize("user_id, role", [("sc-rd", "rd"), ("sc-pl", "project_lead")])
def test_limited_roles_only_see_visible_projects(client, bearer, projects, user_id, role):
    mine, other = projects
    headers = bearer(user_id, role)
    assert mine in _finance_ids(client, headers)
    assert other not in _finance_ids(client, headers)
    assert mine in _baseline_ids(client, headers)
    assert other not in _baseline_ids(client, headers)


def test_admin_sees_all_projects(client, bearer, projects):
    headers = bearer("sc-admin", "admin")
    assert set(projects) <= _finance_ids(client, headers)
    assert set(projects) <= _baseline_ids(client, headers)


def test_project_lead_manages_baselines_only_on_visible_projects(client, bearer, projects):
    mine, other = projects
    headers = bearer("sc-pl", "project_lead")
    created = client.post(
        "/api/v1/baselines", json={"project_id": mine, "label": "变更基线"}, headers=headers
    )
    assert created.status_code == 201, created.text
    assert (
        client.post(
            "/api/v1/baselines", json={"project_id": other, "label": "越权"}, headers=headers
        ).status_code
        == 403
    )
    admin = bearer("sc-admin", "admin")
    other_baseline = next(
        b["id"]
        for b in client.get("/api/v1/baselines", headers=admin).json()
        if b["project_id"] == other
    )
    assert client.delete(f"/api/v1/baselines/{other_baseline}", headers=headers).status_code == 403
    assert (
        client.delete(f"/api/v1/baselines/{created.json()['id']}", headers=headers).status_code
        == 204
    )
