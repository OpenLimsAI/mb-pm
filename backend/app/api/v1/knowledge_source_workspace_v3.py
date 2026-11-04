# ruff: noqa: B008
"""Authenticated personal state, deterministic filing and opt-in research turns."""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import Field
from sqlalchemy.orm import Session

from app.api.v1.knowledge_sources import (
    Input,
    connected,
    library,
    paper_snapshot,
    pending_archive,
    principal,
)
from app.api.v1.portal import session_claims
from app.db.session import get_db
from app.services import knowledge_ai
from app.services import knowledge_source_research_v3 as research_service
from app.services import knowledge_source_workspace_v3 as service
from app.services.information.store import Store

router = APIRouter(prefix="/knowledge-sources/v3", tags=["knowledge-source-workspace"])


class QueryInput(Input):
    text: str = Field("", max_length=500)
    source_ids: list[str] = Field(default_factory=list, alias="sourceIds", max_length=100)
    folder_ids: list[str] = Field(default_factory=list, alias="folderIds", max_length=100)
    scopes: list[Literal["Q", "S", "E", "M"]] = Field(default_factory=list)
    types: list[str] = Field(default_factory=list, max_length=30)
    tags: list[str] = Field(default_factory=list, max_length=100)
    reading_states: list[Literal["unread", "reading", "done", "later"]] = Field(
        default_factory=list, alias="readingStates"
    )
    updated_only: bool = Field(False, alias="updatedOnly")


class CollectionInput(Input):
    id: str | None = Field(None, max_length=64)
    name: str = Field(min_length=1, max_length=80, pattern=r".*\S.*")
    query: QueryInput = Field(default_factory=QueryInput)
    revision: int = Field(ge=0)
    deleted: bool = False


class RuleInput(CollectionInput):
    target_folder_ids: list[str] = Field(
        default_factory=list, alias="targetFolderIds", max_length=30
    )
    enabled: bool = False


class PositionInput(Input):
    page: int | None = Field(None, ge=1, le=100000)
    offset: int | None = Field(None, ge=0, le=100000000)
    section: str | None = Field(None, max_length=500)


class ReadingInput(Input):
    paper_id: str = Field(alias="paperId", min_length=1, max_length=1100)
    version_id: str | None = Field(None, alias="versionId", max_length=100)
    state: Literal["unread", "reading", "done", "later"]
    position: PositionInput = Field(default_factory=PositionInput)
    automatic: bool = False
    expected_updated_at: str | None = Field(None, alias="expectedUpdatedAt", max_length=80)


class LocationInput(Input):
    folder_id: str | None = Field(None, alias="folderId", max_length=100)
    collection_id: str | None = Field(None, alias="collectionId", max_length=100)
    query: str = Field("", max_length=500)
    paper_id: str | None = Field(None, alias="paperId", max_length=1100)
    scroll_top: int = Field(0, alias="scrollTop", ge=0, le=100000000)
    offset: int = Field(0, ge=0, le=100000000)


class ApplyInput(Input):
    preview_digest: str | None = Field(None, alias="previewDigest", max_length=64)


class ResearchInput(Input):
    mode: Literal["ask", "compare", "classify", "brief"]
    paper_ids: list[str] = Field(default_factory=list, alias="paperIds", max_length=20)
    folder_id: str | None = Field(None, alias="folderId", max_length=100)
    question: str = Field("", max_length=2000)
    model: str | None = Field(None, max_length=80)
    refresh: bool = False


def context(store, actor):
    catalogue = library(actor, store)
    papers = paper_snapshot(store, actor, catalogue)
    # Full metadata paging is deliberate here: rules and duplicates must not act on
    # just the currently displayed page. Text bodies are never included in this loop.
    offset = 0
    enriched = {}
    while True:
        page = connected(
            "queryLibrary",
            actor["subject"],
            query="",
            folderIds=[],
            tags=[],
            offset=offset,
            limit=100,
            sort="recent",
        )
        for item in page.get("papers", []):
            enriched[item.get("path") or item.get("id")] = item
        next_offset = page.get("nextOffset")
        if next_offset is None:
            break
        if not isinstance(next_offset, int) or next_offset <= offset:
            raise HTTPException(503, "知识库分页游标无效，请稍后重试")
        offset = next_offset
    papers = [
        {
            **paper,
            **{
                key: value
                for key, value in enriched.get(paper["id"], {}).items()
                if key in {"metadata", "tags", "hash", "matches"}
            },
        }
        for paper in papers
    ]
    return catalogue, papers


def editable(catalogue):
    if not catalogue.get("canWrite"):
        raise HTTPException(403, "当前账号没有知识库整理权限")


def dump(body):
    return body.model_dump(by_alias=True, exclude_none=True)


