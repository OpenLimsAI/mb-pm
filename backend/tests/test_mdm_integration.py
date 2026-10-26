"""MDM reference contract: real auth dependency + scoped SQL; isolated test DB."""
import pytest

from app.core.config import settings
from app.db.session import SessionLocal
from app.models import Project


def test_reference_requires_login(client):
    assert client.get("/api/v1/projects/unknown/integration-reference").status_code == 401


def test_reference_honors_project_scope(client, project_factory, iam_user, bearer):
    owner = iam_user("mdm-owner", "project_lead")
    outsider = iam_user("mdm-outsider", "rd")
    pid = project_factory(owner)
    url = f"/api/v1/projects/{pid}/integration-reference"
    assert client.get(url, headers=bearer(outsider, "rd")).status_code == 404
    response = client.get(url, headers=bearer(owner, "project_lead"))
    assert response.status_code == 200, response.text
    assert response.json() == {"id": pid, "code": pid.upper(), "name": "测试项目", "status": "活跃", "bindable": True}
    assert client.get("/api/v1/projects/missing/integration-reference", headers=bearer(owner, "project_lead")).status_code == 404
    with SessionLocal() as db:
        db.get(Project, pid).status = "已归档"
        db.commit()
    assert client.get(url, headers=bearer(owner, "project_lead")).json()["bindable"] is False


@pytest.mark.parametrize("base", ["", "javascript:alert(1)", "https://user:secret@mdm.test", "https://mdm.test/?token=x", "http://remote.test", "https://mdm.test/%2f%2fevil"])
def test_launch_fails_closed_for_bad_config(base, client, project_factory, iam_user, bearer, monkeypatch):
    monkeypatch.setattr(settings, "MDM_PUBLIC_URL", base)
    owner = iam_user("mdm-launch-owner", "project_lead")
    pid = project_factory(owner)
    assert client.get(f"/api/v1/projects/{pid}/mdm-launch", headers=bearer(owner, "project_lead")).status_code == 503


def test_context_deep_link_has_no_identity_or_token(client, project_factory, iam_user, bearer, monkeypatch):
    monkeypatch.setattr(settings, "MDM_PUBLIC_URL", "http://localhost:5188/mdm/")
    owner = iam_user("mdm-deep-link-owner", "project_lead")
    outsider = iam_user("mdm-link-outsider", "rd")
    pid = project_factory(owner)
    url = f"/api/v1/projects/{pid}/mdm-launch"
    assert client.get(url).status_code == 401
    assert client.get(url, headers=bearer(outsider, "rd")).status_code == 404
    result = client.get(url, headers=bearer(owner, "project_lead"))
    assert result.status_code == 200
    assert result.json() == {"url": f"http://localhost:5188/mdm/pm-projects/{pid}"}
