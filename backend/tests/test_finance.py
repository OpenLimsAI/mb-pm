"""项目预算：已花费由任务实际花费实时汇总、管理员 / CMC 负责人维护预算、执行层不能改任务预算，
以及与项目分析共用一套体系的财务 AI 分析。"""

import json
from uuid import uuid4

import pytest

from app.core.config import settings
from app.db.session import SessionLocal
from app.models import AuditLog, FinanceAIAnalysis, ProjectFinance, Task
from app.schemas.ai import AISettingsInput
from app.services import ai

CATEGORIES = ("人力", "设备", "原材料", "外部服务", "其他")


@pytest.fixture(autouse=True)
def isolated_ai_settings(tmp_path, monkeypatch, live_ai_roles):
    monkeypatch.setattr(settings, "AI_SETTINGS_PATH", str(tmp_path / "ai.json"))


def set_costs(project_id: str, **costs: tuple[float | None, float | None]) -> None:
    """set_costs(pid, t1=(任务预算, 实际花费), ...)"""
    with SessionLocal() as db:
        for suffix, (budget, actual) in costs.items():
            task = db.get(Task, f"{project_id}-{suffix}")
            task.cost_budget, task.actual_cost = budget, actual
        db.commit()


def finance_of(client, headers, project_id):
    rows = client.get("/api/v1/finances", headers=headers).json()
    return next((r for r in rows if r["project_id"] == project_id), None)


def budget_body(**overrides):
    return {
        "total_budget": 250,
        "committed": 40,
        "breakdown": {"人力": 10},
        "fiscal_year": " 2026-2027 ",
        "notes": "年度预算",
        **overrides,
    }


def enable_ai(**prompts):
    cfg = ai.public_settings(ai.load_settings())
    cfg["providers"]["deepseek"]["api_key"] = "test-secret-not-real"
    cfg.update(prompts)
    ai.save_settings(AISettingsInput(**cfg))


# —— 已花费 = 任务实际花费合计 —— #


def test_spent_is_rolled_up_from_task_actual_costs(client, auth_headers, project_factory):
    pid = project_factory("t-admin")  # 表里的历史 spent = 10，不再采用
    assert finance_of(client, auth_headers, pid)["spent"] == 0
    set_costs(pid, t1=(30, 12.5), t2=(20, 7.25))
    row = finance_of(client, auth_headers, pid)
    assert (row["spent"], row["task_budget"], row["total_budget"], row["committed"]) == (
        19.75,
        50,
        100,
        5,
    )
    # 录入实际花费后立即反映到项目已花费
    res = client.patch(f"/api/v1/tasks/{pid}-t2", json={"actual_cost": 20}, headers=auth_headers)
    assert res.status_code == 200
    assert finance_of(client, auth_headers, pid)["spent"] == 32.5
    # 项目 AI 分析的快照同样用汇总值
    with SessionLocal() as db:
        from app.models import Project

        context, _ = ai.project_context(db, db.get(Project, pid))
    assert context["finance"]["spent"] == 32.5 and context["finance"]["task_budget"] == 50


def test_project_import_does_not_take_spent_from_client(client, auth_headers):
    code = f"IMP-{uuid4().hex[:6]}"
    body = {
        "project": {
            "code": code,
            "name": "导入项目",
            "product_type": "单抗",
            "current_stage": "IND",
            "target_stage": "BLA",
            "owner_id": "t-admin",
            "status": "活跃",
            "health": "green",
            "planned_start": "2026-01-01",
            "planned_end": "2026-12-31",
        },
        "finance": {"project_id": "ignored", "total_budget": 300, "spent": 999, "committed": 0},
    }
    res = client.post("/api/v1/projects/import", json=body, headers=auth_headers)
    assert res.status_code == 201, res.text
    pid = res.json()["id"]
    row = finance_of(client, auth_headers, pid)
    assert (row["total_budget"], row["spent"]) == (300, 0)
    assert client.delete(f"/api/v1/projects/{pid}", headers=auth_headers).status_code == 204


# —— 预算维护：admin / cmc_lead —— #


def test_admin_and_cmc_lead_maintain_budget_with_audit(
    client, auth_headers, project_factory, iam_user, bearer
):
    pid = project_factory("t-admin")
    set_costs(pid, t1=(30, 12), t2=(None, None))
    res = client.put(f"/api/v1/finances/{pid}", json=budget_body(), headers=auth_headers)
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["total_budget"] == 250 and out["committed"] == 40 and out["spent"] == 12
    assert out["breakdown"] == {c: (10 if c == "人力" else 0) for c in CATEGORIES}
    assert (out["fiscal_year"], out["notes"]) == ("2026-2027", "年度预算")
    assert finance_of(client, auth_headers, pid)["total_budget"] == 250

    lead = iam_user(f"t-cmc-{uuid4().hex[:6]}", "cmc_lead")
    body = budget_body(total_budget=260, notes="  ")
    res = client.put(f"/api/v1/finances/{pid}", json=body, headers=bearer(lead, "cmc_lead"))
    assert res.status_code == 200 and res.json()["notes"] is None

    with SessionLocal() as db:
        logs = (
            db.query(AuditLog)
            .filter_by(target="项目预算", target_id=pid[:40])
            .order_by(AuditLog.created_at)
            .all()
        )
    assert [log.actor_id for log in logs] == ["t-admin", lead]
    changes = json.loads(logs[-1].detail)["changes"]
    assert changes["total_budget"] == [250.0, 260.0] and changes["notes"] == ["年度预算", None]
    assert "committed" not in changes  # 只记录变化的字段


