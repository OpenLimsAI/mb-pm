"""widen id columns to VARCHAR(64) (issue #4)

Revision ID: 002
Revises: 001
Create Date: 2026-06-27 00:00:00

前端基于模板实例化时，把层级 ID 拼成 `${projectId}-${childCode}`（见
src/lib/instantiate.ts），组合后可达 ~30 字符，超过最初的 VARCHAR(20)。
PostgreSQL 强制 VARCHAR(n) 长度，导致 POST /projects/import 在写
sub_projects / tasks 时抛 StringDataRightTruncation → 500。

本迁移把项目→子项目→任务→依赖链路及其跨表外键统一加宽到 VARCHAR(64)。
（SQLite 不强制长度且不支持 ALTER COLUMN ... TYPE，故仅在非 SQLite 上执行。）
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "002"
down_revision: str | None = "001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW_LEN = 64

# (表, 列, 原宽度) —— 仅含初始迁移 001 创建的表。
_COLUMNS: tuple[tuple[str, str, int], ...] = (
    ("projects", "id", 20),
    ("project_members", "project_id", 20),
    ("sub_projects", "id", 20),
    ("sub_projects", "project_id", 20),
    ("tasks", "id", 20),
    ("tasks", "sub_project_id", 20),
    ("task_dependencies", "id", 30),
    ("task_dependencies", "predecessor_id", 20),
    ("task_dependencies", "successor_id", 20),
    ("resource_bookings", "project_id", 20),
    ("resource_bookings", "task_id", 20),
    ("batches", "project_id", 20),
    ("batches", "task_id", 20),
    ("alerts", "project_id", 20),
    ("alerts", "task_id", 20),
)


def _is_sqlite() -> bool:
    return op.get_bind().dialect.name == "sqlite"


def upgrade() -> None:
    if _is_sqlite():
        return
    for table, col, old_len in _COLUMNS:
        op.alter_column(
            table,
            col,
            existing_type=sa.String(old_len),
            type_=sa.String(_NEW_LEN),
            existing_nullable=None,
        )


def downgrade() -> None:
    if _is_sqlite():
        return
    for table, col, old_len in _COLUMNS:
        op.alter_column(
            table,
            col,
            existing_type=sa.String(_NEW_LEN),
            type_=sa.String(old_len),
            existing_nullable=None,
        )
