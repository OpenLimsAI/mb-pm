"""Existing project data makes a validated, atomic Excel round trip."""

from io import BytesIO
from zipfile import ZIP_DEFLATED, ZipFile

from openpyxl import load_workbook

from app.db.session import SessionLocal
from app.models import AuditLog, Project, Task
from app.models.task_collaboration import TaskAcceptance, TaskActivity


def prefix(pid):
    return f"/api/v1/project-exchange/projects/{pid}"


def exported(client, headers, pid):
    response = client.get(prefix(pid) + "/export", headers=headers)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.content


def edit(data, callback):
    wb = load_workbook(BytesIO(data))
    callback(wb)
    output = BytesIO()
    wb.save(output)
    wb.close()
    return output.getvalue()


def cell(wb, row, label, value):
    sheet = wb["项目任务"]
    headers = [c.value for c in sheet[1]]
    sheet.cell(row, headers.index(label) + 1, value)


def preview(client, headers, pid, data):
    response = client.post(
        prefix(pid) + "/preview", headers=headers, files={"file": ("项目.xlsx", data)}
    )
    assert response.status_code == 200, response.text
    return response.json()


def apply(client, headers, pid, data, fingerprint):
    return client.post(
        prefix(pid) + "/apply",
        headers=headers,
        files={"file": ("项目.xlsx", data)},
        data={"fingerprint": fingerprint, "reason": "核对后回导"},
    )