def test_budget_edit_permissions_and_validation(
    client, auth_headers, project_factory, iam_user, bearer
):
    lead = iam_user(f"t-pl-{uuid4().hex[:6]}", "project_lead")
    member = iam_user(f"t-rd-{uuid4().hex[:6]}", "rd")
    pid = project_factory(lead, member_ids=(member,))
    other = project_factory("t-admin")
    url = f"/api/v1/finances/{pid}"
    # 与「编辑项目」一致：旧角色 project_lead 只能改本人负责 / 参与的项目；执行层不能改
    lead_headers = bearer(lead, "project_lead")
    assert (
        client.put(
            f"/api/v1/finances/{other}", json=budget_body(), headers=lead_headers
        ).status_code
        == 403
    )
    assert client.put(url, json=budget_body(), headers=lead_headers).status_code == 200
    assert client.put(url, json=budget_body(), headers=bearer(member, "rd")).status_code == 403
    assert client.put(url, json=budget_body()).status_code == 401
    for bad in [
        budget_body(spent=1),  # 已花费不能手工填写
        budget_body(total_budget=-1),
        budget_body(committed=100_000_000),
        budget_body(breakdown={"差旅": 1}),
        budget_body(breakdown={"设备": -5}),
        budget_body(notes="换行\n注入"),
        budget_body(notes="长" * 201),
    ]:
        assert client.put(url, json=bad, headers=auth_headers).status_code == 422, bad
    assert (
        client.put("/api/v1/finances/no-such", json=budget_body(), headers=auth_headers).status_code
        == 404
    )


