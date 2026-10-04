"""FastAPI 应用入口（CTO Lite 版）。

启动时：若使用 SQLite 且库为空，自动建表 + 灌入种子数据，做到「一条命令即可运行」。
"""

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import app.models  # noqa: F401  确保所有 ORM 表注册到 Base.metadata
from app.api.v1 import (
    account,
    ai,
    auth,
    baselines,
    finances,
    portal,
    projects,
    sub_projects,
    task_dependencies,
    tasks,
    templates,
    users,
)
from app.core.config import settings
from app.db.base import Base
from app.db.session import SessionLocal, engine
from app.models import User

logging.basicConfig(level=settings.LOG_LEVEL)
logger = logging.getLogger("cmc-pms")

# 已构建的前端 SPA 目录（容器内为 /code/static）；存在则由后端同源托管。
_STATIC = Path(settings.STATIC_DIR) if settings.STATIC_DIR else None
_HAS_SPA = bool(_STATIC and (_STATIC / "index.html").is_file())


# 需容纳前端拼接式组合 ID（`${projectId}-${childCode}`）的主键/外键列（issue #4）。
# 新库由 create_all 直接建成 VARCHAR(64)；此处负责把「已存在的老库」就地加宽。
_TARGET_ID_LEN = 64
_WIDE_ID_COLUMNS: tuple[tuple[str, str], ...] = (
    ("projects", "id"),
    ("project_members", "project_id"),
    ("project_finances", "project_id"),
    ("project_baselines", "project_id"),
    ("sub_projects", "id"),
    ("sub_projects", "project_id"),
    ("tasks", "id"),
    ("tasks", "sub_project_id"),
    ("task_dependencies", "id"),
    ("task_dependencies", "predecessor_id"),
    ("task_dependencies", "successor_id"),
)


# (表, 列, 类型) —— 后来新增、老库里可能缺失的列（create_all 不会给已存在的表补列）。
_ADDED_COLUMNS: tuple[tuple[str, str, str], ...] = (
    ("tasks", "cost_budget", "NUMERIC(12,2)"),
    ("tasks", "actual_cost", "NUMERIC(12,2)"),
    ("project_ai_analyses", "prompt", "TEXT NOT NULL DEFAULT ''"),
)


def _ensure_schema() -> None:
    """轻量「迁移」：为已存在的表补齐新增列 / 加宽过窄的 ID 列（无 alembic 时的兜底）。
    create_all 不会改动已存在的表，故老库需要在此处 ALTER。幂等：满足目标则跳过。"""
    from sqlalchemy import inspect as sa_inspect
    from sqlalchemy import text

    insp = sa_inspect(engine)
    existing_tables = set(insp.get_table_names())
    for table, col, ddl in _ADDED_COLUMNS:
        if table not in existing_tables:
            continue  # 新库由 create_all 直接带上新列
        if col not in {c["name"] for c in insp.get_columns(table)}:
            with engine.begin() as conn:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}"))
            logger.info("已为 %s 表补充 %s 列", table, col)

    # —— 加宽组合 ID 列（issue #4）—— #
    # SQLite 不强制 VARCHAR(n) 长度，也不支持 ALTER COLUMN ... TYPE，直接跳过。
    if engine.dialect.name == "sqlite":
        return
    for table, col in _WIDE_ID_COLUMNS:
        if table not in existing_tables:
            continue
        meta = {c["name"]: c for c in insp.get_columns(table)}.get(col)
        if meta is None:
            continue
        length = getattr(meta["type"], "length", None)
        if length is not None and length < _TARGET_ID_LEN:
            with engine.begin() as conn:
                conn.execute(
                    text(f"ALTER TABLE {table} ALTER COLUMN {col} TYPE VARCHAR({_TARGET_ID_LEN})")
                )
            logger.info("已加宽 %s.%s → VARCHAR(%d)（issue #4）", table, col, _TARGET_ID_LEN)