def test_excel_roundtrip_zero_chinese_clear_rollup_and_audit(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    with SessionLocal() as db:
        task = db.get(Task, f"{pid}-t1")
        task.actual_cost, task.actual_effort, task.notes = 12, 3, "旧备注"
        db.commit()
    data = exported(client, auth_headers, pid)

    def change(wb):
        for label, value in [
            ("任务名称", "中文进度回导"),
            ("进度(%)", 50),
            ("实际花费(万元)", 0),
            ("实际工时(人天)", 0),
        ]:
            cell(wb, 2, label, value)
        wb["项目任务"].cell(2, 18).value = None  # 备注

    data = edit(data, change)
    result = preview(client, auth_headers, pid, data)
    assert result["errors"] == [] and result["changed_count"] == 1
    with SessionLocal() as db:
        assert db.get(Task, f"{pid}-t1").progress == 0
    response = apply(client, auth_headers, pid, data, result["fingerprint"])
    assert response.status_code == 200, response.text
    with SessionLocal() as db:
        task = db.get(Task, f"{pid}-t1")
        assert task.progress == 50 and task.name == "中文进度回导"
        assert task.actual_cost == 0 and task.actual_effort == 0 and task.notes is None
        assert db.get(Project, pid).progress == 25
        assert db.query(TaskActivity).filter_by(task_id=task.id, kind="change").count() == 1
        assert db.query(AuditLog).filter_by(target_id=pid, action="项目 Excel 回导").count() == 1
    fresh = exported(client, auth_headers, pid)
    assert preview(client, auth_headers, pid, fresh)["changed_count"] == 0


def test_column_order_is_mapped_and_removed_rows_do_not_delete(
    client, auth_headers, project_factory
):
    pid = project_factory("t-admin")

    def change(wb):
        cell(wb, 2, "进度(%)", 10)
        sheet = wb["项目任务"]
        rows = list(sheet.values)
        sheet.delete_rows(1, sheet.max_row)
        for row in rows[:2]:
            sheet.append(list(reversed(row)))

    data = edit(exported(client, auth_headers, pid), change)
    result = preview(client, auth_headers, pid, data)
    assert result["row_count"] == 1 and result["can_apply"]
    assert apply(client, auth_headers, pid, data, result["fingerprint"]).status_code == 200
    with SessionLocal() as db:
        assert db.get(Task, f"{pid}-t2") is not None


def test_any_row_invalid_prevents_whole_import(client, auth_headers, project_factory):
    pid = project_factory("t-admin")

    def change(wb):
        cell(wb, 2, "进度(%)", 10)
        cell(wb, 3, "实际花费(万元)", -2)

    data = edit(exported(client, auth_headers, pid), change)
    result = preview(client, auth_headers, pid, data)
    assert not result["can_apply"] and result["errors"][0]["row"] == 3
    assert apply(client, auth_headers, pid, data, result["fingerprint"]).status_code == 422
    with SessionLocal() as db:
        assert db.get(Task, f"{pid}-t1").progress == 0


def test_stale_file_and_changes_after_preview_never_overwrite(
    client, auth_headers, project_factory
):
    pid = project_factory("t-admin")
    data = edit(exported(client, auth_headers, pid), lambda wb: cell(wb, 2, "进度(%)", 30))
    result = preview(client, auth_headers, pid, data)
    changed_file = edit(data, lambda wb: cell(wb, 2, "进度(%)", 70))
    assert apply(client, auth_headers, pid, changed_file, result["fingerprint"]).status_code == 409
    with SessionLocal() as db:
        db.get(Task, f"{pid}-t1").notes = "其他人已保存"
        db.commit()
    assert apply(client, auth_headers, pid, data, result["fingerprint"]).status_code == 409
    assert any(
        "已变化" in error["message"] for error in preview(client, auth_headers, pid, data)["errors"]
    )


def test_identity_and_resulting_date_validation(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    original = exported(client, auth_headers, pid)
    for label, value in [
        ("任务ID", "other-task"),
        ("任务编号", "tampered"),
        ("进度(%)", 1.5),
        ("计划开始", "2027-01-01"),
        ("负责人", "不存在的成员"),
    ]:
        data = edit(original, lambda wb, label=label, value=value: cell(wb, 2, label, value))
        result = preview(client, auth_headers, pid, data)
        assert result["errors"] and not result["can_apply"], label


def test_exported_text_is_never_formula_and_import_rejects_formulas(
    client, auth_headers, project_factory
):
    pid = project_factory("t-admin")
    with SessionLocal() as db:
        db.get(Task, f"{pid}-t1").name = '=HYPERLINK("https://example.test")'
        db.commit()
    data = exported(client, auth_headers, pid)
    wb = load_workbook(BytesIO(data), data_only=False)
    assert wb["项目任务"].cell(2, 5).data_type == "s"
    wb.close()
    assert preview(client, auth_headers, pid, data)["errors"] == []
    data = edit(data, lambda wb: cell(wb, 2, "任务名称", "=1+1"))
    assert "公式" in preview(client, auth_headers, pid, data)["errors"][0]["message"]


def test_scope_and_only_actual_project_owner_can_import(
    client, auth_headers, project_factory, iam_user, bearer
):
    lead = iam_user("excel-lead", "project_lead")
    member = iam_user("excel-member", "project_lead")
    executor = iam_user("excel-rd", "rd")
    pid = project_factory(lead, (member, executor))
    for uid, role in [(member, "project_lead"), (executor, "rd")]:
        response = client.get(prefix(pid) + "/export", headers=bearer(uid, role))
        assert response.status_code == 403
        assert (
            client.post(
                prefix(pid) + "/preview", headers=bearer(uid, role), content=b"not a workbook"
            ).status_code
            == 403
        )
    assert (
        client.get(prefix(pid) + "/export", headers=bearer(lead, "project_lead")).status_code == 200
    )
    other = project_factory("t-admin")
    assert (
        client.get(prefix(other) + "/export", headers=bearer(lead, "project_lead")).status_code
        == 404
    )


def test_wrong_project_template_and_zip_bomb_are_rejected(client, auth_headers, project_factory):
    from app.services.excel import generate_blank_template_xlsx

    pid, other = project_factory("t-admin"), project_factory("t-admin")
    for data in [
        exported(client, auth_headers, other),
        generate_blank_template_xlsx(),
        b"not a zip",
    ]:
        assert preview(client, auth_headers, pid, data)["errors"]
    output = BytesIO()
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        archive.writestr("oversized.xml", b"0" * (10 * 1024 * 1024 + 1))
    assert "10 MiB" in preview(client, auth_headers, pid, output.getvalue())["errors"][0]["message"]


def test_milestone_import_cannot_bypass_acceptance_and_resets_after_edit(
    client, auth_headers, project_factory
):
    pid = project_factory("t-admin")
    task_id = f"{pid}-t1"
    with SessionLocal() as db:
        task = db.get(Task, task_id)
        task.is_milestone = True
        db.add(TaskAcceptance(task_id=task_id, reviewer_id="t-admin", state="draft"))
        db.commit()
    data = edit(exported(client, auth_headers, pid), lambda wb: cell(wb, 2, "状态", "已验证"))
    assert "验收" in preview(client, auth_headers, pid, data)["errors"][0]["message"]
    with SessionLocal() as db:
        db.get(TaskAcceptance, task_id).state = "accepted"
        db.get(Task, task_id).status = "已验证"
        db.commit()
    data = edit(
        exported(client, auth_headers, pid), lambda wb: cell(wb, 2, "备注", "已验收后有调整")
    )
    result = preview(client, auth_headers, pid, data)
    assert result["changes"][0]["resubmit_acceptance"]
    assert any(
        change["field"] == "状态" and change["after"] == "已完成"
        for change in result["changes"][0]["changes"]
    )
    assert apply(client, auth_headers, pid, data, result["fingerprint"]).status_code == 200
    with SessionLocal() as db:
        assert db.get(TaskAcceptance, task_id).state == "draft"
        assert db.get(Task, task_id).status == "已完成"
