"""Explicit template sharing does not share the source report or private account data."""

import test_solutions
from test_solutions import PREFIX, create

from app.models.solution import SolutionTemplate

solution_client = test_solutions.solution_client


def test_explicit_team_template_sharing_and_revocation(solution_client):
    f = solution_client
    source = create(f)
    template = {
        "name": "Team experiment",
        "sections": [
            {"id": "goal", "title": "Goal", "content": "Record conditions\n- [ ] Check controls"}
        ],
        "source_solution_id": source["id"],
        "shared": True,
    }
    created = f.client.post(PREFIX + "/templates", json=template)
    assert created.status_code == 201, created.text
    row = created.json()
    assert row["shared"] and row["can_delete"] and row["source_solution_id"] == source["id"]
    f.login("other")
    shared = f.client.get(PREFIX + "/templates").json()
    assert len(shared) == 1 and shared[0]["id"] == row["id"]
    stored = f.db.get(SolutionTemplate, row["id"])
    issuer = stored.issuer
    stored.issuer = "https://different-organization.invalid"
    f.db.commit()
    assert f.client.get(PREFIX + "/templates").json() == []
    stored.issuer = issuer
    f.db.commit()
    assert not shared[0]["can_delete"]
    assert shared[0]["sections"][0]["content"].startswith("Record conditions")
    assert f.client.get(PREFIX + "/" + source["id"]).status_code == 404
    assert f.client.delete(PREFIX + "/templates/" + row["id"]).status_code == 404
    assert (
        f.client.put(
            PREFIX + "/templates/" + row["id"] + "/sharing", json={"shared": False}
        ).status_code
        == 404
    )
    forbidden = f.client.post(PREFIX + "/templates", json={**template, "name": "Not my source"})
    assert forbidden.status_code == 404
    f.login()
    revoked = f.client.put(PREFIX + "/templates/" + row["id"] + "/sharing", json={"shared": False})
    assert revoked.status_code == 200 and not revoked.json()["shared"]
    f.login("other")
    assert f.client.get(PREFIX + "/templates").json() == []
    f.login()
    assert f.client.delete(PREFIX + "/templates/" + row["id"]).status_code == 204


def test_private_templates_stay_private_and_shared_source_deletion_hides_them(solution_client):
    f = solution_client
    source = create(f)
    data = {"name": "Private", "sections": [{"id": "goal", "title": "Goal"}]}
    assert f.client.post(PREFIX + "/templates", json={**data, "shared": True}).status_code == 422
    created = f.client.post(
        PREFIX + "/templates", json={**data, "source_solution_id": source["id"]}
    ).json()
    assert not created["shared"]
    f.login("other")
    assert f.client.get(PREFIX + "/templates").json() == []
    f.login()
    shared = f.client.put(
        PREFIX + "/templates/" + created["id"] + "/sharing", json={"shared": True}
    )
    assert shared.status_code == 200 and shared.json()["shared"]
    assert (
        f.client.post(
            PREFIX + "/" + source["id"] + "/trash", json={"revision": source["revision"]}
        ).status_code
        == 204
    )
    f.login("other")
    assert f.client.get(PREFIX + "/templates").json() == []
