"""Export shared citations and deduplicated originals without changing library state."""

import base64
import binascii
import csv
import hashlib
import io
import json
import re
import zipfile
from pathlib import PurePosixPath

from fastapi import HTTPException

LIMIT = 100 * 1024 * 1024


def export_selection(store, actor, ids, format, connect):
    from app.api.v1.knowledge_sources import library, pending_archive

    connect("librarySummary", actor["subject"])
    paths, archives = [], []
    for ident in dict.fromkeys(ids):
        if not ident.startswith("archive:"):
            paths.append(ident)
            continue
        version = store.get("version", ident[8:])
        document = store.get("document", version["documentId"])
        if version.get("kbPath"):
            catalogue = library(
                actor,
                imports=[
                    {
                        "documentId": version.get("kbDocumentId", version["documentId"]),
                        "sha256": version["sha256"],
                    }
                ],
            )
            active = any(p.get("path") == version["kbPath"] for p in catalogue.get("papers", []))
            if not active and not pending_archive(version, catalogue):
                raise HTTPException(404, "部分资料已删除或无权访问，请刷新后重新选择")
        archives.append((document, version))
    binary, content_type = b"", "application/octet-stream"
    if paths:
        result = connect("exportPapers", actor["subject"], paths=paths, format=format)
        try:
            binary = base64.b64decode(result["base64"], validate=True)
        except (KeyError, ValueError, binascii.Error) as exc:
            raise HTTPException(502, "共享资料包返回格式无效") from exc
        content_type = result.get("contentType", content_type)
    if not archives:
        return binary, content_type
    if format == "zip":
        output, fingerprints, manifest = io.BytesIO(), {}, []
        total = 0
        try:
            with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as target:
                if binary:
                    with zipfile.ZipFile(io.BytesIO(binary)) as source:
                        for entry in source.infolist():
                            path = PurePosixPath(entry.filename)
                            if (
                                path.is_absolute()
                                or ".." in path.parts
                                or entry.file_size > LIMIT - total
                            ):
                                raise HTTPException(502, "资料包路径或大小无效")
                            content = source.read(entry)
                            total += len(content)
                            target.writestr(entry.filename, content)
                            if entry.filename.lower().endswith(".pdf"):
                                fingerprints[hashlib.sha256(content).hexdigest()] = entry.filename
                for document, version in archives:
                    record = {
                        "title": document["title"],
                        "documentId": document["id"],
                        "versionId": version["id"],
                        "sourceUrl": document.get("url"),
                        "sha256": version["sha256"],
                        "savedAt": version["createdAt"],
                    }
                    original = store.archive_path(version)
                    if not original.is_file():
                        manifest.append({**record, "status": "missing_original"})
                        continue
                    if version["sha256"] in fingerprints:
                        manifest.append(
                            {
                                **record,
                                "status": "shared_original",
                                "file": fingerprints[version["sha256"]],
                            }
                        )
                        continue
                    if original.stat().st_size > LIMIT - total:
                        raise HTTPException(413, "资料包超过100MB，请减少选择后分批导出")
                    content = original.read_bytes()
                    if hashlib.sha256(content).hexdigest() != version["sha256"]:
                        manifest.append({**record, "status": "original_hash_mismatch"})
                        continue
                    title = re.sub(r"[^\w\-\u3400-\u9fff ]", "_", document["title"])[:75]
                    name = f'originals/{title}-{version["sha256"][:12]}.pdf'
                    target.writestr(name, content)
                    fingerprints[version["sha256"]] = name
                    total += len(content)
                    manifest.append({**record, "status": "saved", "file": name})
                target.writestr(
                    "archive-manifest.json",
                    json.dumps(
                        {"documents": manifest, "note": "多个分类共享原件；缺失项保留记录"},
                        ensure_ascii=False,
                        indent=2,
                    ),
                )
        except zipfile.BadZipFile as exc:
            raise HTTPException(502, "共享资料包校验失败，请重试") from exc
        return output.getvalue(), "application/zip"
    entries = [
        {
            "title": doc["title"],
            "url": doc.get("url")
            or f'/api/v1/knowledge-sources/documents/{doc["id"]}/versions/{version["id"]}/original',
            "version": version["id"],
            "sha256": version["sha256"],
            **doc.get("metadata", {}),
        }
        for doc, version in archives
    ]
    if format == "csv":
        old = list(csv.DictReader(io.StringIO(binary.decode("utf-8-sig")))) if binary else []
        keys = list(dict.fromkeys(key for row in [*old, *entries] for key in row))
        output = io.StringIO()
        writer = csv.DictWriter(output, fieldnames=keys)
        writer.writeheader()
        for row in [*old, *entries]:
            writer.writerow(
                {
                    key: (
                        "'" + str(value)
                        if str(value).startswith(("=", "+", "-", "@", "\t", "\r"))
                        else value
                    )
                    for key, value in row.items()
                }
            )
        return output.getvalue().encode("utf-8-sig"), "text/csv; charset=utf-8"
    additions = []
    for i, row in enumerate(entries):
        title = str(row["title"]).replace("\r", " ").replace("\n", " ")
        url = str(row["url"]).replace("\r", "").replace("\n", "")
        if format == "ris":
            additions.append(
                f'TY  - GEN\nTI  - {title}\nUR  - {url}\nN1  - Version: {row["version"]}\nER  -\n'
            )
        else:

            def escape(value):
                return (
                    str(value)
                    .replace("\\", "\\textbackslash{} ")
                    .replace("{", "\\{")
                    .replace("}", "\\}")
                )

            additions.append(
                f'@misc{{archive{i}_{str(row["sha256"])[:12]},\n  title = {{{escape(title)}}},\n  url = {{{escape(url)}}},\n  note = {{Version {row["version"]}}}\n}}\n'
            )
    return binary + "\n".join(additions).encode(), "text/plain; charset=utf-8"
