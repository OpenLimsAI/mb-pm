"""测试基础设施。

数据库选择：
  - 默认：临时 SQLite 文件（零依赖，CI / 本地随处可跑）。
  - 设置 ``TEST_DATABASE_URL`` 时改用该库（例如 PostgreSQL），用于复现
    issue #4 这种「仅 PostgreSQL 强制 VARCHAR(n) 长度」才会暴露的缺陷。

必须在导入任何 ``app.*`` 之前固化 ``DATABASE_URL``，因为
``app.core.config.settings`` 在模块导入时即读取环境变量。

认证：演示身份头已移除。测试用自签 RSA 密钥签发 Casdoor 形状的 RS256 token，
并把公钥预置进 JWKS 缓存，全程不访问真实 IAM。
"""

import os
import tempfile
import time

# —— 在导入 app 之前敲定数据库与种子开关 —— #
_TEST_DB_URL = os.environ.get("TEST_DATABASE_URL")
if _TEST_DB_URL:
    os.environ["DATABASE_URL"] = _TEST_DB_URL
else:
    _tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    _tmp.close()
    os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["AUTO_SEED"] = "false"  # 测试自备最小数据，不灌完整种子

from datetime import date, datetime, timezone  # noqa: E402
from uuid import uuid4  # noqa: E402

import pytest  # noqa: E402
from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from jose import jwk, jwt  # noqa: E402

from app.core import security  # noqa: E402
from app.core.config import settings  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.models import (  # noqa: E402
    IAMIdentity,
    Project,
    ProjectBaseline,
    ProjectFinance,
    ProjectMember,
    SubProject,
    Task,
    TaskDependency,
    User,
)


@pytest.fixture(scope="session")
def client():
    """进入上下文以触发 lifespan（create_all + _ensure_schema 建表）。"""
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def signing_pair():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )
    public = jwk.construct(
        key.public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
        ),
        "RS256",
    ).to_dict()
    public.update(kid="test-key", use="sig", alg="RS256")
    return private, public


@pytest.fixture
def token_factory(monkeypatch, signing_pair):
    """签发 Casdoor 形状的 access token；IAM 配置固定为测试值（不受本机 .env 影响）。"""
    monkeypatch.setattr(settings, "CASDOOR_ENDPOINT", "http://iam.test")
    monkeypatch.setattr(settings, "CASDOOR_INTERNAL_URL", "")
    monkeypatch.setattr(settings, "CASDOOR_JWKS_URL", "")
    monkeypatch.setattr(settings, "CASDOOR_CLIENT_ID", "pms-test")
    monkeypatch.setattr(settings, "CASDOOR_CLIENT_SECRET", "test-client-secret")
    monkeypatch.setattr(settings, "CASDOOR_ORG", "mabpharm")
    monkeypatch.setattr(settings, "PMS_PUBLIC_URL", "http://pms.test")
    monkeypatch.setattr(settings, "APP_SECRET", "test-encryption-key-only-for-tests-00000")
    security._jwks_cache.clear()
    security._jwks_cache[settings.casdoor_jwks_url] = (time.monotonic(), [signing_pair[1]])

    def make(role="admin", **overrides):
        claims = {
            "iss": settings.casdoor_issuer,
            "sub": role,
            "name": role,
            "aud": [settings.CASDOOR_CLIENT_ID],
            "exp": int(time.time()) + 3600,
            "owner": "mabpharm",
            "roles": [{"owner": "mabpharm", "name": role, "isEnabled": True}],
        }
        claims.update(overrides)
        return jwt.encode(claims, signing_pair[0], algorithm="RS256", headers={"kid": "test-key"})

    yield make
    security._jwks_cache.clear()


@pytest.fixture
def iam_user(client, token_factory):
    """幂等地建业务用户 + IAM 绑定（issuer 为测试 IAM，subject = 用户 ID）。"""

    def make(user_id: str, role: str) -> str:
        db = SessionLocal()
        try:
            if db.get(User, user_id) is None:
                db.add(
                    User(
                        id=user_id,
                        username=user_id,
                        display_name=user_id,
                        email=f"{user_id}@example.com",
                        role=role,
                        weekly_available_hours=40,
                        is_active=True,
                    )
                )
                db.flush()
            if db.get(IAMIdentity, (settings.casdoor_issuer, user_id)) is None:
                db.add(
                    IAMIdentity(issuer=settings.casdoor_issuer, subject=user_id, user_id=user_id)
                )
            db.commit()
        finally:
            db.close()
        return user_id

    return make


