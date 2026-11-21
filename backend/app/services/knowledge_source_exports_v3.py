"""Export shared citations and deduplicated originals without changing library state."""

import base64
import binascii
import csv
import hashlib
import io
import json
import re
import tempfile
import zipfile
from pathlib import PurePosixPath

from fastapi import HTTPException

LIMIT = 100 * 1024 * 1024
CHUNK_SIZE = 64 * 1024


def _safe_zip_member_name(name: str) -> bool:
    if not name or "\\" in name or ":" in name or any(ord(ch) < 32 for ch in name):
        return False
    path = PurePosixPath(name)
    return not path.is_absolute() and ".." not in path.parts


def _read_zip_member_bounded(
    source: zipfile.ZipFile, entry: zipfile.ZipInfo, remaining: int
) -> bytes:
    buf = bytearray()
    with source.open(entry, "r") as stream:
        while True:
            chunk = stream.read(CHUNK_SIZE)
            if not chunk:
                break
            if len(buf) + len(chunk) > remaining:
                raise HTTPException(502, "资料包路径或大小无效")
            buf.extend(chunk)
    return bytes(buf)


def export_selection(store, actor, ids, format, connect):
    from app.services.knowledge_source_context import library, pending_archive

    connect("librarySummary", actor["subject"])
    paths, archives, linked_archives = [], [], []
    for ident in dict.fromkeys(ids):
        if not ident.startswith("archive:"):
            paths.append(ident)
            continue
        version = store.get("version", ident[8:])
        document = store.get("document", version["documentId"])
        if version.get("kbPath"):
            linked_archives.append(version)
        archives.append((document, version))
    if linked_archives:
        catalogue = library(
            actor,
            imports=[
                {
                    "documentId": v.get("kbDocumentId", v["documentId"]),
                    "sha256": v["sha256"],
                }
                for v in linked_archives
            ],
        )
        active_paths = {p.get("path") for p in catalogue.get("papers", [])}
        for version in linked_archives:
            if version["kbPath"] not in active_paths and not pending_archive(version, catalogue):
                raise HTTPException(404, "部分资料已删除或无权访问，请刷新后重新选择")
    binary, content_type = b"", "application/octet-stream"
    if paths:
        result = connect("exportPapers", actor["subject"], paths=paths, format=format)
        try:
            binary = base64.b64decode(result["base64"], validate=True)
        except (KeyError, ValueError, binascii.Error) as exc:
            raise HTTPException(502, "共享资料包返回格式无效") from exc
        content_type = result.get("contentType", content_type)
    if not archives:
        if format == "zip" and binary:
            total = 0
            try:
                with zipfile.ZipFile(io.BytesIO(binary)) as source:
                    for entry in source.infolist():
                        if (
                            not _safe_zip_member_name(entry.filename)
                            or entry.file_size > LIMIT - total
                        ):
                            raise HTTPException(502, "资料包路径或大小无效")
                        content = _read_zip_member_bounded(source, entry, LIMIT - total)
                        total += len(content)
            except zipfile.BadZipFile as exc:
                raise HTTPException(502, "共享资料包校验失败，请重试") from exc
        return binary, content_type
    if format == "zip":
        fingerprints, manifest = {}, []
        total = 0
        with tempfile.SpooledTemporaryFile(max_size=16 * 1024 * 1024) as output:
            try:
                with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as target:
                    if binary:
                        with zipfile.ZipFile(io.BytesIO(binary)) as source:
                            for entry in source.infolist():
                                if (
                                    not _safe_zip_member_name(entry.filename)
                                    or entry.file_size > LIMIT - total
                                ):
                                    raise HTTPException(502, "资料包路径或大小无效")
                                content = _read_zip_member_bounded(source, entry, LIMIT - total)
                                total += len(content)
                                target.writestr(entry.filename, content)
                                if entry.filename.lower().endswith(".pdf"):
                                    fingerprints[hashlib.sha256(content).hexdigest()] = (
                                        entry.filename
                                    )
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
                        if len(content) > LIMIT - total:
                            raise HTTPException(413, "资料包超过100MB，请减少选择后分批导出")
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
            output.seek(0)
            return output.read(), "application/zip"
    entries = [
        {
            **doc.get("metadata", {}),
            "title": doc["title"],
            "url": doc.get("url")
            or f'/api/v1/knowledge-sources/documents/{doc["id"]}/versions/{version["id"]}/original',
            "version": version["id"],
            "sha256": version["sha256"],
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

        def line(value):
            return str(value or "").replace("\r", " ").replace("\n", " ").strip()

        authors = row.get("authors", [])
        authors = [authors] if isinstance(authors, str) else authors
        authors = (
            [line(author) for author in authors if line(author)]
            if isinstance(authors, list)
            else []
        )
        if format == "ris":
            fields = [
                ("TY", "JOUR" if row.get("journal") else "GEN"),
                ("TI", row["title"]),
                *(("AU", author) for author in authors),
                ("PY", row.get("year")),
                ("DO", row.get("doi")),
                ("JO", row.get("journal")),
                ("AB", row.get("abstract")),
                ("UR", row["url"]),
                ("N1", "Version: " + row["version"]),
            ]
            additions.append(
                "\n".join(f"{key}  - {line(value)}" for key, value in fields if line(value))
                + "\nER  -\n"
            )
        else:

            def escape(value):
                special = {
                    "\\": "\\textbackslash{}",
                    "~": "\\textasciitilde{}",
                    "^": "\\textasciicircum{}",
                }
                return re.sub(
                    r"[\\{}%&_#$~^]",
                    lambda match: special.get(match[0], "\\" + match[0]),
                    line(value),
                )

            fields = [
                ("title", row["title"]),
                ("author", " and ".join(authors)),
                ("year", row.get("year")),
                ("doi", row.get("doi")),
                ("journal", row.get("journal")),
                ("abstract", row.get("abstract")),
                ("url", row["url"]),
                ("note", "Version " + row["version"]),
            ]
            kind = "article" if row.get("journal") else "misc"
            body = ",\n".join(
                f"  {key} = {{{escape(value)}}}" for key, value in fields if line(value)
            )
            additions.append(f'@{kind}{{archive{i}_{str(row["sha256"])[:12]},\n{body}\n}}\n')
    return binary + (b"\n" if binary else b"") + "\n".join(
        additions
    ).encode(), "text/plain; charset=utf-8"
