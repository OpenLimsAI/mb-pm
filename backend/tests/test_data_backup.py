"""Admin-only real backup inventory and confirmed selected deletion contract."""

import hashlib
import hmac
import json
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
import test_solutions
from fastapi import HTTPException

from app.api.v1 import data_backup, portal
from app.core.config import settings
from app.schemas.data_backup import DeletePreviewInput, DeletionInput, PlanInput
from app.services import accounts, iam_admin, password_policy
from app.services import data_backup as service

solution_client = test_solutions.solution_client
PREFIX = "/api/v1/data-backup"
ARCHIVE = "a" * 64
REVISION = "b" * 64
TOKEN = "p" * 43
SECRET = "synthetic-backup-test-secret-not-for-production"


def item(**changes):
    return (
        dict(
            id=ARCHIVE,
            name="maibo-20261104T012707Z.tar.gz.gpg",
            rootLabel="每日备份",
            sizeBytes=2500,
            diskBytes=4096,
        )
        | changes
    )


def receipt(**changes):
    return (
        dict(
            id="deletion-1",
            actor="author",
            createdAt=None,
            status="succeeded",
            deletedCount=1,
            deletedBytes=2500,
            error=None,
        )
        | changes
    )


def preview(**changes):
    return (
        dict(
            token=TOKEN,
            itemCount=1,
            sizeBytes=2500,
            diskBytes=4096,
            items=[item()],
            expiresAt="2026-11-04T12:10:00Z",
        )
        | changes
    )


def snapshot(**changes):
    return (
        dict(
            connected=True,
            generatedAt="2026-11-04T12:00:00Z",
            catalogRevision=REVISION,
            plan=dict(
                status="active",
                source="cron",
                timezone="Asia/Shanghai",
                summary="每天03:30",
                retentionSummary="至少14天和14份",
                checkedAt=None,
            ),
            storage=dict(
                totalBytes=200000,
                freeBytes=100000,
                backupBytes=8192,
                archiveBytes=4096,
                otherBytes=4096,
            ),
            roots=[
                dict(
                    id="daily",
                    label="每日备份",
                    archiveCount=1,
                    sizeBytes=2500,
                    diskBytes=4096,
                    otherBytes=4096,
                )
            ],
            archives=[
                item(
                    createdAt=None,
                    status="verified",
                    contents=[dict(name="项目管理", kind="database", detail="数据库")],
                    verifiedAt=None,
                    protected=False,
                    protectionReason=None,
                )
            ],
            deletions=[receipt()],
            alerts=[],
        )
        | changes
    )


def selection(**changes):
    return dict(archiveIds=[ARCHIVE], catalogRevision=REVISION) | changes


def plan_change(**changes):
    return dict(dailyTime="04:23", enabled=True, revision=REVISION) | changes


def deletion(**changes):
    return dict(token=TOKEN, confirmation="删除 1 份备份", requestId=str(uuid4())) | changes


@pytest.fixture
def backup_client(solution_client, monkeypatch):
    f = solution_client
    f.client.app.include_router(data_backup.router, prefix="/api/v1")
    f.client.headers["X-Backup-Expected-Identity"] = "author"
    state = {"roles": {"admin"}, "disabled": False}

    def account(_):
        return {
            "isForbidden": state["disabled"],
            "roles": [
                {"owner": settings.CASDOOR_ORG, "name": r, "isEnabled": True}
                for r in state["roles"]
            ],
        }

    monkeypatch.setattr(iam_admin, "get_user_by_sub", account)
    calls = []

    def agent(method, path, body=None):
        calls.append((method, path, body))
        if path == "/v1/snapshot":
            return snapshot()
        if path == "/v1/delete-preview":
            return preview()
        if path == "/v1/plan":
            return snapshot()["plan"] | dict(editable=True, dailyTime=body["dailyTime"], revision="c" * 64, status="active" if body["enabled"] else "disabled")
        return receipt(actor=body["actor"])

    monkeypatch.setattr(service, "request", agent)
    return SimpleNamespace(**vars(f), state=state, calls=calls)


