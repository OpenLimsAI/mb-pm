"""项目管理成员与 IAM 对账（services/members.py）：独立内存库 + 替身 IAM 账号列表，不访问外部 IAM。"""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.config import settings
from app.db.base import Base
from app.models import IAMIdentity, User
from app.services import iam_admin, members

RECONCILE = members.reconcile_with_iam  # conftest 会把模块属性替换为空操作，这里保留真实实现


@pytest.fixture
def db(token_factory):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    session = Session(engine)
    yield session
    session.close()
    engine.dispose()


def add_member(db, user_id, *, subject=None, active=True, display=None):
    db.add(
        User(
            id=user_id,
            username=user_id,
            display_name=display or user_id,
            email=f"{user_id}@example.com",
            role="rd",
            is_active=active,
        )
    )
    db.flush()
    if subject:
        db.add(IAMIdentity(issuer=settings.casdoor_issuer, subject=subject, user_id=user_id))
    db.commit()


def iam(*accounts):
    return lambda: [{"owner": "mabpharm", **a} for a in accounts]


def test_reconcile_follows_iam_status_name_and_username(db, monkeypatch):
    add_member(db, "kept", subject="s-kept", display="旧名")
    add_member(db, "forbidden", subject="s-forbidden")
    add_member(db, "deleted", subject="s-deleted")
    add_member(db, "revived", subject="s-revived", active=False)
    add_member(db, "renamed", subject="s-renamed")
    add_member(db, "legacy")  # 未绑定的历史成员：不由对账处理
    monkeypatch.setattr(
        iam_admin,
        "list_users",
        iam(
            {"id": "s-kept", "name": "kept", "displayName": "新名"},
            {"id": "s-forbidden", "name": "forbidden", "isForbidden": True},
            {"id": "s-revived", "name": "revived"},
            {"id": "s-renamed", "name": "renamed.new"},
        ),
    )
    assert RECONCILE(db, force=True) > 0
    state = {u.id: (u.username, u.display_name, u.is_active) for u in db.query(User)}
    assert state["kept"] == ("kept", "新名", True)
    assert state["forbidden"][2] is False
    assert state["deleted"][2] is False
    assert state["revived"][2] is True
    assert state["renamed"][0] == "renamed.new"
    assert state["legacy"] == ("legacy", "legacy", True)
    assert RECONCILE(db, force=True) == 0  # 已一致时不再改动


def test_reconcile_keeps_username_when_taken(db, monkeypatch):
    add_member(db, "alpha", subject="s-alpha")
    add_member(db, "beta")
    monkeypatch.setattr(iam_admin, "list_users", iam({"id": "s-alpha", "name": "beta"}))
    RECONCILE(db, force=True)
    assert db.get(User, "alpha").username == "alpha"


def test_reconcile_is_throttled_and_survives_iam_outage(db, monkeypatch):
    add_member(db, "solo", subject="s-solo")
    calls = []

    def down():
        calls.append(1)
        raise RuntimeError("IAM unavailable")

    monkeypatch.setattr(iam_admin, "list_users", down)
    monkeypatch.setattr(members, "_last_reconcile", float("-inf"))
    assert RECONCILE(db) == 0 and RECONCILE(db) == 0
    assert len(calls) == 1  # 一分钟内不重复调用 IAM
    assert db.get(User, "solo").is_active  # IAM 不可用时不改名单
