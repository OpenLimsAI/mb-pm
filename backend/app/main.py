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
    auth, baselines, finances, projects, sub_projects, task_dependencies, tasks,
    templates, users,
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


@asynccontextmanager
async def lifespan(_: FastAPI):
    # 建表（SQLite 首次运行即创建文件）
    Base.metadata.create_all(bind=engine)

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


# —— 健康检查 —— #
@app.get("/health", tags=["meta"])
def health():
    return {"status": "ok", "env": settings.APP_ENV}


# —— v1 路由 —— #
API_PREFIX = "/api/v1"
app.include_router(auth.router, prefix=API_PREFIX)
app.include_router(users.router, prefix=API_PREFIX)
app.include_router(projects.router, prefix=API_PREFIX)
app.include_router(sub_projects.router, prefix=API_PREFIX)
app.include_router(tasks.router, prefix=API_PREFIX)
app.include_router(task_dependencies.router, prefix=API_PREFIX)
app.include_router(templates.router, prefix=API_PREFIX)
app.include_router(finances.router, prefix=API_PREFIX)
app.include_router(baselines.router, prefix=API_PREFIX)


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
    _assets = _STATIC / "assets"
    if _assets.is_dir():
        app.mount("/assets", StaticFiles(directory=_assets), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa_fallback(full_path: str):
        # API / 文档保持 JSON 404，不被 SPA 兜底吞掉
        if full_path.startswith(("api/", "api", "docs", "redoc", "openapi.json", "health")):
            raise HTTPException(status_code=404, detail="Not Found")
        # 命中真实静态文件（favicon.svg 等）则直接返回，否则回退 index.html 交给前端路由
        candidate = _STATIC / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(_STATIC / "index.html")

    logger.info("前端 SPA 已挂载 ← %s", _STATIC)
