"""TTL retention governance for ephemeral and ledger rows in `information_entries`."""

from __future__ import annotations

import logging
import threading
import time

from sqlalchemy import delete, select

from app.models.information import InformationEntry

logger = logging.getLogger("cmc-pms.knowledge-source-retention")

EPHEMERAL_GRACE_SECONDS = 86400  # 24 hours past expiry
LEDGER_RETENTION_SECONDS = 90 * 86400  # 90 days for audit and meter ledger rows
SWEEP_INTERVAL_SECONDS = 3600  # At most once per hour per worker process

_sweep_lock = threading.Lock()
_last_sweep_at: float = 0.0


def reset_sweep_timer() -> None:
    global _last_sweep_at
    with _sweep_lock:
        _last_sweep_at = 0.0


def prune_expired_entries(
    db, *, now: float | None = None, batch_limit: int = 500
) -> dict[str, int]:
    """Delete expired ephemeral tokens and aged audit/meter rows in bounded batches."""
    stamp = time.time() if now is None else now
    ephemeral_cutoff = stamp - EPHEMERAL_GRACE_SECONDS
    ledger_cutoff = stamp - LEDGER_RETENTION_SECONDS
    deleted_by_kind: dict[str, int] = {}

    # 1. Expired pairing codes (`fi_pair`), undo receipts (`ks_undo`), and delete plans (`ks_delete_plan`)
    ephemeral_rows = db.scalars(
        select(InformationEntry)
        .where(InformationEntry.kind.in_(["fi_pair", "ks_undo", "ks_delete_plan"]))
        .order_by(InformationEntry.updated_at.asc())
        .limit(batch_limit * 2)
    ).all()

    to_delete_ids: list[str] = []
    for row in ephemeral_rows:
        if len(to_delete_ids) >= batch_limit:
            break
        data = row.data if isinstance(row.data, dict) else {}
        expires = data.get("expires")
        if expires is None:
            expires = data.get("expiresAt")
        if isinstance(expires, int | float) and expires < ephemeral_cutoff:
            to_delete_ids.append(row.id)
            deleted_by_kind[row.kind] = deleted_by_kind.get(row.kind, 0) + 1

    if to_delete_ids:
        db.execute(delete(InformationEntry).where(InformationEntry.id.in_(to_delete_ids)))

    # 2. Aged audit (`audit`) and folder-import idempotency meter (`fi_meter`) rows (> 90 days)
    remaining = max(0, batch_limit - len(to_delete_ids))
    if remaining > 0:
        ledger_rows = db.scalars(
            select(InformationEntry)
            .where(
                InformationEntry.kind.in_(["audit", "fi_meter"]),
                InformationEntry.updated_at < ledger_cutoff,
            )
            .order_by(InformationEntry.updated_at.asc())
            .limit(remaining)
        ).all()
        if ledger_rows:
            ledger_ids = [row.id for row in ledger_rows]
            for row in ledger_rows:
                deleted_by_kind[row.kind] = deleted_by_kind.get(row.kind, 0) + 1
            db.execute(delete(InformationEntry).where(InformationEntry.id.in_(ledger_ids)))

    if deleted_by_kind:
        db.commit()
        logger.info("Pruned expired information_entries rows: %s", deleted_by_kind)
    return deleted_by_kind


def maybe_prune_expired_entries(db, *, now: float | None = None) -> dict[str, int]:
    """Rate-limited wrapper safe to invoke from background worker ticks."""
    global _last_sweep_at
    stamp = time.time() if now is None else now
    with _sweep_lock:
        if stamp - _last_sweep_at < SWEEP_INTERVAL_SECONDS:
            return {}
        _last_sweep_at = stamp
    try:
        return prune_expired_entries(db, now=stamp)
    except Exception:
        db.rollback()
        logger.warning("Periodic information_entries TTL sweep failed", exc_info=True)
        return {}