@asynccontextmanager
async def lifespan(_: FastAPI):
    # 建表（SQLite 首次运行即创建文件）
    Base.metadata.create_all(bind=engine)
    # 老库补齐新增列
    _ensure_schema()

    # 库为空则灌种子（幂等：已有数据时不覆盖用户编辑/新建项目）
    if settings.AUTO_SEED:
        db = SessionLocal()
        try:
            empty = db.query(User).first() is None
        finally:
            db.close()
        if empty:
            from app.seed.seed_data import seed

            logger.info("数据库为空 → 灌入种子数据 ...")
            seed()
        else:
            logger.info("数据库已有数据 → 跳过种子")
    yield


app = FastAPI(
    title="CMC-PMS Backend (CTO Lite)",
    description="CMC 项目管理系统 — CTO 决策视图后端（URS-CMC-PMS-001）",
    version="0.1.0",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def prevent_auth_response_caching(request, call_next):
    # API 响应均依赖登录身份：禁止缓存，且不向外泄露 Referer。
    response = await call_next(request)
    if request.url.path.startswith("/api/v1/"):
        response.headers["Cache-Control"] = "no-store"
        response.headers["Referrer-Policy"] = "no-referrer"
    return response


# —— 健康检查 —— #
@app.get("/health", tags=["meta"])
def health():
    return {"status": "ok", "env": settings.APP_ENV}


# —— v1 路由 —— #
API_PREFIX = "/api/v1"
app.include_router(auth.router, prefix=API_PREFIX)
app.include_router(portal.router, prefix=API_PREFIX)
app.include_router(account.router, prefix=API_PREFIX)
app.include_router(users.router, prefix=API_PREFIX)
app.include_router(projects.router, prefix=API_PREFIX)
app.include_router(sub_projects.router, prefix=API_PREFIX)
app.include_router(tasks.router, prefix=API_PREFIX)
app.include_router(task_dependencies.router, prefix=API_PREFIX)
app.include_router(templates.router, prefix=API_PREFIX)
app.include_router(finances.router, prefix=API_PREFIX)
app.include_router(baselines.router, prefix=API_PREFIX)
app.include_router(ai.router, prefix=API_PREFIX)


@app.get("/", include_in_schema=False)
def root():
    # 托管前端时根路径返回 SPA；纯 API 模式返回服务元信息。
    if _HAS_SPA:
        return FileResponse(_STATIC / "index.html")
    return {
        "name": "CMC-PMS Backend (CTO Lite)",
        "version": "0.1.0",
        "docs": "/docs",
    }


# —— 前端 SPA 同源托管（仅当 STATIC_DIR 指向已构建产物时启用）—— #
# 顺序很关键：先注册了上面的 /api、/health、/docs 等路由，再挂载静态与兜底，
# 因此具体路由优先匹配，剩余路径才落到 SPA。
if _HAS_SPA:
    _static_root = _STATIC.resolve()
    _assets = _static_root / "assets"
    if _assets.is_dir():
        app.mount("/assets", StaticFiles(directory=_assets), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa_fallback(full_path: str):
        # API / 文档保持 JSON 404，不被 SPA 兜底吞掉
        if full_path.startswith(("api/", "api", "docs", "redoc", "openapi.json", "health")):
            raise HTTPException(status_code=404, detail="Not Found")
        # 命中真实静态文件（favicon.svg 等）则直接返回，否则回退 index.html 交给前端路由。
        # 先把请求路径解析为绝对路径并校验其仍位于静态根目录内，阻止 ../ 目录遍历
        # 读取静态目录之外的任意文件（如 /etc/passwd）。
        try:
            candidate = (_static_root / full_path).resolve()
        except (OSError, RuntimeError, ValueError):
            return FileResponse(_static_root / "index.html")
        if full_path and candidate.is_file() and _static_root in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(_static_root / "index.html")

    logger.info("前端 SPA 已挂载 ← %s", _static_root)
