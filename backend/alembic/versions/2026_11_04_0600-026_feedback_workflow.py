"""Feedback workflow, context, private notifications and retained image history."""

import sqlalchemy as sa

from alembic import op

revision = "026"
down_revision = "025"
branch_labels = None
depends_on = None

COLUMNS = {
    "feedback": {
        "issue_number": "INTEGER",
        "client_request_id": "VARCHAR(64)",
        "request_hash": "VARCHAR(64)",
        "workflow_version": "INTEGER NOT NULL DEFAULT 1",
        "revision": "INTEGER NOT NULL DEFAULT 1",
        "source_context": "JSON NOT NULL DEFAULT '{}'",
        "assignee_id": "VARCHAR(255)",
        "assignee_name": "VARCHAR(255)",
        "priority": "VARCHAR(8) NOT NULL DEFAULT 'p2'",
        "due_at": "TIMESTAMP WITH TIME ZONE",
        "resolution": "TEXT NOT NULL DEFAULT ''",
        "verification_steps": "TEXT NOT NULL DEFAULT ''",
        "release_version": "VARCHAR(100) NOT NULL DEFAULT ''",
        "resolved_at": "TIMESTAMP WITH TIME ZONE",
        "steps_to_reproduce": "TEXT NOT NULL DEFAULT ''",
        "expected_result": "TEXT NOT NULL DEFAULT ''",
        "actual_result": "TEXT NOT NULL DEFAULT ''",
        "problem_to_solve": "TEXT NOT NULL DEFAULT ''",
        "expected_benefit": "TEXT NOT NULL DEFAULT ''",
    },
    "feedback_activities": {"details": "JSON NOT NULL DEFAULT '{}'"},
    "feedback_images": {"archived": "BOOLEAN NOT NULL DEFAULT false"},
}
TABLES = {
    "feedback_counters": "\nCREATE TABLE feedback_counters (\n\tissuer VARCHAR(255) NOT NULL, \n\tvalue INTEGER NOT NULL, \n\tCONSTRAINT pk_feedback_counters PRIMARY KEY (issuer)\n)\n\n",
    "feedback_votes": "\nCREATE TABLE feedback_votes (\n\tfeedback_id VARCHAR(32) NOT NULL, \n\tsubject VARCHAR(255) NOT NULL, \n\tCONSTRAINT pk_feedback_votes PRIMARY KEY (feedback_id, subject), \n\tCONSTRAINT fk_feedback_votes_feedback_id_feedback FOREIGN KEY(feedback_id) REFERENCES feedback (id) ON DELETE CASCADE\n)\n\n",
    "feedback_watches": "\nCREATE TABLE feedback_watches (\n\tfeedback_id VARCHAR(32) NOT NULL, \n\tsubject VARCHAR(255) NOT NULL, \n\tenabled BOOLEAN NOT NULL, \n\tCONSTRAINT pk_feedback_watches PRIMARY KEY (feedback_id, subject), \n\tCONSTRAINT fk_feedback_watches_feedback_id_feedback FOREIGN KEY(feedback_id) REFERENCES feedback (id) ON DELETE CASCADE\n)\n\n",
    "feedback_reads": "\nCREATE TABLE feedback_reads (\n\tfeedback_id VARCHAR(32) NOT NULL, \n\tsubject VARCHAR(255) NOT NULL, \n\tread_at DATETIME NOT NULL, \n\tCONSTRAINT pk_feedback_reads PRIMARY KEY (feedback_id, subject), \n\tCONSTRAINT fk_feedback_reads_feedback_id_feedback FOREIGN KEY(feedback_id) REFERENCES feedback (id) ON DELETE CASCADE\n)\n\n",
    "feedback_notices": "\nCREATE TABLE feedback_notices (\n\tid VARCHAR(32) NOT NULL, \n\tfeedback_id VARCHAR(32) NOT NULL, \n\tactivity_id VARCHAR(32) NOT NULL, \n\tissuer VARCHAR(255) NOT NULL, \n\tsubject VARCHAR(255) NOT NULL, \n\tkind VARCHAR(20) NOT NULL, \n\tbody TEXT NOT NULL, \n\tcreated_at DATETIME NOT NULL, \n\tread_at DATETIME, \n\tCONSTRAINT pk_feedback_notices PRIMARY KEY (id), \n\tCONSTRAINT uq_feedback_notice_recipient UNIQUE (activity_id, subject), \n\tCONSTRAINT fk_feedback_notices_feedback_id_feedback FOREIGN KEY(feedback_id) REFERENCES feedback (id) ON DELETE CASCADE, \n\tCONSTRAINT fk_feedback_notices_activity_id_feedback_activities FOREIGN KEY(activity_id) REFERENCES feedback_activities (id) ON DELETE CASCADE\n)\n\n",
    "feedback_activity_images": "\nCREATE TABLE feedback_activity_images (\n\tid VARCHAR(32) NOT NULL, \n\tactivity_id VARCHAR(32) NOT NULL, \n\tcontent_type VARCHAR(30) NOT NULL, \n\tcontent BLOB NOT NULL, \n\tCONSTRAINT pk_feedback_activity_images PRIMARY KEY (id), \n\tCONSTRAINT fk_feedback_activity_images_activity_id_feedback_activities FOREIGN KEY(activity_id) REFERENCES feedback_activities (id) ON DELETE CASCADE\n)\n\n",
}
POSTGRES_TABLES = {
    "feedback_counters": "\nCREATE TABLE feedback_counters (\n\tissuer VARCHAR(255) NOT NULL, \n\tvalue INTEGER NOT NULL, \n\tCONSTRAINT pk_feedback_counters PRIMARY KEY (issuer)\n)\n\n",
    "feedback_votes": "\nCREATE TABLE feedback_votes (\n\tfeedback_id VARCHAR(32) NOT NULL, \n\tsubject VARCHAR(255) NOT NULL, \n\tCONSTRAINT pk_feedback_votes PRIMARY KEY (feedback_id, subject), \n\tCONSTRAINT fk_feedback_votes_feedback_id_feedback FOREIGN KEY(feedback_id) REFERENCES feedback (id) ON DELETE CASCADE\n)\n\n",
    "feedback_watches": "\nCREATE TABLE feedback_watches (\n\tfeedback_id VARCHAR(32) NOT NULL, \n\tsubject VARCHAR(255) NOT NULL, \n\tenabled BOOLEAN NOT NULL, \n\tCONSTRAINT pk_feedback_watches PRIMARY KEY (feedback_id, subject), \n\tCONSTRAINT fk_feedback_watches_feedback_id_feedback FOREIGN KEY(feedback_id) REFERENCES feedback (id) ON DELETE CASCADE\n)\n\n",
    "feedback_reads": "\nCREATE TABLE feedback_reads (\n\tfeedback_id VARCHAR(32) NOT NULL, \n\tsubject VARCHAR(255) NOT NULL, \n\tread_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tCONSTRAINT pk_feedback_reads PRIMARY KEY (feedback_id, subject), \n\tCONSTRAINT fk_feedback_reads_feedback_id_feedback FOREIGN KEY(feedback_id) REFERENCES feedback (id) ON DELETE CASCADE\n)\n\n",
    "feedback_notices": "\nCREATE TABLE feedback_notices (\n\tid VARCHAR(32) NOT NULL, \n\tfeedback_id VARCHAR(32) NOT NULL, \n\tactivity_id VARCHAR(32) NOT NULL, \n\tissuer VARCHAR(255) NOT NULL, \n\tsubject VARCHAR(255) NOT NULL, \n\tkind VARCHAR(20) NOT NULL, \n\tbody TEXT NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tread_at TIMESTAMP WITH TIME ZONE, \n\tCONSTRAINT pk_feedback_notices PRIMARY KEY (id), \n\tCONSTRAINT uq_feedback_notice_recipient UNIQUE (activity_id, subject), \n\tCONSTRAINT fk_feedback_notices_feedback_id_feedback FOREIGN KEY(feedback_id) REFERENCES feedback (id) ON DELETE CASCADE, \n\tCONSTRAINT fk_feedback_notices_activity_id_feedback_activities FOREIGN KEY(activity_id) REFERENCES feedback_activities (id) ON DELETE CASCADE\n)\n\n",
    "feedback_activity_images": "\nCREATE TABLE feedback_activity_images (\n\tid VARCHAR(32) NOT NULL, \n\tactivity_id VARCHAR(32) NOT NULL, \n\tcontent_type VARCHAR(30) NOT NULL, \n\tcontent BYTEA NOT NULL, \n\tCONSTRAINT pk_feedback_activity_images PRIMARY KEY (id), \n\tCONSTRAINT fk_feedback_activity_images_activity_id_feedback_activities FOREIGN KEY(activity_id) REFERENCES feedback_activities (id) ON DELETE CASCADE\n)\n\n",
}
INDEXES = [
    "CREATE INDEX IF NOT EXISTS ix_feedback_notices_issuer ON feedback_notices (issuer)",
    "CREATE INDEX IF NOT EXISTS ix_feedback_notices_subject ON feedback_notices (subject)",
    "CREATE INDEX IF NOT EXISTS ix_feedback_notices_feedback_id ON feedback_notices (feedback_id)",
    "CREATE INDEX IF NOT EXISTS ix_feedback_activity_images_activity_id ON feedback_activity_images (activity_id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS ix_feedback_create_request ON feedback (issuer, author_id, client_request_id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS ix_feedback_issuer_issue_number ON feedback (issuer, issue_number)",
]