def test_live_admin_only_and_revocation(backup_client):
    f = backup_client
    assert f.client.get(PREFIX + "/snapshot").status_code == 200
    for roles in [{"cmc_lead"}, {"project_lead"}, {"kb_manager"}, set()]:
        f.state["roles"] = roles
        for method, path, body in [
            ("get", "/snapshot", None),
            ("post", "/delete-preview", selection()),
            ("post", "/deletions", deletion()),
            ("post", "/plan", plan_change()),
        ]:
            response = getattr(f.client, method)(PREFIX + path, **({"json": body} if body else {}))
            assert response.status_code == 403 and response.headers["cache-control"] == "no-store"
    f.state.update(roles={"admin"}, disabled=True)
    assert f.client.get(PREFIX + "/snapshot").status_code == 403
    assert len(f.calls) == 1


@pytest.mark.parametrize(
    "path,body", [("/delete-preview", selection()), ("/deletions", deletion()), ("/plan", plan_change())]
)
def test_account_switch_blocks_both_mutations(backup_client, path, body):
    for value in ["another-admin", ""]:
        response = backup_client.client.post(
            PREFIX + path, json=body, headers={"X-Backup-Expected-Identity": value}
        )
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "backup_identity_changed"
        assert response.headers["cache-control"] == "no-store"
    assert not backup_client.calls


def test_portal_session_identity_and_password_guard(backup_client, monkeypatch):
    f = backup_client
    f.client.headers.pop("X-Backup-Expected-Identity")
    assert f.client.get(PREFIX + "/snapshot").status_code == 409
    f.client.headers["X-Backup-Expected-Identity"] = "author"

    def required(*_):
        raise HTTPException(403, password_policy.CHANGE_FIRST)

    enforce = password_policy.enforce
    monkeypatch.setattr(password_policy, "enforce", required)
    assert f.client.get(PREFIX + "/snapshot").status_code == 403
    monkeypatch.setattr(password_policy, "enforce", enforce)
    f.client.cookies.clear()
    response = f.client.get(
        PREFIX + "/snapshot", headers={"Authorization": "Bearer not-a-portal-session"}
    )
    assert response.status_code == 401 and response.headers["cache-control"] == "no-store"
    assert not f.calls


@pytest.mark.parametrize("origin", [None, "https://evil.example", "http://localhost:9999"])
def test_write_requires_exact_portal_origin(backup_client, origin):
    f = backup_client
    f.client.headers.pop("Origin")
    for path, body in [("/delete-preview", selection()), ("/deletions", deletion()), ("/plan", plan_change())]:
        response = f.client.post(
            PREFIX + path, json=body, headers={} if origin is None else {"Origin": origin}
        )
        assert response.status_code == 403 and response.headers["cache-control"] == "no-store"
    assert not f.calls


def test_iam_failure_fails_closed_without_leaking_errors(backup_client, monkeypatch):
    def unavailable(_):
        raise iam_admin.IAMError("private-token /srv/private/auth-secret")

    monkeypatch.setattr(accounts, "live_roles", unavailable)
    response = backup_client.client.get(PREFIX + "/snapshot")
    assert response.status_code == 503 and "private" not in response.text
    assert not backup_client.calls


def test_explicit_deletion_actor_binding_and_no_cache(backup_client):
    f = backup_client
    for path, body in [("/delete-preview", selection()), ("/deletions", deletion()), ("/plan", plan_change())]:
        response = f.client.post(PREFIX + path, json=body)
        assert response.status_code == 200, response.text
        assert response.headers["cache-control"] == "no-store"
        assert f.calls[-1] == ("POST", "/v1" + path, body | {"actor": "author"})
        if path == "/deletions":
            assert response.json() == receipt()
    assert f.calls[-1][1] == "/v1/plan"
    assert response.json()["dailyTime"] == "04:23"
    assert response.json()["editable"] is True


@pytest.mark.parametrize(
    "path,method",
    [
        ("/jobs", "post"),
        ("/jobs", "get"),
        ("/policy", "get"),
        ("/policy", "put"),
        ("/backup", "post"),
        ("/restore-check", "post"),
        ("/cleanup", "post"),
    ],
)
def test_removed_execution_and_policy_routes_are_unavailable(backup_client, path, method):
    response = getattr(backup_client.client, method)(PREFIX + path)
    assert response.status_code == 404
    assert not backup_client.calls


@pytest.mark.parametrize(
    "change",
    [
        {"archiveIds": []},
        {"archiveIds": [ARCHIVE] * 101},
        {"archiveIds": [ARCHIVE, ARCHIVE]},
        {"archiveIds": ["/private/file"]},
        {"archiveIds": ["A" * 64]},
        {"archiveIds": [7]},
        {"catalogRevision": ""},
        {"catalogRevision": "../../etc/passwd"},
        {"actor": "forged"},
        {"command": "docker stop"},
        {"archive_ids": [ARCHIVE]},
    ],
)
def test_selection_inputs_are_strict(backup_client, change):
    response = backup_client.client.post(PREFIX + "/delete-preview", json=selection(**change))
    assert response.status_code == 422 and response.headers["cache-control"] == "no-store"
    assert not backup_client.calls


