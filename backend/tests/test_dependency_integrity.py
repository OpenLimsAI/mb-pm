from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest

from app.db.session import SessionLocal
from app.models import TaskDependency


def edge(client, headers, pred, succ, **extra):
    return client.post(
        "/api/v1/task-dependencies",
        headers=headers,
        json={"predecessor_id": pred, "successor_id": succ, "type": "FS", "lag_days": 0, **extra},
    )


def test_duplicate_retry_and_cycle_rejection(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    retry = edge(client, auth_headers, f"{pid}-t1", f"{pid}-t2")
    assert retry.status_code == 201
    assert retry.json()["id"] == f"{pid}-dep"
    assert edge(client, auth_headers, f"{pid}-t1", f"{pid}-t2", type="SS").status_code == 409
    assert edge(client, auth_headers, f"{pid}-t2", f"{pid}-t1").status_code == 422
    with SessionLocal() as db:
        assert db.query(TaskDependency).filter_by(successor_id=f"{pid}-t2").count() == 1


def test_cross_project_cycle_and_unrelated_legacy_cycle(client, auth_headers, project_factory):
    a, b, bad = (project_factory("t-admin") for _ in range(3))
    with SessionLocal() as db:
        db.add(
            TaskDependency(
                id=bad + "-reverse",
                predecessor_id=bad + "-t2",
                successor_id=bad + "-t1",
                type="FS",
                lag_days=0,
            )
        )
        db.commit()
    assert edge(client, auth_headers, a + "-t2", b + "-t1").status_code == 201
    assert edge(client, auth_headers, b + "-t2", a + "-t1").status_code == 422
    # An unrelated historic cycle cannot prevent users from repairing it.
    assert (
        client.delete(
            "/api/v1/task-dependencies/" + bad + "-reverse", headers=auth_headers
        ).status_code
        == 204
    )


def test_external_predecessor_blocks_both_preview_and_apply(client, auth_headers, project_factory):
    a, b = (project_factory("t-admin") for _ in range(2))
    assert edge(client, auth_headers, a + "-t2", b + "-t1").status_code == 201
    for pid in [a, b]:
        payload = {
            "task_id": pid + "-t1",
            "new_start": "2026-01-01",
            "new_end": "2026-01-02",
            "reason": "不应绕过跨项目约束",
            "fingerprint": "old",
        }
        for method in ["preview", "apply"]:
            response = client.post(
                f"/api/v1/planning/projects/{pid}/schedule-{method}",
                headers=auth_headers,
                json=payload,
            )
            assert response.status_code == 422 and "跨项目" in response.text


def test_concurrent_disjoint_edges_cannot_close_cross_project_cycle(
    client, auth_headers, project_factory
):
    with SessionLocal() as db:
        if db.get_bind().dialect.name != "postgresql":
            pytest.skip("Requires PostgreSQL transaction advisory locks")
    a, b, c, d = (project_factory("t-admin") + "-t1" for _ in range(4))
    assert edge(client, auth_headers, b, c).status_code == 201
    assert edge(client, auth_headers, d, a).status_code == 201
    barrier = Barrier(2)

    def add(pair):
        barrier.wait()
        return edge(client, auth_headers, *pair).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(add, [(a, b), (c, d)]))
    assert sorted(statuses) == [201, 422]
