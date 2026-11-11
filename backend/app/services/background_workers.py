"""Shared lifecycle for the existing durable background queues."""

import logging
from contextlib import contextmanager
from time import monotonic

from app.core.config import settings

logger = logging.getLogger(__name__)


@contextmanager
def running_workers(shutdown_seconds: int = 5):
    workers = []
    try:
        if settings.INFORMATION_APP_ENABLED and settings.INFORMATION_WORKER_ENABLED:
            from app.services.information.worker import start_worker

            workers.append(start_worker())
        from app.services.project_ai_jobs import start_worker as start_project_ai_worker

        if worker := start_project_ai_worker():
            workers.append(worker)
        from app.services.pm_ai_runs import start_worker as start_pm_ai_worker

        if worker := start_pm_ai_worker():
            workers.append(worker)
        if settings.ASSISTANT_REQUEST_WORKER_ENABLED:
            from app.services.assistant_requests import start_worker as start_assistant_worker

            workers.append(start_assistant_worker())
        if settings.KNOWLEDGE_SOURCE_APP_ENABLED and settings.KNOWLEDGE_SOURCE_WORKER_ENABLED:
            from app.services.knowledge_source_worker import (
                start_worker as start_knowledge_source_worker,
            )

            workers.append(start_knowledge_source_worker())
        if settings.NOTES_WISDOM_WORKER_ENABLED:
            from app.services.note_sync import start_worker as start_notes_worker

            workers.append(start_notes_worker())
        yield workers
    finally:
        for stop, _ in workers:
            stop.set()
        deadline = monotonic() + shutdown_seconds
        for _, thread in workers:
            thread.join(timeout=max(0, deadline - monotonic()))
            if thread.is_alive():
                logger.warning("Background worker did not finish before shutdown: %s", thread.name)
