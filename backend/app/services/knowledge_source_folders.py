"""Shared classification changes; never delete or copy a paper or original file."""

import time
from uuid import uuid4

from fastapi import HTTPException


def _revision(catalogue, body):
    if catalogue.get("revision") != body["revision"]:
        raise HTTPException(409, "文件夹已更新，请刷新后重试")


def _available(papers):
    result = {paper["id"]: paper for paper in papers}
    for paper in papers:
        if paper.get("versionId"):
            result["archive:" + paper["versionId"]] = paper
    return result


def _core_path(paper):
    return paper.get("kbPath") if paper["id"].startswith("archive:") else paper["id"]


def _pending_imports(store, papers):
    proofs = []
    versions = {v["id"]: v for v in store.records("version")}
    for paper in papers:
        if paper["id"].startswith("archive:") and paper.get("kbPath") and paper.get("versionId"):
            version = versions.get(paper["versionId"])
            if not version:
                raise HTTPException(409, "原件版本已变化，请刷新后重试")
            proofs.append(
                {
                    "documentId": version.get("kbDocumentId", version["documentId"]),
                    "sha256": version["sha256"],
                }
            )
    return {"imports": proofs} if proofs else {}


def _classify(store, paper, folders, removed):
    if not paper.get("documentId"):
        return
    ident = paper["documentId"]
    store.lock("document", ident)
    store.put(
        "ks_classification",
        {
            "id": store.key("ks_classification", ident),
            "documentId": ident,
            "folderIds": sorted(folders),
            "removedFolderIds": sorted(removed),
        },
    )


def organize_papers(store, actor, body, *, catalogue, connect, papers):
    _revision(catalogue, body)
    mode = body["mode"]
    ids = list(dict.fromkeys(body["paperIds"]))
    if not ids or len(ids) > 500:
        raise HTTPException(400, "请每批选择 1–500 篇论文")
    folder_ids = list(dict.fromkeys(body.get("folderIds", [])))
    origin = body.get("fromFolderId")
    if mode == "remove" and not folder_ids and origin:
        folder_ids = [origin]
    known = {folder["id"] for folder in catalogue.get("folders", [])}
    if not folder_ids or not set(folder_ids) <= known:
        raise HTTPException(409, "目标文件夹已不存在或未选择，请刷新后重试")
    if mode == "move" and origin not in known:
        raise HTTPException(400, "移动须指定有效的当前文件夹")
    available = _available(papers)
    if any(ident not in available for ident in ids):
        raise HTTPException(404, "部分论文已删除或无权访问，请刷新后重试")
    before, after = {}, {}
    for ident in ids:
        current = set(available[ident]["folderIds"])
        target = current - ({origin} if mode == "move" else set())
        target = target - set(folder_ids) if mode == "remove" else target | set(folder_ids)
        before[ident], after[ident] = sorted(current), sorted(target)
    paths = list(
        dict.fromkeys(_core_path(available[ident]) for ident in ids if _core_path(available[ident]))
    )
    revision = catalogue["revision"]
    if paths:
        mutation = {
            "operation": mode,
            "revision": revision,
            "paths": paths,
            "folderIds": folder_ids,
        }
        if mode == "move":
            mutation["fromFolderId"] = origin
        revision = connect(
            "folderMutation",
            actor["subject"],
            mutation=mutation,
            **_pending_imports(store, [available[ident] for ident in ids]),
        )["revision"]
    for ident in ids:
        paper = available[ident]
        current = (
            store.get(
                "ks_classification",
                store.key("ks_classification", paper["documentId"]),
                required=False,
            )
            if paper.get("documentId")
            else None
        )
        removed = set(current.get("removedFolderIds", [])) if current else set()
        removed |= set(before[ident]) - set(after[ident])
        removed -= set(after[ident])
        _classify(store, paper, after[ident], removed)
    token = store.key("ks_undo", str(uuid4()))
    store.put(
        "ks_undo",
        {
            "id": token,
            "subject": actor["subject"],
            "before": before,
            "after": after,
            "expiresAt": time.time() + 86400,
            "used": False,
        },
    )
    store.audit(actor["subject"], "knowledge_source_organized", str(len(ids)))
    store.db.commit()
    return {"saved": True, "revision": revision, "undoToken": token}