@pytest.mark.parametrize(
    "change",
    [
        {"token": "short"},
        {"token": "x" * 257},
        {"token": "/private/" + "x" * 32},
        {"confirmation": "yes"},
        {"confirmation": "删除 0 份备份"},
        {"confirmation": "删除 101 份备份"},
        {"confirmation": "删除 01 份备份"},
        {"requestId": "not-uuid"},
        {"actor": "forged"},
        {"archiveIds": [ARCHIVE]},
        {"directory": "/tmp"},
        {"request_id": str(uuid4())},
    ],
)
def test_deletion_inputs_are_strict(backup_client, change):
    response = backup_client.client.post(PREFIX + "/deletions", json=deletion(**change))
    assert response.status_code == 422 and response.headers["cache-control"] == "no-store"
    assert not backup_client.calls


def test_input_validation_does_not_echo_secrets(backup_client):
    response = backup_client.client.post(
        PREFIX + "/deletions", json=deletion(token=SECRET + "/private")
    )
    assert response.status_code == 422 and SECRET not in response.text


def test_portal_entitlement_is_admin_only(backup_client):
    for roles, expected in [
        ({"admin"}, True),
        ({"cmc_lead"}, False),
        ({"kb_manager"}, False),
        (set(), False),
    ]:
        claims = {
            "sub": "author",
            "name": "author",
            "roles": [{"name": role, "owner": settings.CASDOOR_ORG} for role in roles],
        }
        item = next(
            a for a in portal.applications(claims, backup_client.db) if a.id == "data-backup"
        )
        assert item.enabled is expected


@pytest.mark.parametrize(
    "method,path",
    [
        ("POST", "/v1/jobs"),
        ("PUT", "/v1/policy"),
        ("GET", "/v1/secret"),
        ("DELETE", "/v1/deletions"),
    ],
)
def test_transport_never_forwards_removed_or_arbitrary_operations(method, path):
    with pytest.raises(ValueError):
        service.request(method, path)


@pytest.fixture
def transport(monkeypatch):
    monkeypatch.setattr(settings, "DATA_BACKUP_AGENT_URL", "http://backup-agent:8127")
    monkeypatch.setattr(settings, "DATA_BACKUP_AGENT_SECRET", SECRET)
    real = httpx.Client
    seen = []
    options = []
    reply = {"status": 200, "json": snapshot()}

    def handler(request):
        seen.append(request)
        if "exception" in reply:
            raise reply["exception"]
        response = reply.get("response") or httpx.Response(reply["status"], json=reply["json"])
        if not response.is_stream_consumed:
            return response
        return httpx.Response(
            response.status_code,
            headers=response.headers,
            stream=httpx.ByteStream(response.content),
        )

    def client(**kwargs):
        options.append(kwargs)
        return real(**kwargs, transport=httpx.MockTransport(handler))

    monkeypatch.setattr(httpx, "Client", client)
    return SimpleNamespace(seen=seen, options=options, reply=reply)


def test_hmac_uses_exact_body_path_and_fresh_nonce(transport):
    f = transport
    service.snapshot()
    f.reply["json"] = preview()
    service.delete_preview(DeletePreviewInput.model_validate(selection()), "author")
    f.reply["json"] = receipt()
    service.delete_archives(DeletionInput.model_validate(deletion()), "author")
    f.reply["json"] = snapshot()["plan"] | dict(editable=True, dailyTime="04:23", revision=REVISION)
    service.update_plan(PlanInput.model_validate(plan_change()), "author")
    assert len(f.seen) == 4
    for request in f.seen:
        headers = request.headers
        canonical = "\n".join(
            (
                request.method,
                request.url.path,
                headers["x-backup-time"],
                headers["x-backup-nonce"],
                hashlib.sha256(request.content).hexdigest(),
            )
        )
        expected = hmac.new(SECRET.encode(), canonical.encode(), hashlib.sha256).hexdigest()
        assert hmac.compare_digest(headers["x-backup-signature"], expected)
        assert len(headers["x-backup-nonce"]) == 32
        assert SECRET not in str(request.url) and SECRET.encode() not in request.content
    assert f.seen[0].content == b""
    assert len({r.headers["x-backup-nonce"] for r in f.seen}) == 4
    assert all(json.loads(r.content)["actor"] == "author" for r in f.seen[1:])
    assert all(
        o["trust_env"] is False
        and o["follow_redirects"] is False
        and o["timeout"].read == service.TIMEOUT_SECONDS
        for o in f.options
    )


