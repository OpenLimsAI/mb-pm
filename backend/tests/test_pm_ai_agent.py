from datetime import date

import pytest
from fastapi import HTTPException

from app.db.session import SessionLocal
from app.models import Project, Task, User
from app.services import pm_ai_agent
from app.services.pm_ai_agent import PlanRequest, plan_question


@pytest.fixture
def project_pair(admin_user, project_factory):
    first, second = (project_factory(admin_user) for _ in range(2))
    with SessionLocal.begin() as db:
        project = db.get(Project, first)
        project.code, project.name = "CMAB007Y", "007Y预充针IND申报项目"
        project = db.get(Project, second)
        project.code, project.name = "CMAB008Y", "008Y制剂开发项目"
        for pid in (first, second):
            db.get(Task, f"{pid}-t1").name = "供应商考察、选定"
    return first, second


def plan(user_id, question, **anchors):
    with SessionLocal() as db:
        return plan_question(db, db.get(User, user_id), PlanRequest(question=question, **anchors))


def test_visible_alias_plans_limited_current_priorities(admin_user, project_pair):
    first, _ = project_pair
    result = plan(admin_user, "请列出 ００７ｙ 项目本周重点的前三项")
    assert result["status"] == "ready"
    assert result["scenario"] == "priorities"
    assert result["project_ids"] == [first]
    assert result["task_ids"] == []
    assert result["limit"] == 3
    assert result["start_date"] is None and result["end_date"] is None
    assert result["targets"][0]["code"] == "CMAB007Y"
    result = plan(admin_user, "项目：《007Y预充针IND申报项目》工作重点top3")
    assert result["status"] == "ready" and result["limit"] == 3
    assert result["project_ids"] == [first]


def test_personal_workbench_priorities_are_explicitly_marked(admin_user):
    result = plan(admin_user, "今天我最需要处理什么？列出前 30 项。")
    assert result["status"] == "ready"
    assert result["scenario"] == "priorities"
    assert result["project_ids"] == []
    assert result["mine_only"]
    assert result["limit"] == 20
    result = plan(admin_user, "列出我的任务优先级")
    assert result["status"] == "ready" and result["mine_only"]
    assert plan(admin_user, "查看前3天的工作重点")["limit"] == 5


@pytest.mark.parametrize("label", ["1007Y", "A007Y", "007Y-2", "陌生项目", "《007Y其他项目》"])
def test_unknown_reference_cannot_fall_back_to_broader_scope(admin_user, project_pair, label):
    first, _ = project_pair
    result = plan(admin_user, f"{label}的工作重点", project_id=first)
    assert result["status"] == "clarify"
    assert result["project_ids"] == []


@pytest.mark.parametrize("question", ["不存在项目本周重点", "UNKNOWN项目本周重点"])
def test_unmatched_named_weekly_priorities_clarify_at_workbench(admin_user, project_pair, question):
    assert plan(admin_user, question)["status"] == "clarify"


def test_duplicate_tasks_require_a_choice_and_anchors_disambiguate(admin_user, project_pair):
    first, second = project_pair
    question = "供应商考察、选定为什么可能延期？"
    result = plan(admin_user, question)
    assert result["status"] == "clarify"
    assert {option["id"] for option in result["choices"]} == {f"{first}-t1", f"{second}-t1"}
    result = plan(admin_user, question, task_id=f"{second}-t1")
    assert result["status"] == "ready"
    assert result["task_ids"] == [f"{second}-t1"]
    assert result["project_ids"] == [second]
    result = plan(admin_user, f"007Y 项目{question}")
    assert result["status"] == "ready" and result["task_ids"] == [f"{first}-t1"]


def test_distinct_named_objects_ask_for_rephrasing_without_dead_end_choices(
    admin_user, project_pair
):
    first, _ = project_pair
    for question, anchors in (
        ("007Y和008Y项目本周重点", {}),
        ("供应商考察、选定和T-2为什么延期", {"project_id": first}),
    ):
        result = plan(admin_user, question, **anchors)
        assert result["status"] == "clarify" and not result["choices"]
        assert "请保留一个" in result["message"]


