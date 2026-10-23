"""Knowledge solutions and private evidence. Revision 006; replaces 005."""

import sqlalchemy as sa

from alembic import op

revision = "006"
down_revision = "005"
branch_labels = None
depends_on = None


def columns(specification):
    """Compact, frozen migration schema (does not import application models)."""
    result = []
    for name, kind in specification:
        nullable = kind.endswith("?")
        kind = kind.rstrip("?")
        column_type = {
            "json": sa.JSON,
            "text": sa.Text,
            "int": sa.Integer,
            "bool": sa.Boolean,
            "datetime": lambda: sa.DateTime(timezone=True),
        }.get(kind)
        data_type = column_type() if column_type else sa.String(int(kind))
        constraints = [sa.ForeignKey("knowledge_solutions.id")] if name == "solution_id" else []
        result.append(
            sa.Column(
                name,
                data_type,
                *constraints,
                primary_key=name == "id",
                nullable=False if name == "id" else nullable,
            )
        )
    return result


SCHEMAS = {
    "knowledge_solutions": [
        ("id", "64"),
        ("issuer", "255"),
        ("owner_id", "255"),
        ("owner_name", "255"),
        ("title", "300"),
        ("project_name", "200"),
        ("product_name", "200"),
        ("status", "20"),
        ("requires_kb", "bool"),
        ("revision", "int"),
        ("version", "int"),
        ("sections", "json"),
        ("formula", "json"),
        ("references", "json"),
        ("reviewer_id", "255?"),
        ("reviewer_name", "255"),
        ("review_notes", "text"),
        ("updated_at", "datetime"),
    ],
    "solution_sources": [
        ("id", "64"),
        ("issuer", "255"),
        ("owner_id", "255"),
        ("title", "300"),
        ("kind", "20"),
        ("authors", "500"),
        ("date", "40"),
        ("project_name", "200"),
        ("tags", "json"),
        ("content", "text"),
        ("locator", "500"),
        ("version", "80"),
        ("url", "2000"),
        ("publication_key", "100?"),
        ("updated_at", "datetime"),
    ],
    "solution_versions": [
        ("id", "64"),
        ("solution_id", "64"),
        ("version", "int"),
        ("status", "20"),
        ("actor_name", "255"),
        ("note", "text"),
        ("snapshot", "json"),
        ("created_at", "datetime"),
    ],
    "solution_answers": [
        ("id", "64"),
        ("solution_id", "64"),
        ("issuer", "255"),
        ("owner_id", "255"),
        ("question", "text"),
        ("content", "text"),
        ("mode", "20"),
        ("references", "json"),
        ("context", "text"),
        ("scope", "1000"),
        ("model", "160"),
        ("created_at", "datetime"),
    ],
    "solution_events": [
        ("id", "64"),
        ("solution_id", "64"),
        ("actor_id", "255"),
        ("action", "40"),
        ("revision", "int"),
        ("version", "int"),
        ("details", "json"),
        ("created_at", "datetime"),
    ],
}


def upgrade():
    present = set(sa.inspect(op.get_bind()).get_table_names())
    if "solution_actors" not in present:
        op.create_table(
            "solution_actors",
            sa.Column("issuer", sa.String(255), primary_key=True),
            sa.Column("subject", sa.String(255), primary_key=True),
            sa.Column("name", sa.String(255), nullable=False),
        )
    for table, spec in SCHEMAS.items():
        if table in present:
            continue
        extra = (
            [sa.UniqueConstraint("issuer", "owner_id", "publication_key")]
            if table == "solution_sources"
            else []
        )
        op.create_table(table, *columns(spec), *extra)
        indexes = (
            ("issuer", "owner_id", "reviewer_id")
            if table == "knowledge_solutions"
            else (("issuer", "owner_id") if table == "solution_sources" else ("solution_id",))
        )
        for column in indexes:
            op.create_index(f"ix_{table}_{column}", table, [column])


def downgrade():
    for table in reversed(SCHEMAS):
        op.drop_table(table)
    op.drop_table("solution_actors")
