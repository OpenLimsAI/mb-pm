# ruff: noqa: F811
"""Real multipart extraction, signed-bridge contract and original preservation."""

import base64
import hashlib
import importlib.util
from pathlib import Path

from test_information_api import live  # noqa: F401
from test_information_live import catalogue, store  # noqa: F401
from test_information_portal import information_portal  # noqa: F401
from test_knowledge_source_library_v3 import library_v3  # noqa: F401
from test_knowledge_sources import headers, ks, records  # noqa: F401

from app.models.information import InformationText
from app.services.information import bridge


def math_pdf():
    spec = importlib.util.spec_from_file_location(
        "pdf_fixture", Path(__file__).with_name("test_pdf_extraction_sanitization.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module._pdf(
        b"(A synthetic uploaded mathematical paper contains enough meaningful evidence. "
        b"Its original bytes stay unchanged while an invalid glyph left\\000right is removed.) Tj"
    )


def test_real_pdf_upload_sanitizes_text_and_preserves_original_and_retry_identity(
    library_v3, monkeypatch
):
    client, db, session, _, _, calls, _, _ = library_v3
    original = math_pdf()
    connected = bridge.call
    uploads = []

    def validate_like_kb(operation, subject, **values):
        if operation == "uploadPaper":
            assert "\x00" not in values["text"], "Deployed KB rejects NUL before saving"
            assert "leftright" in values["text"]
            assert base64.b64decode(values["originalBase64"]) == original
            assert values["sha256"] == hashlib.sha256(original).hexdigest()
            assert values["parse"] is False
            uploads.append(values)
        return connected(operation, subject, **values)

    monkeypatch.setattr(bridge, "call", validate_like_kb)
    responses = [
        client.post(
            "/api/v1/knowledge-sources/v3/upload",
            headers=headers(session),
            files={"file": ("math.pdf", original, "application/pdf")},
            data={"parse": "false"},
        )
        for _ in range(2)
    ]
    assert all(response.status_code == 201 for response in responses)
    assert all(response.json()["originalSaved"] is True for response in responses)
    assert responses[0].json()["paperId"] == responses[1].json()["paperId"]
    store = records(db)
    versions = store.records("version")
    assert len(versions) == 1 and store.archive_path(versions[0]).read_bytes() == original
    text = db.get(InformationText, versions[0]["id"]).content
    assert "\x00" not in text and "leftright" in text
    assert len(uploads) == 2
