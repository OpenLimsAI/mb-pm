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
    excerpt_chars: int = 0

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
            if row.get("evidence_eligible") is False:
                continue
            path = row["path"]
            # A directory can be large. Provenance is bounded independently of text.
            if path not in self.rows and len(self.rows) >= 200:
                self.truncated = True
                continue
            self.observed.setdefault(path, set()).add(kind)
            previous = self.rows.get(path)
            excerpts = list((previous or {}).get("excerpts", []))
            text = row.get("body") if name == "read_page" else row.get("text")
            if isinstance(text, str) and text:
                offset = row.get("offset")
                offset = offset if type(offset) is int and offset >= 0 else None
                excerpt = {
                    "text": text[: min(1200, max(0, 24000 - self.excerpt_chars))],
                    "offset": offset,
                    "kind": kind,
                }
                excerpt["length"] = len(excerpt["text"])
                if excerpt["text"] and excerpt not in excerpts:
                    if len(excerpts) < 3:
                        excerpts.append(excerpt)
                        self.excerpt_chars += excerpt["length"]
                    elif kind == "read" and not any(x["kind"] == "read" for x in excerpts):
                        self.excerpt_chars += excerpt["length"] - excerpts[-1]["length"]
                        excerpts[-1] = excerpt
                    else:
                        self.truncated = True
                if len(text) > excerpt["length"]:
                    self.truncated = True
            if previous and PRIORITY[previous["kind"]] > PRIORITY[kind]:
                previous["excerpts"] = excerpts
                continue
            self.rows[path] = {
                "path": path,
                "title": str(row.get("title") or path)[:1000],
                "url": str(row.get("url") or "")[:2000],
                "kind": kind,
                "excerpts": excerpts,
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
        # This validates the presence of an observed path, not whether a cited
        # passage semantically supports the model's claim.
        for row in refs:
            row["citation_status"] = "path_matched" if row["cited"] else "not_cited"
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