@router.get("/workspace")
def get_workspace(db: Session = Depends(get_db), actor: dict = Depends(principal)):
    return service.public_workspace(Store(db, actor["tenant"]), actor["subject"])


@router.post("/workspace/collections")
def collection(
    body: CollectionInput, db: Session = Depends(get_db), actor: dict = Depends(principal)
):
    return service.save_collection(Store(db, actor["tenant"]), actor["subject"], dump(body))


@router.post("/workspace/reading")
def reading(body: ReadingInput, db: Session = Depends(get_db), actor: dict = Depends(principal)):
    store = Store(db, actor["tenant"])
    if body.paper_id.startswith("archive:"):
        ident = body.paper_id.split(":", 1)[1]
        version = store.get("version", ident)
        if body.version_id and body.version_id != version["id"]:
            raise HTTPException(409, "阅读版本与归档不一致")
        store.get("document", version["documentId"])
        if version.get("kbPath"):
            if version.get("kbPending"):
                catalogue = library(
                    actor,
                    imports=[
                        {
                            "documentId": version.get("kbDocumentId", version["documentId"]),
                            "sha256": version["sha256"],
                        }
                    ],
                )
                active = any(
                    item.get("path") == version["kbPath"] for item in catalogue.get("papers", [])
                )
                if not active and not pending_archive(version, catalogue):
                    raise HTTPException(404, "论文已删除或原件登记回执不可确认")
            else:
                connected("readPaper", actor["subject"], path=version["kbPath"], offset=0, limit=1)
        paper = {"id": body.paper_id, "versionId": version["id"]}
    else:
        live = connected("readPaper", actor["subject"], path=body.paper_id, offset=0, limit=1)
        linked = [
            version
            for version in store.records("version")
            if version.get("kbPath") == body.paper_id
        ]
        selected = next((version for version in linked if version["id"] == body.version_id), None)
        if body.version_id and selected is None and body.version_id != live.get("versionId"):
            raise HTTPException(409, "阅读版本与资料不一致")
        version = selected or max(
            linked, key=lambda value: value.get("createdAt", ""), default=None
        )
        canonical = version["id"] if version else live.get("versionId")
        paper = {"id": body.paper_id, "versionId": canonical}
    # Imported originals have a PM immutable version and a distinct Core version.
    # Prefer the existing PM identity; Core-only papers use its verified live ID.
    return service.save_reading(
        store, actor["subject"], {**dump(body), "versionId": paper["versionId"]}, [paper]
    )


@router.post("/workspace/location")
def location(body: LocationInput, db: Session = Depends(get_db), actor: dict = Depends(principal)):
    return service.save_location(Store(db, actor["tenant"]), actor["subject"], dump(body))


@router.post("/workspace/rules")
def rule(body: RuleInput, db: Session = Depends(get_db), actor: dict = Depends(principal)):
    store = Store(db, actor["tenant"])
    catalogue = library(actor, store)
    editable(catalogue)
    return service.save_rule(store, actor["subject"], dump(body), catalogue.get("folders", []))


@router.post("/workspace/rules/{ident}/preview")
def preview(ident: str, db: Session = Depends(get_db), actor: dict = Depends(principal)):
    store = Store(db, actor["tenant"])
    catalogue, papers = context(store, actor)
    editable(catalogue)
    return service.rule_preview(store, actor["subject"], ident, papers)


@router.post("/workspace/rules/{ident}/apply")
def apply(
    ident: str, body: ApplyInput, db: Session = Depends(get_db), actor: dict = Depends(principal)
):
    store = Store(db, actor["tenant"])
    catalogue, papers = context(store, actor)
    editable(catalogue)
    return service.apply_rule(
        store,
        actor,
        ident,
        catalogue=catalogue,
        papers=papers,
        connect=connected,
        preview_digest=body.preview_digest,
    )


@router.get("/workspace/duplicates")
def duplicates(db: Session = Depends(get_db), actor: dict = Depends(principal)):
    store = Store(db, actor["tenant"])
    _, papers = context(store, actor)
    return service.duplicate_candidates(papers)


@router.get("/research/models")
def models(request: Request, db: Session = Depends(get_db), actor: dict = Depends(principal)):
    return knowledge_ai.models(db, session_claims(request, db))


@router.post("/research")
def research(
    body: ResearchInput,
    request: Request,
    db: Session = Depends(get_db),
    actor: dict = Depends(principal),
):
    store = Store(db, actor["tenant"])
    catalogue, papers = context(store, actor)
    return research_service.research(
        store,
        actor,
        session_claims(request, db),
        dump(body),
        papers=papers,
        folders=catalogue.get("folders", []),
        connect=connected,
    )