@pytest.mark.parametrize(
    "url",
    [
        "https://user:pass@private.example",
        "http://8.8.8.8:81",
        "http://0.0.0.0:81",
        "http://backup-agent/path",
        "http://backup-agent?token=secret",
        "http://backup-agent/#secret",
        "file:///tmp/private",
        "http://backup-agent:99999",
        "http://bad host",
    ],
)
def test_bad_agent_config_never_sends(url, transport, monkeypatch):
    monkeypatch.setattr(settings, "DATA_BACKUP_AGENT_URL", url)
    with pytest.raises(HTTPException) as caught:
        service.snapshot()
    assert caught.value.status_code == 503 and not transport.seen


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:8127",
        "http://172.18.0.1:8127",
        "http://host.docker.internal:8127",
        "https://backup.example",
    ],
)
def test_private_http_or_tls_agent_urls(url, transport, monkeypatch):
    monkeypatch.setattr(settings, "DATA_BACKUP_AGENT_URL", url)
    assert service.snapshot()["connected"] is True


def test_unconfigured_is_error_not_empty_success(transport, monkeypatch):
    for url, secret in [("", SECRET), ("http://backup-agent", "short")]:
        monkeypatch.setattr(settings, "DATA_BACKUP_AGENT_URL", url)
        monkeypatch.setattr(settings, "DATA_BACKUP_AGENT_SECRET", secret)
        with pytest.raises(HTTPException) as caught:
            service.snapshot()
        assert caught.value.status_code == 503
    assert not transport.seen


@pytest.mark.parametrize(
    "code,expected",
    [(code, value[0]) for code, value in service.ERRORS.items()] + [("not-public", 502)],
)
def test_safe_upstream_errors(transport, code, expected):
    transport.reply.update(
        status=409, json={"error": {"code": code, "message": "secret /private/key"}}
    )
    with pytest.raises(HTTPException) as caught:
        service.snapshot()
    assert caught.value.status_code == expected
    assert "private" not in str(caught.value.detail)
    if code in service.ERRORS:
        assert caught.value.detail == {"code": code, "message": service.ERRORS[code][1]}


@pytest.mark.parametrize("status", [401, 403, 500, 503])
def test_upstream_fault_is_not_browser_logout(transport, status):
    transport.reply.update(status=status, json={"error": {"code": "private", "message": SECRET}})
    with pytest.raises(HTTPException) as caught:
        service.snapshot()
    assert caught.value.status_code == 503
    assert SECRET not in str(caught.value.detail)


@pytest.mark.parametrize("code", list(service.ERRORS) + ["private-secret"])
@pytest.mark.parametrize("model", [service.Deletion, service.Snapshot])
def test_public_deletion_reasons_are_allowlisted(model, code):
    result = service._public(
        model,
        snapshot(deletions=[receipt(error=code)])
        if model is service.Snapshot
        else receipt(error=code),
    )
    item = result["deletions"][0] if model is service.Snapshot else result
    assert item["error"] == service.ERRORS.get(code, (502, service.UNKNOWN_DELETION_ERROR))[1]
    assert "private" not in json.dumps(result)


def test_response_schema_strips_extra_diagnostics(transport):
    transport.reply["json"] = snapshot(
        secret=SECRET,
        directory="/private/path",
        deletions=[receipt(stderr="private stderr", error="private-secret")],
    )
    output = service.snapshot()
    assert SECRET not in json.dumps(output) and "private" not in json.dumps(output)
    transport.reply["json"] = {"connected": True}
    with pytest.raises(HTTPException) as caught:
        service.snapshot()
    assert caught.value.status_code == 502