@pytest.fixture
def bearer(token_factory):
    """已绑定用户的 Authorization 头：bearer(用户 ID, IAM 角色)。"""

    def make(user_id: str, role: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {token_factory(role, sub=user_id, name=user_id)}"}

    return make


@pytest.fixture()
def admin_user(iam_user):
    return iam_user("t-admin", "admin")


@pytest.fixture()
def auth_headers(admin_user, bearer):
    return bearer(admin_user, "admin")


@pytest.fixture
def project_rows():
    """project_rows(项目 ID) → 项目及其全部从属记录的行数（断言级联删除 / 回滚用）。"""
    return _project_rows


def _project_rows(project_id: str) -> dict[str, int]:
    db = SessionLocal()
    try:
        sub_ids = [s.id for s in db.query(SubProject).filter_by(project_id=project_id)]
        task_ids = [t.id for t in db.query(Task).filter(Task.sub_project_id.in_(sub_ids))]
        return {
            "project": db.query(Project).filter_by(id=project_id).count(),
            "members": db.query(ProjectMember).filter_by(project_id=project_id).count(),
            "sub_projects": len(sub_ids),
            "tasks": len(task_ids),
            "dependencies": db.query(TaskDependency)
            .filter(
                TaskDependency.predecessor_id.in_(task_ids)
                | TaskDependency.successor_id.in_(task_ids)
            )
            .count(),
            "finances": db.query(ProjectFinance).filter_by(project_id=project_id).count(),
            "baselines": db.query(ProjectBaseline).filter_by(project_id=project_id).count(),
        }
    finally:
        db.close()


def _purge_project(project_id: str) -> None:
    db = SessionLocal()
    try:
        sub_ids = [s.id for s in db.query(SubProject).filter_by(project_id=project_id)]
        task_ids = [t.id for t in db.query(Task).filter(Task.sub_project_id.in_(sub_ids))]
        db.query(TaskDependency).filter(
            TaskDependency.predecessor_id.in_(task_ids) | TaskDependency.successor_id.in_(task_ids)
        ).delete(synchronize_session=False)
        db.query(Task).filter(Task.id.in_(task_ids)).delete(synchronize_session=False)
        for model in (SubProject, ProjectMember, ProjectFinance, ProjectBaseline):
            db.query(model).filter_by(project_id=project_id).delete(synchronize_session=False)
        db.query(Project).filter_by(id=project_id).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


@pytest.fixture
def project_factory(client):
    """建一个带子项目 / 2 个任务 + 依赖 / 团队成员 / 财务 / 基线的完整项目；用例结束后清理。"""
    created: list[str] = []

    def make(
        owner_id: str, member_ids: tuple[str, ...] = (), task_owner_id: str | None = None
    ) -> str:
        pid = f"tp-{uuid4().hex[:12]}"
        created.append(pid)
        db = SessionLocal()
        try:
            db.add(
                Project(
                    id=pid,
                    code=pid.upper(),
                    name="测试项目",
                    product_type="单抗",
                    current_stage="IND",
                    target_stage="Ph3",
                    owner_id=owner_id,
                    status="活跃",
                    health="green",
                    progress=0,
                    planned_start=date(2026, 1, 1),
                    planned_end=date(2026, 12, 31),
                )
            )
            db.flush()
            for uid in member_ids:
                db.add(ProjectMember(project_id=pid, user_id=uid))
            db.add(
                SubProject(
                    id=f"{pid}-sp",
                    name="测试子项目",
                    project_id=pid,
                    stage="IND",
                    module="USP",
                    status="进行中",
                )
            )
            db.flush()
            for n in (1, 2):
                db.add(
                    Task(
                        id=f"{pid}-t{n}",
                        code=f"T-{n}",
                        name=f"测试任务 {n}",
                        sub_project_id=f"{pid}-sp",
                        owner_id=task_owner_id or (member_ids[0] if member_ids else owner_id),
                        status="未开始",
                        priority="中",
                        planned_start=date(2026, 1, 1),
                        planned_end=date(2026, 6, 30),
                    )
                )
            db.flush()
            db.add(
                TaskDependency(
                    id=f"{pid}-dep",
                    predecessor_id=f"{pid}-t1",
                    successor_id=f"{pid}-t2",
                    type="FS",
                    lag_days=0,
                )
            )
            db.add(ProjectFinance(project_id=pid, total_budget=100, spent=10, committed=5))
            db.add(
                ProjectBaseline(
                    id=f"bl-{uuid4().hex[:10]}",
                    project_id=pid,
                    label="立项基线",
                    snapshot={},
                    created_by=owner_id,
                    created_at=datetime.now(timezone.utc),
                )
            )
            db.commit()
        finally:
            db.close()
        return pid

    yield make
    for pid in created:
        _purge_project(pid)