def test_budget_can_be_set_for_project_without_finance(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    with SessionLocal() as db:
        db.query(ProjectFinance).filter_by(project_id=pid).delete()
        db.commit()
    assert finance_of(client, auth_headers, pid) is None
    res = client.put(f"/api/v1/finances/{pid}", json=budget_body(), headers=auth_headers)
    assert res.status_code == 200
    assert finance_of(client, auth_headers, pid)["total_budget"] == 250
    with SessionLocal() as db:
        log = db.query(AuditLog).filter_by(target="项目预算", target_id=pid[:40]).one()
    assert log.action == "设置项目预算"


# —— 执行层不能改任务预算 —— #


def test_executor_records_actual_cost_but_cannot_change_task_budget(
    client, project_factory, iam_user, bearer
):
    lead = iam_user(f"t-pl-{uuid4().hex[:6]}", "project_lead")
    member = iam_user(f"t-rd-{uuid4().hex[:6]}", "rd")
    pid = project_factory(lead, member_ids=(member,), task_owner_id=member)
    set_costs(pid, t1=(30, None))
    url = f"/api/v1/tasks/{pid}-t1"
    res = client.patch(url, json={"cost_budget": 99}, headers=bearer(member, "rd"))
    assert res.status_code == 403 and "任务预算" in res.json()["detail"]
    res = client.patch(
        url, json={"actual_cost": 12, "cost_budget": 30}, headers=bearer(member, "rd")
    )
    assert res.status_code == 403  # 连同其他字段一起提交也不行
    res = client.patch(url, json={"actual_cost": 12, "progress": 40}, headers=bearer(member, "rd"))
    assert res.status_code == 200 and float(res.json()["actual_cost"]) == 12
    res = client.patch(url, json={"cost_budget": 45}, headers=bearer(lead, "project_lead"))
    assert res.status_code == 200 and float(res.json()["cost_budget"]) == 45


# —— 财务 AI 分析 —— #


def test_finance_prompt_default_custom_reset_and_status(client, auth_headers, live_ai_roles):
    current = client.get("/api/v1/ai/settings", headers=auth_headers).json()
    assert current["finance_analysis_prompt"] == ai.DEFAULT_FINANCE_ANALYSIS_PROMPT
    assert current["default_finance_analysis_prompt"] == ai.DEFAULT_FINANCE_ANALYSIS_PROMPT
    payload = {**current, "providers": current["providers"]}
    payload["providers"]["deepseek"]["api_key"] = "test-secret-not-real"
    payload["finance_analysis_prompt"] = "只列出超支项目及原因。"
    saved = client.put("/api/v1/ai/settings", json=payload, headers=auth_headers).json()
    assert saved["finance_analysis_prompt"] == "只列出超支项目及原因。"
    assert saved["analysis_prompt"] == ai.DEFAULT_ANALYSIS_PROMPT  # 两套提示词互不影响
    status = client.get("/api/v1/ai/status", headers=auth_headers).json()
    assert status["finance_analysis_prompt"] == "只列出超支项目及原因。"
    payload["finance_analysis_prompt"] = ai.DEFAULT_FINANCE_ANALYSIS_PROMPT
    client.put("/api/v1/ai/settings", json=payload, headers=auth_headers)
    assert json.loads(open(settings.AI_SETTINGS_PATH).read())["finance_analysis_prompt"] == ""
    payload["finance_analysis_prompt"] = "长" * 4001
    assert client.put("/api/v1/ai/settings", json=payload, headers=auth_headers).status_code == 422


def test_finance_context_budget_execution_overruns_and_gaps(client, project_factory):
    pid = project_factory("t-admin")  # 总预算 100、已承诺 5
    set_costs(pid, t1=(10, 15), t2=(40, None))
    with SessionLocal() as db:
        db.get(Task, f"{pid}-t2").progress = 30
        db.commit()
        context, source = ai.finance_context(db)
    row = next(p for p in context["projects"] if p["code"] == pid.upper())
    assert row["finance"]["spent"] == 15 and row["task_budget_total"] == 50
    assert row["finance"]["remaining"] == 80 and row["finance"]["execution_rate_pct"] == 20.0
    assert row["finance"]["over_budget"] is False
    assert row["cost_overruns"] == [
        {
            "code": "T-1",
            "name": "测试任务 1",
            "status": "未开始",
            "progress": 0,
            "cost_budget": 10.0,
            "actual_cost": 15.0,
            "over_by": 5.0,
        }
    ]
    assert row["started_without_actual_cost"] == {"count": 1, "codes": ["T-2"]}
    assert "email" not in json.dumps(context)  # 快照不含成员邮箱
    assert source["budget_unit"] == "万元人民币" and len(source["fingerprint"]) == 64
    with SessionLocal() as db:
        db.get(ProjectFinance, pid).committed = 90
        db.commit()
        context, _ = ai.finance_context(db)
    row = next(p for p in context["projects"] if p["code"] == pid.upper())
    assert row["finance"]["over_budget"] is True
    assert pid.upper() in context["portfolio"]["over_budget_projects"]


def test_finance_analysis_generation_history_and_staleness(
    client, auth_headers, project_factory, monkeypatch
):
    pid = project_factory("t-admin")
    set_costs(pid, t1=(10, 4), t2=(20, None))
    enable_ai(finance_analysis_prompt="默认：先看超支项目。")
    prompts = []

    def mock_chat(provider, cfg, messages):
        prompts.append(messages)
        return "## 财务摘要\n测试", {"total_tokens": 10, "secret": "x"}

    monkeypatch.setattr(ai, "chat", mock_chat)
    endpoint = "/api/v1/finances/ai-analyses"
    res = client.post(endpoint, headers=auth_headers, json={"focus": "现金流"})
    assert res.status_code == 201, res.text
    report = res.json()
    user_message = prompts[0][1]["content"]
    assert user_message.startswith("默认：先看超支项目。") and "现金流" in user_message
    assert "项目组合财务数据快照" in user_message and pid.upper() in user_message
    assert "以上原则为准" in prompts[0][0]["content"]
    assert report["prompt"] == "默认：先看超支项目。" and report["stale"] is False
    assert "secret" not in report["usage"] and report["source"]["project_count"] >= 1
    assert client.get(endpoint, headers=auth_headers).json()[0]["id"] == report["id"]

    temp = client.post(endpoint, headers=auth_headers, json={"prompt": "临时：只给三条建议。"})
    assert prompts[1][1]["content"].startswith("临时：只给三条建议。")
    assert temp.json()["prompt"] == "临时：只给三条建议。"
    assert ai.load_settings()["finance_analysis_prompt"] == "默认：先看超支项目。"

    set_costs(pid, t2=(20, 6))  # 录入实际花费 → 旧报告过期
    rows = client.get(endpoint, headers=auth_headers).json()
    assert [r["stale"] for r in rows[:2]] == [True, True]


def test_finance_analysis_permissions_and_failures(
    client, auth_headers, iam_user, bearer, monkeypatch
):
    endpoint = "/api/v1/finances/ai-analyses"
    for role in ("project_lead", "rd", "qa_qc"):
        headers = bearer(iam_user(f"t-{role[:4]}-{uuid4().hex[:6]}", role), role)
        assert client.get(endpoint, headers=headers).status_code == 403
        assert client.post(endpoint, headers=headers, json={}).status_code == 403
    assert client.get(endpoint).status_code == 401

    def fail(*args, **kwargs):
        raise ai.AIError("模型未配置")

    monkeypatch.setattr(ai, "analyze", fail)
    with SessionLocal() as db:
        before = db.query(FinanceAIAnalysis).count()
    assert client.post(endpoint, headers=auth_headers, json={}).status_code == 502
    with SessionLocal() as db:
        assert db.query(FinanceAIAnalysis).count() == before
