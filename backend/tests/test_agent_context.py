from datetime import UTC, date, datetime, timedelta

from test_agent_projects import ROOT
from test_agent_projects import delegated_token as agent_token_fixture

from app.db.session import SessionLocal
from app.models import SubProject, Task, User
from app.models.pm_management import PMRegisterEntry
from app.models.task_collaboration import TaskAcceptance, TaskActivity, TaskDeliverable

delegated_token = agent_token_fixture


def test_project_context_limits_structure_and_lists_active_eligible_members(
    client, iam_user, project_factory, delegated_token
):
    owner = iam_user("agent-context-owner", "project_lead")
    viewer = iam_user("agent-context-viewer", "rd")
    inactive = iam_user("agent-ctx-inactive", "rd")
    pid = project_factory(owner, (viewer, inactive), task_owner_id=viewer)
    other = project_factory(owner)
    with SessionLocal() as db:
        db.get(User, inactive).is_active = False
        db.add(
            SubProject(
                id=f"{pid}-restricted",
                project_id=pid,
                name="Unassigned workstream",
                stage="IND",
                module="DSP",
                status="未开始",
            )
        )
        db.commit()

    scoped = delegated_token(viewer)
    path = f"{ROOT}/projects/{pid}/context"
    response = client.get(path, params={"page_size": 1}, headers=scoped)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["business_date"] == date.today().isoformat()
    assert "已验证" in body["task_statuses"]
    assert body["project"]["id"] == pid
    assert body["capabilities"]["proposal_actions"] == []
    assert [x["id"] for x in body["sub_projects"]["items"]] == [f"{pid}-sp"]
    assert body["sub_projects"]["meta"]["total"] == 1
    assert body["members"]["meta"]["total"] == 2
    assert body["members"]["meta"]["has_more"] is True
    page_two = client.get(path, params={"page_size": 1, "page": 2}, headers=scoped).json()
    assert {x["id"] for x in body["members"]["items"] + page_two["members"]["items"]} == {
        owner,
        viewer,
    }
    assert client.get(f"{ROOT}/projects/{other}/context", headers=scoped).status_code == 404

    manager = client.get(path, headers=delegated_token(owner, "project_lead")).json()
    assert manager["sub_projects"]["meta"]["total"] == 2
    assert manager["capabilities"]["can_assign_members"] is True
    assert "schedule" in manager["capabilities"]["proposal_actions"]


def test_task_context_filters_dependencies_and_never_returns_cost_or_binary(
    client, iam_user, project_factory, delegated_token
):
    owner = iam_user("agent-detail-owner", "admin")
    viewer = iam_user("agent-detail-viewer", "rd")
    pid = project_factory(owner, (viewer,), task_owner_id=owner)
    task_id = f"{pid}-t1"
    current = datetime.now(UTC)
    with SessionLocal() as db:
        task = db.get(Task, task_id)
        task.owner_id = viewer
        task.priority = "高"
        task.status = "阻塞"
        task.notes = "设备异常，等待排查"
        task.is_milestone = True
        for n in (1, 2):
            db.add(
                TaskActivity(
                    id=f"{pid}-activity-{n}",
                    task_id=task_id,
                    actor_id=viewer,
                    kind="progress",
                    body=f"记录 {n}",
                    changes={
                        "progress": {"before": 0, "after": 20},
                        "cost_budget": {"before": 5, "after": 10},
                    },
                    created_at=current + timedelta(seconds=n),
                )
            )
        db.add(
            TaskDeliverable(
                id=f"{pid}-file",
                task_id=task_id,
                author_id=viewer,
                title="报告",
                filename="report.pdf",
                content=b"sensitive binary bytes",
            )
        )
        db.add(TaskAcceptance(task_id=task_id, reviewer_id=owner, required_count=1))
        db.commit()

    scoped = delegated_token(viewer)
    list_query = {
        "project_id": pid,
        "sub_project_id": f"{pid}-sp",
        "owner_id": viewer,
        "status": "阻塞",
        "due_from": "2026-06-30",
        "due_to": "2026-06-30",
    }
    response = client.get(f"{ROOT}/tasks", params=list_query, headers=scoped)
    assert response.status_code == 200, response.text
    assert response.json()["meta"]["total"] == 1
    summary = response.json()["items"][0]
    assert (summary["id"], summary["owner_id"], summary["priority"]) == (task_id, viewer, "高")
    assert "notes" not in summary
    assert (
        client.get(
            f"{ROOT}/tasks", params={**list_query, "owner_id": owner}, headers=scoped
        ).json()["items"]
        == []
    )
    assert (
        client.get(
            f"{ROOT}/tasks", params={**list_query, "due_to": "2026-06-29"}, headers=scoped
        ).status_code
        == 422
    )

    path = f"{ROOT}/tasks/{task_id}"
    response = client.get(path, params={"page_size": 1}, headers=scoped)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["dependencies"]["meta"]["total"] == 0
    assert body["task"]["notes"] == "设备异常，等待排查"
    assert body["activities"]["meta"]["total"] == 2
    assert body["activities"]["items"][0]["body"] == "记录 2"
    assert body["activities"]["items"][0]["changes"] == {"progress": {"before": 0, "after": 20}}
    assert body["deliverables"]["items"][0]["filename"] == "report.pdf"
    assert "content" not in body["deliverables"]["items"][0]
    assert body["acceptance"]["reviewer_id"] == owner
    assert set(body["proposal_actions"]) == {
        "update_progress",
        "attach_deliverable",
        "submit_acceptance",
    }
    next_page = client.get(path, params={"page_size": 1, "page": 2}, headers=scoped).json()
    assert next_page["activities"]["items"][0]["body"] == "记录 1"
    assert client.get(f"{ROOT}/tasks/{pid}-t2", headers=scoped).status_code == 404

    manager = client.get(path, headers=delegated_token(owner, "admin")).json()
    assert manager["dependencies"]["items"][0]["successor_id"] == f"{pid}-t2"


def test_register_filters_by_kind_and_status_under_project_scope(
    client, iam_user, project_factory, delegated_token
):
    owner = iam_user("agent-register-owner", "admin")
    viewer = iam_user("agent-reg-viewer", "rd")
    pid = project_factory(owner, (viewer,))
    other = project_factory(owner)
    with SessionLocal() as db:
        for project, kind, status in (
            (pid, "risk", "open"),
            (pid, "issue", "closed"),
            (pid, "decision", "closed"),
            (other, "decision", "closed"),
        ):
            db.add(
                PMRegisterEntry(
                    id=f"{project}-{kind}",
                    project_id=project,
                    kind=kind,
                    owner_id=owner,
                    title=f"台账记录 {kind}",
                    due_date=date(2026, 6, 30),
                    severity="high",
                    status=status,
                    closure="有书面决定" if status == "closed" else "",
                )
            )
        db.commit()
    scoped = delegated_token(viewer)
    path = f"{ROOT}/projects/{pid}/register"
    response = client.get(path, params={"kind": "decision", "status": "closed"}, headers=scoped)
    assert response.status_code == 200, response.text
    assert response.json()["meta"]["total"] == 1
    record = response.json()["items"][0]
    assert record["project_id"] == pid and record["closure"] == "有书面决定"
    assert client.get(f"{ROOT}/projects/{other}/register", headers=scoped).status_code == 404
