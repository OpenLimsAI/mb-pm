"""Durable tenant-scoped records with content-addressed originals and immutable versions."""

import copy
import difflib
import hashlib
import json
import os
import re
import shutil
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError

from app.core.config import settings
from app.models.information import InformationEntry, InformationLease, InformationText


def iso(value=None):
    return datetime.fromtimestamp(value or time.time(), UTC).isoformat()


def tenant_key(issuer, organization):
    return hashlib.sha256(
        json.dumps([issuer, organization], separators=(",", ":")).encode()
    ).hexdigest()


def identity_key(subject):
    return hashlib.sha256(subject.encode()).hexdigest()


class Store:
    def __init__(self, db, tenant):
        self.db, self.tenant = db, tenant

    def key(self, kind, value):
        return hashlib.sha256(f"{self.tenant}:{kind}:{value}".encode()).hexdigest()

    def get(self, kind, ident, *, required=True):
        row = self.db.get(InformationEntry, ident, populate_existing=True)
        if not row or row.tenant != self.tenant or row.kind != kind:
            if required:
                raise HTTPException(404, "信息获取记录不存在")
            return None
        data = copy.deepcopy(row.data)
        if kind == "version":
            text_row = self.db.get(InformationText, ident)
            if text_row is not None and text_row.tenant == self.tenant:
                data["text"] = text_row.content
        return data

    def lock(self, kind, ident):
        row = (
            self.db.query(InformationEntry)
            .filter_by(id=ident, tenant=self.tenant, kind=kind)
            .populate_existing()
            .with_for_update()
            .first()
        )
        if row is None:
            raise HTTPException(404, "信息获取记录不存在")
        return copy.deepcopy(row.data)

    def audit(self, subject, action, target):
        self.put(
            "audit",
            {
                "id": self.key("audit", str(uuid4())),
                "subject": subject,
                "action": action,
                "target": target,
                "createdAt": iso(),
            },
        )

    def put(self, kind, data):
        value = copy.deepcopy(data)
        if kind == "version" and "text" in value:
            text = value.pop("text")
            text_row = self.db.get(InformationText, value["id"])
            if text_row is not None:
                if text_row.tenant != self.tenant:
                    raise HTTPException(409, "资料正文标识冲突")
                text_row.content = text
            else:
                self.db.add(
                    InformationText(
                        id=value["id"],
                        tenant=self.tenant,
                        document_id=value["documentId"],
                        content=text,
                    )
                )
        row = self.db.get(InformationEntry, value["id"])
        if row and (row.tenant != self.tenant or row.kind != kind):
            raise HTTPException(409, "记录标识冲突")
        if row:
            row.data, row.updated_at = value, time.time()
        else:
            self.db.add(
                InformationEntry(
                    id=value["id"],
                    tenant=self.tenant,
                    kind=kind,
                    data=value,
                    updated_at=time.time(),
                )
            )
        self.db.flush()
        return value

    def records(self, kind, limit=None):
        query = self.db.query(InformationEntry).filter_by(tenant=self.tenant, kind=kind)
        if limit is not None:
            rows = list(
                reversed(
                    query.order_by(InformationEntry.updated_at.desc(), InformationEntry.id.desc())
                    .limit(limit)
                    .all()
                )
            )
        else:
            rows = query.order_by(InformationEntry.updated_at, InformationEntry.id).all()
        values = [copy.deepcopy(row.data) for row in rows]
        return (
            sorted(values, key=lambda value: (value.get("createdAt", ""), value["id"]))
            if kind == "version"
            else values
        )

    def active_jobs(self):
        query = self.db.query(InformationEntry).filter(
            InformationEntry.tenant == self.tenant,
            InformationEntry.kind == "job",
            InformationEntry.data["status"].as_string().in_(["queued", "running", "paused"]),
        )
        return [copy.deepcopy(row.data) for row in query.order_by(InformationEntry.updated_at)]

    def ensure_source(self):
        ident = self.key("source", "ich")
        existing = self.get("source", ident, required=False)
        if existing:
            return existing
        data = {
            "id": ident,
            "name": "ICH 官方指导原则",
            "url": "https://www.ich.org",
            "adapter": "ich",
            "scopes": ["Q", "S", "E", "M"],
            "folderId": None,
            "frequency": "daily",
            "enabled": False,
            "status": "unchecked",
            "scopeStatus": {},
            "baselineScopes": [],
            "lastCheckedAt": None,
            "lastSuccessAt": None,
            "error": None,
            "nextCheckAt": None,
            "managerSubject": None,
        }
        try:
            with self.db.begin_nested():
                self.put("source", data)
        except IntegrityError:
            pass  # Another authenticated request created the same canonical source.
        return self.source(ident)

    def source(self, ident):
        return self.get("source", ident)

    def documents(self):
        return self.records("document")

    def document(self, ident):
        data = self.get("document", ident)
        data["versions"] = [
            self.public_version(v) for v in self.records("version") if v["documentId"] == ident
        ]
        return data

    @staticmethod
    def public_version(v):
        return {k: value for k, value in v.items() if k not in {"text", "relativePath", "kbTaskId"}}

    def apply_catalogue(self, source_id, scope, documents):
        source = self.source(source_id)
        baseline = scope in source.get("baselineScopes", [])
        previous_documents = {
            doc["id"]: doc for doc in self.documents() if doc["sourceId"] == source_id
        }
        seen = set()
        for entry in documents:
            ident = self.key("document", source_id + entry["key"])
            seen.add(ident)
            existing = self.get("document", ident, required=False)
            fresh = {
                "id": ident,
                "sourceId": source_id,
                "discoveredAt": iso(),
                "status": "discovered",
                "versions": [],
                "folderIds": [],
                "error": None,
                **entry,
            }
            if existing:
                previous = {
                    k: existing.get(k)
                    for k in ("officialStatus", "officialDate", "description", "url")
                }
                fresh = {
                    **existing,
                    **entry,
                    "scopes": sorted(set(existing["scopes"] + entry["scopes"])),
                }
                current = {k: fresh.get(k) for k in previous}
                if previous != current and baseline:
                    kind = (
                        "官方状态变化"
                        if previous["officialStatus"] != current["officialStatus"]
                        else "资料信息变化"
                    )
                    self.event(
                        kind,
                        fresh["title"],
                        source_id,
                        ident,
                        before=json.dumps(previous, ensure_ascii=False),
                        after=json.dumps(current, ensure_ascii=False),
                        minor=all(
                            previous[key] == current[key]
                            for key in ("officialStatus", "officialDate", "description")
                        ),
                    )
            elif baseline:
                self.event("新资料", fresh["title"], source_id, ident)
            # NEW describes additions since this scope's preceding successful scan.
            # First scans establish a baseline, while failed/unscanned scopes keep
            # their prior markers. A known paper appearing in another scope is not new.
            new_scopes = set(fresh.get("newInScopes", [])) - {scope}
            if baseline and ident not in previous_documents:
                new_scopes.add(scope)
            fresh["newInScopes"] = sorted(new_scopes)
            self.put("document", fresh)
        for ident, doc in previous_documents.items():
            if ident not in seen and scope in doc.get("newInScopes", []):
                doc["newInScopes"] = sorted(set(doc["newInScopes"]) - {scope})
                self.put("document", doc)

    def finish_check(self, source_id, statuses):
        source = self.source(source_id)
        first = not source.get("baselineScopes")
        source["scopeStatus"] = {**source.get("scopeStatus", {}), **statuses}
        good = [code for code, value in statuses.items() if value["status"] == "ok"]
        source["baselineScopes"] = sorted(set(source.get("baselineScopes", []) + good))
        source["lastCheckedAt"] = iso()
        source["status"] = "ok" if len(good) == len(statuses) else "partial" if good else "error"
        if good:
            source["lastSuccessAt"] = iso()
        source["error"] = (
            "；".join(f'{k}: {v["error"]}' for k, v in statuses.items() if v.get("error")) or None
        )
        source["nextCheckAt"] = time.time() + (604800 if source["frequency"] == "weekly" else 86400)
        self.put("source", source)
        if first and good:
            self.event(
                "目录基线",
                "ICH 首次目录检查完成",
                source_id,
                summary=f'已建立 {" / ".join(good)} 目录基线。存量资料不逐篇发送新情报；文件仍须收录后才能读取归档原文。',
            )

    def event(self, kind, title, source, document=None, **values):
        return self.put(
            "event",
            {
                "id": self.key("event", str(uuid4())),
                "kind": kind,
                "title": title,
                "sourceId": source,
                "documentId": document,
                "createdAt": iso(),
                "read": False,
                **values,
            },
        )

    def preferences(self, subject):
        ident = self.key("preference", identity_key(subject))
        return self.get("preference", ident, required=False) or {
            "id": ident,
            "follows": ["scope:Q", "scope:S", "scope:E", "scope:M"],
            "read": [],
            "later": [],
            "note": "",
            "digest": "即时提醒",
            "minor": False,
        }

    def save_preferences(self, subject, changes):
        data = self.preferences(subject)
        self.put("preference", {**data, **changes})

    def archive_path(self, version):
        relative = (
            version.get("relativePath")
            or f'{self.tenant}/{version["sha256"][:2]}/{version["sha256"]}.pdf'
        )
        base = Path(settings.INFORMATION_DATA_DIR).resolve()
        path = (base / relative).resolve()
        if base not in path.parents:
            raise HTTPException(500, "原文归档路径无效")
        return path

    def archive(self, document_id, content, text="", *, parse_status="pending", error=None):
        doc = self.get("document", document_id)
        sha = hashlib.sha256(content).hexdigest()
        ident = self.key("version", document_id + sha)
        version = self.get("version", ident, required=False)
        if version:
            return version
        version = {
            "id": ident,
            "documentId": document_id,
            "sha256": sha,
            "size": len(content),
            "createdAt": iso(),
            "parseStatus": parse_status,
            "indexStatus": "not_requested",
            "text": text,
            "error": error,
            "relativePath": f"{self.tenant}/{sha[:2]}/{sha}.pdf",
            "archiveUrl": f"/api/v1/information/documents/{document_id}/versions/{ident}/original",
        }
        path = self.archive_path(version)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not path.exists():
            if shutil.disk_usage(path.parent).free < max(len(content) * 2, 100 * 1024 * 1024):
                raise ValueError("归档磁盘可用空间不足，未覆盖已有资料")
            total = sum(
                p.stat().st_size for p in Path(settings.INFORMATION_DATA_DIR).rglob("*.pdf")
            )
            if total + len(content) > settings.INFORMATION_MAX_ARCHIVE_MB * 1024 * 1024:
                raise ValueError("原文存储达到配置容量上限，请联系管理员扩容")
            fd, temp = tempfile.mkstemp(dir=path.parent)
            try:
                with os.fdopen(fd, "wb") as stream:
                    stream.write(content)
                os.replace(temp, path)
            finally:
                if os.path.exists(temp):
                    os.unlink(temp)
        old_metadata = [v for v in self.records("version") if v["documentId"] == document_id]
        old = [self.get("version", old_metadata[-1]["id"])] if old_metadata else []
        self.put("version", version)
        doc["status"] = "archived"
        doc["error"] = error
        self.put("document", doc)
        if old:
            if old[-1].get("text") and text:
                before, after = old[-1]["text"], text
                if re.sub(r"\s+", " ", before) == re.sub(r"\s+", " ", after):
                    kind = "文件格式变化"
                    minor = True
                else:
                    kind = "正文修订"
                    minor = False
                difference = "\n".join(
                    difflib.unified_diff(
                        before.splitlines(),
                        after.splitlines(),
                        fromfile=old[-1]["id"],
                        tofile=ident,
                    )
                )[:30000]
            else:
                kind = "原文件变化"
                minor = False
                difference = "原文校验值已变化，正文尚未提取完成。"
            self.event(
                kind,
                doc["title"],
                doc["sourceId"],
                document_id,
                summary=difference,
                minor=minor,
                id=self.key("event", "version:" + ident),
            )
        return version

    def describe_version_change(self, version):
        previous = [
            v
            for v in self.records("version")
            if v["documentId"] == version["documentId"] and v["createdAt"] < version["createdAt"]
        ]
        if not previous or not version.get("text"):
            return
        old = self.get("version", previous[-1]["id"])
        if not old.get("text"):
            return
        ident = self.key("event", "version:" + version["id"])
        event = self.get("event", ident, required=False)
        if not event:
            return
        same = (
            re.sub(r"\s+", " ", old["text"]).strip() == re.sub(r"\s+", " ", version["text"]).strip()
        )
        event.update(
            kind="文件格式变化" if same else "正文修订",
            minor=same,
            summary="正文相同，原文件字节发生变化。"
            if same
            else "\n".join(
                difflib.unified_diff(
                    old["text"][:200000].splitlines(),
                    version["text"][:200000].splitlines(),
                    fromfile=old["createdAt"],
                    tofile=version["createdAt"],
                )
            )[:30000],
        )
        self.put("event", event)

    def create_job(
        self,
        source_id,
        subject,
        *,
        kind="check",
        document_ids=None,
        folder_id=None,
        parse=False,
        app=None,
    ):
        source = self.source(source_id)
        row = self.db.get(InformationEntry, source_id)
        stamp = row.updated_at
        claimed = self.db.execute(
            update(InformationEntry)
            .where(InformationEntry.id == source_id, InformationEntry.updated_at == stamp)
            .values(updated_at=time.time())
        ).rowcount
        if claimed != 1:
            raise HTTPException(409, "来源在创建任务时发生变化，请刷新后重试")
        for old in self.active_jobs():
            if (
                old["sourceId"] == source_id
                and old.get("app") == app
                and old["status"] in ("queued", "running", "paused")
            ):
                raise HTTPException(409, "此来源已有未完成任务，请先继续或取消原任务")
        ident = self.key("job", str(uuid4()))
        items = [
            {"documentId": d, "status": "pending", "error": None} for d in (document_ids or [])
        ]
        if kind in ("check", "monitor"):
            items = [{"scope": s, "status": "pending"} for s in source["scopes"]]
        data = {
            "id": ident,
            "kind": kind,
            "sourceId": source_id,
            "actorSubject": subject,
            "folderId": folder_id,
            "parse": parse,
            "status": "queued",
            "createdAt": iso(),
            "updatedAt": iso(),
            "items": items,
            "error": None,
            "total": len(items),
            "processed": 0,
            "saved": 0,
            "failed": 0,
            "pending": len(items),
            "scopeStatus": {},
        }
        if app:
            data["app"] = app
        self.put("job", data)
        self.audit(subject, "job_created:" + kind, ident)
        return data

    def control_job(self, ident, action):
        job = self.lock("job", ident)
        if action == "pause" and job["status"] in ("running", "queued"):
            job["status"] = "paused"
        elif action == "cancel" and job["status"] in ("running", "queued", "paused"):
            job["status"] = "cancelled"
        elif action == "resume" and job["status"] == "paused":
            job["status"] = "queued"
        elif action == "retry" and job["status"] in ("partial", "failed", "completed", "cancelled"):
            for item in job["items"]:
                if item["status"] == "failed":
                    item["status"] = "pending"
                    item["error"] = None
                    item.pop("phase", None)
                    item.pop("nextAttemptAt", None)
            job["status"] = "queued"
            job["error"] = None
        else:
            raise HTTPException(409, "当前任务状态不支持此操作")
        job["updatedAt"] = iso()
        self.put("job", job)
        return job

    def claim_lease(self, owner, *, now=None):
        now = time.time() if now is None else now
        if self.db.get(InformationLease, "collector") is None:
            try:
                with self.db.begin_nested():
                    self.db.add(InformationLease(id="collector", owner="", expires_at=0))
                    self.db.flush()
            except IntegrityError:
                pass
        acquired = (
            self.db.execute(
                update(InformationLease)
                .where(InformationLease.id == "collector", InformationLease.expires_at <= now)
                .values(owner=owner, expires_at=now + 300)
            ).rowcount
            == 1
        )
        self.db.commit()
        return acquired

    def release_lease(self, owner):
        self.db.execute(
            update(InformationLease)
            .where(InformationLease.id == "collector", InformationLease.owner == owner)
            .values(owner="", expires_at=0)
        )
        self.db.commit()
