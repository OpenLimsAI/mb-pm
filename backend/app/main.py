"""FastAPI 应用入口（CTO Lite 版）。

启动时：若使用 SQLite 且库为空，自动建表 + 灌入种子数据，做到「一条命令即可运行」。
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

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


@app.get("/", tags=["meta"])
def root():
    return {
        "name": "CMC-PMS Backend (CTO Lite)",
        "version": "0.1.0",
        "docs": "/docs",
    }