def upgrade():
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    for name, ddl in (POSTGRES_TABLES if bind.dialect.name == "postgresql" else TABLES).items():
        if name not in tables:
            op.execute(sa.text(ddl))
    for table, columns in COLUMNS.items():
        present = {column["name"] for column in sa.inspect(bind).get_columns(table)}
        for column, ddl in columns.items():
            if column not in present:
                op.execute(sa.text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
    feedback = sa.table(
        "feedback",
        sa.column("id"),
        sa.column("issuer"),
        sa.column("created_at"),
        sa.column("issue_number"),
    )
    counters = sa.table("feedback_counters", sa.column("issuer"), sa.column("value"))
    for issuer in bind.scalars(sa.select(feedback.c.issuer).distinct()):
        current = bind.scalar(
            sa.select(counters.c.value).where(counters.c.issuer == issuer).with_for_update()
        )
        largest = bind.scalar(
            sa.select(sa.func.coalesce(sa.func.max(feedback.c.issue_number), 0)).where(
                feedback.c.issuer == issuer
            )
        )
        if current is None:
            bind.execute(counters.insert().values(issuer=issuer, value=largest))
        elif current < largest:
            bind.execute(counters.update().where(counters.c.issuer == issuer).values(value=largest))
    rows = bind.execute(
        sa.select(feedback.c.id, feedback.c.issuer)
        .where(feedback.c.issue_number.is_(None))
        .order_by(feedback.c.issuer, feedback.c.created_at, feedback.c.id)
        .with_for_update()
    ).all()
    for ident, issuer in rows:
        number = bind.scalar(
            counters.update()
            .where(counters.c.issuer == issuer)
            .values(value=counters.c.value + 1)
            .returning(counters.c.value)
        )
        bind.execute(feedback.update().where(feedback.c.id == ident).values(issue_number=number))
    for ddl in INDEXES:
        op.execute(sa.text(ddl))


def downgrade():
    # Application rollback cannot discard discussions, context, numbering, watches,
    # notifications, release evidence or images retained in edit history.
    pass
