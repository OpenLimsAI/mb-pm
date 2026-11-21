from datetime import UTC, datetime
from uuid import uuid4

from app.db.session import SessionLocal
from app.models import Task, User
from app.models.pm_ai import PMAIRun
from app.services.pm_ai_context import ContextRequest, build_context


def test_large_report_review_loads_only_batch_and_preserves_live_revision(
    client, auth_headers, admin_user, project_factory, live_ai_roles
):
    pid = project_factory(admin_user)
    target_id = f"{pid}-late-610"
    with SessionLocal.begin() as db:
        first = db.get(Task, f"{pid}-t1")
        for index in range(611):
            db.add(
                Task(
                    id=f"{pid}-late-{index}",
                    code=f"L{index:04}",
                    name=f"后续任务 {index}",
                    sub_project_id=first.sub_project_id,
                    owner_id=admin_user,
                    priority="中",
                    status="未开始",
                    progress=0,
                    planned_start=first.planned_start,
                    planned_end=first.planned_end,
                )
            )
    with SessionLocal.begin() as db:
        request = ContextRequest(project_ids=[pid], scenario="weekly")
        context = build_context(db, db.get(User, admin_user), request, workflow=True)
        target = db.get(Task, target_id)
        revision = target.revision
        actions = [
            {
                "kind": "task_update",
                "task_id": f"{pid}-t1",
                "expected_revision": 1,
                "progress": 40,
                "reason": "测试依据",
                "evidence_ids": [f"task:{pid}-t1"],
            }
        ] * 12
        actions.append(
            {
                "kind": "task_update",
                "task_id": target_id,
                "expected_revision": revision,
                "progress": 50,
                "reason": "测试依据",
                "evidence_ids": [f"task:{target_id}"],
            }
        )
        run_id = uuid4().hex
        db.add(
            PMAIRun(
                id=run_id,
                created_by=admin_user,
                created_at=datetime.now(UTC),
                state="succeeded",
                request=request.model_dump(mode="json"),
                context=context,
                source=context["source"],
                result={"summary": "完成", "findings": [], "draft_actions": actions},
                usage={},
                error="",
            )
        )
    # The ordinary model context exceeds its old size budget; review must still work.
    assert (
        client.get(
            "/api/v1/pm-ai/context", params={"project_id": pid}, headers=auth_headers
        ).status_code
        == 422
    )
    url = f"/api/v1/pm-ai/runs/{run_id}/review-context"
    before = client.get(url, params={"batch": 1}, headers=auth_headers)
    assert before.status_code == 200, before.text
    assert [row["id"] for row in before.json()["tasks"]] == [target_id]
    assert "notes" not in before.json()["tasks"][0]
    assert len(before.content) < 10000
    with SessionLocal.begin() as db:
        db.get(Task, target_id).revision += 1
    after = client.get(url, params={"batch": 1}, headers=auth_headers)
    assert after.json()["tasks"][0]["revision"] == revision + 1
    # Reading latest labels/versions must not rewrite the original draft revision.
    preview = client.post(
        f"/api/v1/pm-ai/runs/{run_id}/changes/preview",
        headers=auth_headers,
        json={"actions": [actions[-1]]},
    )
    assert preview.status_code == 409, preview.text
    assert client.get(url, params={"batch": 2}, headers=auth_headers).status_code == 404
    assert client.get(url).status_code == 401


def test_review_context_refuses_foreign_run_and_scope_escape(
    client, auth_headers, admin_user, iam_user, project_factory, live_ai_roles
):
    other = iam_user("review-other", "rd")
    pid = project_factory(admin_user)
    with SessionLocal.begin() as db:
        request = ContextRequest(project_ids=[pid])
        context = build_context(db, db.get(User, admin_user), request)
        run_id = uuid4().hex
        db.add(
            PMAIRun(
                id=run_id,
                created_by=other,
                created_at=datetime.now(UTC),
                state="succeeded",
                request=request.model_dump(mode="json"),
                context=context,
                source=context["source"],
                result={"summary": "test", "findings": [], "draft_actions": []},
                usage={},
                error="",
            )
        )
    url = f"/api/v1/pm-ai/runs/{run_id}/review-context"
    assert client.get(url, headers=auth_headers).status_code == 404
    with SessionLocal.begin() as db:
        row = db.get(PMAIRun, run_id)
        row.created_by = admin_user
        row.result = {
            "summary": "test",
            "findings": [],
            "draft_actions": [{"kind": "task_update", "task_id": "out-of-snapshot"}],
        }
    assert client.get(url, headers=auth_headers).status_code == 409
