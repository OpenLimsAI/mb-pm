from datetime import date
from uuid import uuid4

from app.db.session import SessionLocal
from app.models import Project, Task


def test_scoped_pages_detect_order_change_with_same_total(client, admin_user, auth_headers, project_factory):
    project_id = project_factory(admin_user)
    params = {"project_id": project_id, "page_size": 1, "consistent": True}
    first = client.get("/api/v1/tasks", params=params, headers=auth_headers).json()
    second = client.get("/api/v1/tasks", params={**params, "page": 2}, headers=auth_headers).json()
    assert first["meta"]["total"] == second["meta"]["total"] == 2
    assert first["meta"]["snapshot"] == second["meta"]["snapshot"]
    first_id = first["items"][0]["id"]
    second_id = second["items"][0]["id"]
    assert first_id != second_id

    with SessionLocal() as db:
        task = db.get(Task, second_id)
        task.planned_start = date(2025, 12, 31)
        db.commit()

    shifted = client.get("/api/v1/tasks", params={**params, "page": 2}, headers=auth_headers).json()
    assert shifted["meta"]["total"] == 2
    assert shifted["items"][0]["id"] == first_id
    assert shifted["meta"]["snapshot"] != first["meta"]["snapshot"]


def test_project_page_contains_the_other_project(client, admin_user, auth_headers, project_factory):
    project_ids = [project_factory(admin_user), project_factory(admin_user)]
    keyword = f"pagination-{uuid4().hex}"
    with SessionLocal() as db:
        for project_id in project_ids:
            db.get(Project, project_id).name = keyword
        db.commit()
    params = {"keyword": keyword, "page_size": 1, "consistent": True}
    first = client.get("/api/v1/projects", params=params, headers=auth_headers).json()
    second = client.get("/api/v1/projects", params={**params, "page": 2}, headers=auth_headers).json()
    assert first["meta"]["total"] == 2
    assert first["meta"]["snapshot"] == second["meta"]["snapshot"]
    assert {first["items"][0]["id"], second["items"][0]["id"]} == set(project_ids)
