"""Per-answer provenance from tool results actually delivered to the model."""

import re
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field

from app.services import assistant_knowledge

CURRENT = ContextVar("assistant_source_provenance", default=None)
PRIORITY = {"catalogued": 0, "retrieved": 1, "read": 2}


@dataclass
class Sources:
    rows: dict = field(default_factory=dict)
    observed: dict = field(default_factory=dict)
    truncated: bool = False

    def observe(self, name, value):
        if not isinstance(value, dict) or value.get("error"):
            return
        self.truncated |= bool(value.get("truncated"))
        kind = (
            "read"
            if name == "read_page"
            else "retrieved"
            if name == "retrieve_knowledge"
            else "catalogued"
        )
        rows = (
            [value]
            if name == "read_page"
            else (
                value.get("page_refs", []) + value.get("chunks", [])
                if name == "retrieve_knowledge"
                else value.get("items", [])
            )
        )
        for row in rows:
            if not isinstance(row, dict) or not assistant_knowledge.valid_path(row.get("path")):
                continue
            path = row["path"]
            # A directory can be large. Provenance is bounded independently of text.
            if path not in self.rows and len(self.rows) >= 200:
                self.truncated = True
                continue
            self.observed.setdefault(path, set()).add(kind)
            previous = self.rows.get(path)
            if previous and PRIORITY[previous["kind"]] > PRIORITY[kind]:
                continue
            self.rows[path] = {
                "path": path,
                "title": str(row.get("title") or path)[:1000],
                "url": str(row.get("url") or "")[:2000],
                "kind": kind,
            }

    def finish(self, content, material_count):
        refs = [
            {
                **row,
                "cited": bool(
                    re.search(
                        r"(?<![A-Za-z0-9_./-])" + re.escape(row["path"]) + r"(?![A-Za-z0-9_./-])",
                        content,
                    )
                ),
            }
            for row in self.rows.values()
        ]
        return refs, {
            "material_count": material_count,
            "catalogued_count": sum("catalogued" in kinds for kinds in self.observed.values()),
            "retrieved_count": sum("retrieved" in kinds for kinds in self.observed.values()),
            "read_count": sum("read" in kinds for kinds in self.observed.values()),
            "cited_count": sum(row["cited"] for row in refs),
            "truncated": self.truncated,
            "count_basis": "source_materials",
        }


@contextmanager
def collect():
    state = Sources()
    token = CURRENT.set(state)
    try:
        yield state
    finally:
        CURRENT.reset(token)


def observe(name, value):
    state = CURRENT.get()
    if state is not None:
        state.observe(name, value)
