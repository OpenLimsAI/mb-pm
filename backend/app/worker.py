"""Standalone queue runner with a container-local health endpoint."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

import app.models  # noqa: F401  Register ORM tables before starting workers.
from app.core.config import settings
from app.db.session import engine
from app.services.background_workers import running_workers

logging.basicConfig(level=settings.LOG_LEVEL)


@asynccontextmanager
async def lifespan(application: FastAPI):
    if settings.APP_PROCESS_ROLE != "worker":
        raise RuntimeError("app.worker:app requires APP_PROCESS_ROLE=worker")
    if settings.AUTO_MIGRATE_SCHEMA or settings.AUTO_SEED:
        raise RuntimeError("Worker startup requires AUTO_MIGRATE_SCHEMA=false and AUTO_SEED=false")

    with running_workers(shutdown_seconds=20) as workers:
        if not workers:
            raise RuntimeError("No background queue is enabled")
        application.state.workers = workers
        try:
            yield
        finally:
            application.state.workers = []


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


@app.get("/health")
def health(request: Request):
    workers = getattr(request.app.state, "workers", [])
    if not workers or not all(thread.is_alive() for _, thread in workers):
        raise HTTPException(503, "Background queue runner unavailable")
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
    except SQLAlchemyError:
        raise HTTPException(503, "Queue database unavailable") from None
    return {"status": "ok", "role": "worker"}