@pytest.mark.parametrize(
    "change",
    [
        {"itemCount": 2},
        {"sizeBytes": 0},
        {"diskBytes": 0},
        {"items": [item(id="c" * 64)]},
        {"items": [item(), item()]},
    ],
)
def test_preview_response_must_match_exact_selection_and_totals(transport, change):
    transport.reply["json"] = preview(**change)
    with pytest.raises(HTTPException) as caught:
        service.delete_preview(DeletePreviewInput.model_validate(selection()), "author")
    assert caught.value.status_code == 502


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(302, headers={"location": "http://public.invalid/secret"}),
        httpx.Response(200, content=b"not json"),
        httpx.Response(200, json=[]),
        httpx.Response(
            200, content=b"{}", headers={"content-length": str(service.MAX_RESPONSE_BYTES + 1)}
        ),
        httpx.Response(200, content=b"x" * (service.MAX_RESPONSE_BYTES + 1)),
    ],
)
def test_invalid_redirect_or_oversized_response_is_bounded(transport, response):
    transport.reply["response"] = response
    with pytest.raises(HTTPException) as caught:
        service.snapshot()
    assert caught.value.status_code == 502 and len(transport.seen) == 1


@pytest.mark.parametrize(
    "exception,expected",
    [(httpx.ReadTimeout("secret"), 504), (httpx.ConnectError("privatehost token"), 503)],
)
def test_network_errors_are_sanitized(transport, exception, expected):
    transport.reply["exception"] = exception
    with pytest.raises(HTTPException) as caught:
        service.snapshot()
    assert caught.value.status_code == expected and "secret" not in str(caught.value.detail)


def test_unconfigured_api_is_no_store_503(backup_client, monkeypatch):
    def unavailable():
        raise HTTPException(503, "数据备份服务尚未配置")

    monkeypatch.setattr(service, "snapshot", unavailable)
    response = backup_client.client.get(PREFIX + "/snapshot")
    assert response.status_code == 503 and response.headers["cache-control"] == "no-store"
    assert "connected" not in response.json()


def test_unexpected_failure_does_not_expose_exception(backup_client, monkeypatch):
    def broken():
        raise RuntimeError("private secret /srv/backup.key")

    monkeypatch.setattr(service, "snapshot", broken)
    response = backup_client.client.get(PREFIX + "/snapshot")
    assert response.status_code == 500 and response.headers["cache-control"] == "no-store"
    assert "private" not in response.text


def test_streamed_body_without_length_stops_at_limit(transport):
    class Pieces(httpx.SyncByteStream):
        consumed = 0

        def __iter__(self):
            for _ in range(10):
                self.consumed += 1
                yield b"x" * (service.MAX_RESPONSE_BYTES // 2)

    stream = Pieces()
    transport.reply["response"] = httpx.Response(200, stream=stream)
    with pytest.raises(HTTPException) as caught:
        service.snapshot()
    assert caught.value.status_code == 502
    assert stream.consumed == 3


def test_elapsed_deadline_is_enforced(transport, monkeypatch):
    monkeypatch.setattr(service, "TIMEOUT_SECONDS", 0)
    with pytest.raises(HTTPException) as caught:
        service.snapshot()
    assert caught.value.status_code == 504


@pytest.mark.parametrize(
    "change",
    [
        {"dailyTime": "24:00"},
        {"dailyTime": "7:03"},
        {"dailyTime": "02:17\n* * * * * evil"},
        {"dailyTime": 217},
        {"enabled": "false"},
        {"enabled": 1},
        {"revision": ""},
        {"actor": "forged-admin"},
        {"command": "evil"},
        {"timezone": "UTC"},
        {"retentionDays": 2},
    ],
)
def test_plan_update_has_strict_bounded_input(backup_client, change):
    response = backup_client.client.post(PREFIX + "/plan", json=plan_change(**change))
    assert response.status_code == 422 and response.headers["cache-control"] == "no-store"
    assert not backup_client.calls


def test_plan_compatibility_with_previous_agent_is_readonly(transport):
    result = service.snapshot()
    assert result["plan"]["editable"] is False
    assert result["plan"]["dailyTime"] is None
    assert result["plan"]["revision"] is None
    assert result["plan"]["nextRunAt"] is None
    assert result["archives"][0]["rootId"] == ""


def test_plan_write_safe_response_strips_private_audit(transport):
    transport.reply["json"] = snapshot()["plan"] | dict(
        editable=True, dailyTime="04:23", revision=REVISION, nextRunAt="2026-11-07T20:23:00Z",
        before_text="private cron", after_text="secret --key /private/key", actor="admin",
    )
    result = service.update_plan(PlanInput.model_validate(plan_change()), "author")
    assert result["editable"] is True and result["dailyTime"] == "04:23"
    assert "private" not in json.dumps(result) and "secret" not in json.dumps(result)
    assert json.loads(transport.seen[0].content) == plan_change() | {"actor": "author"}
