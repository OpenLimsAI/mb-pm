from io import BytesIO

import pytest
from openpyxl import Workbook, load_workbook
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.db.business_constraints import violations
from app.db.session import SessionLocal
from app.models import Task
from app.schemas.project import ProjectImportRequest
from app.schemas.task import TaskCreate
from app.schemas.template import TemplateCreate, TemplateVersionCreate
from app.services.excel import export_template_to_xlsx, parse_excel


@pytest.mark.parametrize(
    "payload",
    [
        {"progress": 101},
        {"progress": -1},
        {"progress": None},
        {"actual_cost": -1},
        {"estimated_effort": -1},
        {"actual_effort": 10000},
        {"status": "INVALID"},
        {"status": None},
        {"priority": "INVALID"},
    ],
)
def test_task_patch_rejects_invalid_values(client, iam_user, bearer, project_factory, payload):
    uid = iam_user("secure-task-admin", "admin")
    pid = project_factory(uid)
    result = client.patch(f"/api/v1/tasks/{pid}-t1", headers=bearer(uid, "admin"), json=payload)
    assert result.status_code == 422
    with SessionLocal() as db:
        assert db.get(Task, f"{pid}-t1").progress == 0


def test_partial_patch_checks_unchanged_counterpart(client, iam_user, bearer, project_factory):
    uid = iam_user("secure-date-admin", "admin")
    pid = project_factory(uid)
    headers = bearer(uid, "admin")
    assert (
        client.patch(
            f"/api/v1/tasks/{pid}-t1", headers=headers, json={"planned_end": "2025-01-01"}
        ).status_code
        == 422
    )
    assert (
        client.patch(
            f"/api/v1/projects/{pid}", headers=headers, json={"planned_start": "2027-01-01"}
        ).status_code
        == 422
    )
    assert (
        client.patch(
            f"/api/v1/tasks/{pid}-t1", headers=headers, json={"actual_start": "2026-05-01"}
        ).status_code
        == 200
    )
    assert (
        client.patch(
            f"/api/v1/tasks/{pid}-t1", headers=headers, json={"actual_end": "2026-04-01"}
        ).status_code
        == 422
    )


def test_import_task_uses_same_validation():
    with pytest.raises(ValidationError):
        TaskCreate(
            code="T",
            name="T",
            sub_project_id="s",
            owner_id="u",
            progress=200,
            planned_start="2026-02-01",
            planned_end="2026-01-01",
        )
    with pytest.raises(ValidationError):
        ProjectImportRequest.model_validate(
            {
                "project": {
                    "code": "P",
                    "name": "P",
                    "product_type": "单抗",
                    "current_stage": "IND",
                    "target_stage": "BLA",
                    "owner_id": "u",
                    "status": "活跃",
                    "health": "green",
                    "planned_start": "2026-01-01",
                    "planned_end": "2026-12-01",
                },
                "finance": {"project_id": "P", "total_budget": -1},
            }
        )


def test_database_rejects_bypass_and_check_is_read_only(client, iam_user, project_factory):
    pid = project_factory(iam_user("secure-db-admin", "admin"))
    with SessionLocal() as db:
        assert violations(db.connection()) == {}
        with pytest.raises(IntegrityError):
            db.execute(text("UPDATE tasks SET progress=200 WHERE id=:id"), {"id": f"{pid}-t1"})
            db.commit()
        db.rollback()
        assert db.get(Task, f"{pid}-t1").progress == 0


@pytest.mark.parametrize("value", ["=1+1", "+SUM(A1)", "-1+1", "@SUM(A1)", "普通论文名称"])
def test_excel_text_remains_text(value):
    data = export_template_to_xlsx(
        "test", "V1", {"children": [{"name": value, "notes": value, "children": []}]}
    )
    workbook = load_workbook(BytesIO(data), data_only=False)
    for coordinate in ("A2", "E2"):
        cell = workbook["子项目清单"][coordinate]
        assert cell.data_type == "s" and cell.value == value


@pytest.mark.parametrize(
    "field,value",
    [
        ("defaultEffort", -1),
        ("defaultEffort", "NaN"),
        ("defaultEffort", 10000),
        ("defaultDuration", -3),
        ("defaultDuration", 1.5),
    ],
)
def test_template_inputs_reject_invalid_numbers(field, value):
    tree = {"children": [{"children": [{field: value}]}]}
    with pytest.raises(ValidationError):
        TemplateCreate(name="T", product_type="单抗", initial_structure=tree)
    with pytest.raises(ValidationError):
        TemplateVersionCreate(version_number="V1", structure_json=tree)


def test_excel_negative_effort_is_not_saved():
    data = export_template_to_xlsx(
        "T",
        "V1",
        {
            "children": [
                {"name": "S", "children": [{"taskCode": "T1", "name": "T", "defaultEffort": -1}]}
            ]
        },
    )
    result, errors = parse_excel(data)
    assert result is None and any("defaultEffort" in error.message for error in errors)


def test_excel_rejects_archive_expansion_before_parser(monkeypatch):
    from zipfile import ZIP_DEFLATED, ZipFile

    from app.services import excel

    stream = BytesIO()
    with ZipFile(stream, "w", ZIP_DEFLATED) as archive:
        archive.writestr("xl/worksheets/sheet1.xml", b"x" * (10 * 1024 * 1024 + 1))

    def unexpected(*args, **kwargs):
        pytest.fail("oversized archive reached XML parser")

    monkeypatch.setattr(excel, "load_workbook", unexpected)
    result, errors = parse_excel(stream.getvalue())
    assert result is None and "10 MiB" in errors[0].message


def test_excel_rejects_excessive_dimensions():
    workbook = Workbook()
    workbook.active["A10002"] = "outside limit"
    stream = BytesIO()
    workbook.save(stream)
    result, errors = parse_excel(stream.getvalue())
    assert result is None and "10000" in errors[0].message


def test_excel_valid_roundtrip_still_works():
    data = export_template_to_xlsx(
        "T",
        "V1",
        {
            "children": [
                {"name": "S", "children": [{"taskCode": "T1", "name": "T", "defaultEffort": 10}]}
            ]
        },
    )
    result, errors = parse_excel(data)
    assert not errors and result["children"][0]["children"][0]["defaultEffort"] == 10