def undo_organization(store, actor, body, *, catalogue, connect, papers):
    _revision(catalogue, body)
    entry = store.lock("ks_undo", body["token"])
    if entry.get("subject") != actor["subject"]:
        raise HTTPException(404, "撤销记录不存在")
    if entry.get("used") or entry.get("expiresAt", 0) < time.time():
        raise HTTPException(409, "此操作已撤销或超过 24 小时，请重新整理")
    available = _available(papers)
    known = {folder["id"] for folder in catalogue.get("folders", [])}
    for ident, folders in entry["before"].items():
        if ident not in available:
            raise HTTPException(409, "论文已删除或不可访问，不能撤销")
        if set(available[ident]["folderIds"]) != set(entry["after"][ident]):
            raise HTTPException(409, "这些论文的分类已有后续修改，不能覆盖，请刷新后手动整理")
        if not set(folders) <= known:
            raise HTTPException(409, "原文件夹已删除，不能撤销")
    memberships = {
        _core_path(available[ident]): folders
        for ident, folders in entry["before"].items()
        if _core_path(available[ident])
    }
    revision = catalogue["revision"]
    if memberships:
        revision = connect(
            "folderMutation",
            actor["subject"],
            mutation={
                "operation": "restore",
                "revision": revision,
                "paths": list(memberships),
                "memberships": memberships,
            },
            **_pending_imports(store, [available[ident] for ident in entry["before"]]),
        )["revision"]
    for ident, folders in entry["before"].items():
        paper = available[ident]
        old = (
            store.get(
                "ks_classification",
                store.key("ks_classification", paper["documentId"]),
                required=False,
            )
            if paper.get("documentId")
            else None
        )
        removed = (set(old.get("removedFolderIds", [])) if old else set()) | (
            set(entry["after"][ident]) - set(folders)
        )
        _classify(store, paper, folders, removed - set(folders))
    entry["used"] = True
    store.put("ks_undo", entry)
    store.audit(actor["subject"], "knowledge_source_organization_undone", entry["id"])
    store.db.commit()
    return {"saved": True, "revision": revision}


def folder_action(store, actor, ident, body, *, catalogue, connect):
    _revision(catalogue, body)
    folders = {folder["id"]: folder for folder in catalogue.get("folders", [])}
    if ident not in folders:
        raise HTTPException(404, "文件夹不存在")
    action = body["action"]
    if action not in ("metadata", "delete", "merge"):
        raise HTTPException(400, "不支持的文件夹操作")
    mutation = {"operation": action, "revision": body["revision"], "folderId": ident}
    target = body.get("targetFolderId")
    if action == "metadata":
        for key in ("kind", "parentId"):
            if key in body:
                mutation[key] = body[key]
    elif action == "merge":
        if target not in folders or target == ident:
            raise HTTPException(400, "请选择不同的目标文件夹")
        mutation["targetFolderId"] = target
    if action == "delete" and any(
        source.get("folderId") == ident for source in store.records("source")
    ):
        raise HTTPException(409, "此文件夹是来源默认接收目录，请先在来源设置中更换默认目录")
    if action in ("delete", "merge"):
        if any(
            job.get("folderId") == ident and job.get("status") in ("queued", "running", "paused")
            for job in store.records("job")
        ):
            raise HTTPException(409, "此文件夹仍有未完成下载任务，请先完成或取消任务")
    result = connect("folderMutation", actor["subject"], mutation=mutation)
    if action in ("delete", "merge"):
        for kind in ("document", "ks_classification"):
            for record in store.records(kind):
                if ident in record.get("folderIds", []):
                    record["folderIds"] = sorted(
                        (set(record["folderIds"]) - {ident}) | ({target} if target else set())
                    )
                    if kind == "ks_classification":
                        record.pop("syncedVersions", None)
                        record["removedFolderIds"] = sorted(
                            set(record.get("removedFolderIds", [])) | {ident}
                        )
                    store.put(kind, record)
        for source in store.records("source"):
            changed = False
            for key in ("folderId", "archiveFolderId"):
                if source.get(key) == ident:
                    source[key] = target
                    changed = True
            if changed:
                store.put("source", source)
    store.audit(actor["subject"], "knowledge_source_folder_" + action, ident)
    store.db.commit()
    return {"saved": True, "revision": result["revision"], "folders": result["folders"]}