def test_anchor_blocks_cross_project_and_cross_task_switching(admin_user, project_pair):
    first, second = project_pair
    assert plan(admin_user, "008Y工作重点", project_id=first)["status"] == "clarify"
    assert plan(admin_user, "全部可见项目的工作重点", project_id=first)["status"] == "clarify"
    assert plan(admin_user, "T-2为什么延期", task_id=f"{first}-t1")["status"] == "clarify"
    with pytest.raises(HTTPException) as error:
        plan(admin_user, "工作重点", project_id=first, task_id=f"{second}-t1")
    assert error.value.status_code == 422


def test_scope_matching_uses_only_currently_visible_objects(admin_user, iam_user, project_factory):
    actor = iam_user("pm-agent-member", "rd")
    pid = project_factory(admin_user, member_ids=(actor,))
    hidden = project_factory(admin_user)
    with SessionLocal.begin() as db:
        task = db.get(Task, f"{pid}-t2")
        task.owner_id = admin_user
        task.code, task.name = "PRIVATE-42", "不可见任务名称"
        project = db.get(Project, hidden)
        project.code, project.name = "CMAB099Z", "不可见项目名称"
    for question in ("PRIVATE-42为什么延期", "099Z项目工作重点"):
        result = plan(actor, question)
        assert result["status"] == "clarify"
        assert not result["choices"] and not result["targets"]
    with pytest.raises(HTTPException) as error:
        plan(actor, "工作重点", task_id=f"{pid}-t2")
    assert error.value.status_code == 404
    result = plan(actor, "生成周报")
    assert result["status"] == "clarify"
    assert [option["id"] for option in result["choices"]] == [pid]
    schedule = plan(actor, "顺延5个工作日", task_id=f"{pid}-t1")
    assert schedule["status"] == "clarify" and not schedule["delays"]
    assert "项目管理权限" in schedule["message"]


def test_period_is_bounded_to_the_requested_reporting_week(admin_user, project_pair, monkeypatch):
    first, _ = project_pair

    class FixedDate(date):
        @classmethod
        def today(cls):
            return date(2026, 11, 10)

    monkeypatch.setattr(pm_ai_agent, "date", FixedDate)
    result = plan(admin_user, "生成007Y上周周报")
    assert result["status"] == "ready" and result["scenario"] == "weekly"
    assert result["start_date"] == "2026-11-02" and result["end_date"] == "2026-11-08"
    result = plan(admin_user, "本周周报", project_id=first)
    assert result["start_date"] == "2026-11-09" and result["end_date"] == "2026-11-10"
    assert plan(admin_user, "生成007Y本周和上周周报")["status"] == "clarify"


def test_schedule_only_parses_explicit_supported_comparisons(admin_user, project_pair):
    first, _ = project_pair
    result = plan(admin_user, "007Y排期比较，供应商考察、选定顺延3、五个工作日。")
    assert result["status"] == "ready" and result["scenario"] == "schedule"
    assert result["task_ids"] == [f"{first}-t1"]
    assert result["delays"] == [3, 5]
    result = plan(admin_user, "供应商考察、选定顺延1或25个工作日", project_id=first)
    assert result["status"] == "ready" and result["delays"] == [1, 25]
    for question in (
        "顺延5个工作日，固定申报节点",
        "顺延5个工作日到8个工作日",
        "顺延5天",
        "顺延5.5个工作日",
        "顺延-十五个工作日",
        "顺延一、二、三、四个工作日",
    ):
        result = plan(admin_user, question, task_id=f"{first}-t1")
        assert result["status"] == "clarify" and not result["delays"], question


@pytest.mark.parametrize(
    ("question", "scenario"),
    [("整理会议纪要", "meeting"), ("看措施落实情况", "followup"), ("生成周报并比较排期", None)],
)
def test_routing_handles_other_scenarios_and_ambiguous_intent(
    admin_user, project_pair, question, scenario
):
    first, _ = project_pair
    result = plan(admin_user, question, project_id=first)
    assert result["status"] == ("ready" if scenario else "clarify")
    assert result["scenario"] == scenario
