"""测试基础设施。

数据库选择：
  - 默认：临时 SQLite 文件（零依赖，CI / 本地随处可跑）。
  - 设置 ``TEST_DATABASE_URL`` 时改用该库（例如 PostgreSQL），用于复现
    issue #4 这种「仅 PostgreSQL 强制 VARCHAR(n) 长度」才会暴露的缺陷。

必须在导入任何 ``app.*`` 之前固化 ``DATABASE_URL``，因为
``app.core.config.settings`` 在模块导入时即读取环境变量。
"""

import os
import tempfile

# —— 在导入 app 之前敲定数据库与种子开关 —— #
_TEST_DB_URL = os.environ.get("TEST_DATABASE_URL")
if _TEST_DB_URL:
    os.environ["DATABASE_URL"] = _TEST_DB_URL
else:
    _tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    _tmp.close()
    os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["AUTO_SEED"] = "false"  # 测试自备最小数据，不灌完整种子

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.db.session import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.models import User  # noqa: E402


@pytest.fixture(scope="session")
def client():
    """进入上下文以触发 lifespan（create_all + _ensure_schema 建表）。"""
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def admin_user(client):
    """确保存在一个 admin 用户（用 DemoUser 头免密登录）。"""
    db = SessionLocal()
    try:
        user = db.query(User).filter_by(username="t-admin").first()
        if user is None:
            user = User(
                id="t-admin",
                username="t-admin",
                display_name="测试管理员",
                email="t-admin@example.com",
                role="admin",
                weekly_available_hours=40,
                is_active=True,
            )
            db.add(user)
            db.commit()
    finally:
        db.close()
    return "t-admin"


@pytest.fixture()
def auth_headers(admin_user):
    return {"Authorization": f"DemoUser {admin_user}"}
