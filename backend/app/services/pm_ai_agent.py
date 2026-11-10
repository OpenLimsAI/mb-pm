"""Resolve a question into a reviewable, permission-scoped project operation."""

import re
import unicodedata
from dataclasses import asdict, dataclass
from datetime import date, timedelta
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app.models import Project, SubProject, Task
from app.services.pm_ai_context import MANAGERS
from app.services.project_schedule_assist import delay_count
from app.services.scope import visible_project_ids_for, visible_task_ids_for

Scenario = Literal["priorities", "explain", "weekly", "meeting", "followup", "schedule"]
MAX_CHOICES = 8
MAX_LIMIT = 20
COUNT = r"[0-9零一二两三四五六七八九十百]{1,7}"
LIMIT = re.compile(
    rf"(?<![a-z0-9_-])top\s*({COUNT})(?![0-9a-z.])|"
    rf"(?:前|列(?:出)?|给我|(?:优先跟进|优先处理|最需要处理)的)\s*({COUNT})\s*"
    r"(?:项|条|件|个(?!\s*(?:工作|项目|月|人))|(?=$|[、。,.!?;]))"
)
WORKDAYS = re.compile(
    rf"(?<![0-9零一二两三四五六七八九十百.+-])((?:{COUNT}个?(?:、|,|/|和|或者|或|与))*{COUNT})个?工作(?:日|天)"
)
CODE_TOKEN = re.compile(r"(?<![a-z0-9_-])[a-z0-9][a-z0-9_-]{1,79}(?![a-z0-9_-])")
QUOTED_NAME = re.compile(r'《([^》]+)》|「([^」]+)」|“([^”]+)”|"([^"]+)"')
DEICTIC = re.compile(r"(?:当前|此|这[个项]?|该|本)(?:项目|任务)")
ALL_PROJECTS = re.compile(r"(?:所有|全部|全体|跨)(?:可见)?项目")
ALL_TASKS = re.compile(r"(?:所有|全部|全体)(?:可见)?任务")
MINE = re.compile(r"我的任务|我负责|我(?:今天|现在|当前)?最需要|今天我该")
SCHEDULE_FILLER = re.compile(
    r"当前任务|这个任务|这项任务|该任务|本任务|向后|顺延|延迟|推迟|延期|延后|"
    r"比较|推演|模拟|试算|排期|方案|会有什么影响|影响|分别|假设|如果|会怎样|怎么样|可以吗|"
    r"请|帮我|把|将|任务|看看|查看|晚|一下|的|吗|或者|或|和|与|[、。,.!?;:/()《》「」“”\"]"
)

INTENTS: dict[Scenario, str] = {
    "priorities": r"工作重点|(?:本周|这周|今天|今日)重点|重点事项|优先事项|优先(?:处理|跟进|任务)|优先级|待办|"
    r"最(?:需要|应该|该)处理|先(?:做|处理|跟进)|最需要做",
    "explain": r"异常|(?:为什么|为何|原因|解释|归因).{0,18}(?:延期|延误|延迟|阻塞|风险)|"
    r"(?:延期|延误|延迟|阻塞|风险).{0,12}(?:原因|为什么|为何|解释)|瓶颈",
    "weekly": r"周报|(?:本周|这周|上周|上一周).{0,5}(?:进展|总结)|(?:总结|回顾)(?:本周|这周|上周|上一周)",
    "meeting": r"会议纪要|纪要转更新|会议文字|会议行动项",
    "followup": r"措施(?:跟踪|效果|执行|落实)|跟踪措施|整改(?:效果|落实)|行动项(?:落实|完成)",
    "schedule": r"排期(?:比较|推演|方案|模拟)|(?:比较|推演|模拟)排期|顺延|推迟|延后|"
    r"(?:延迟|延期|晚).{0,10}工作(?:日|天)",
}


class PlanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    question: str = Field(min_length=1, max_length=2000)
    project_id: str | None = Field(default=None, min_length=1, max_length=64)
    task_id: str | None = Field(default=None, min_length=1, max_length=64)


@dataclass(frozen=True)
class Target:
    kind: Literal["project", "task"]
    id: str
    project_id: str
    code: str
    name: str
    project_name: str


def normalize(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def visible_targets(db, user):
    projects = db.query(Project.id, Project.code, Project.name).filter(
        Project.id.in_(visible_project_ids_for(user, db))
    )
    project_targets = {
        pid: Target("project", pid, pid, code, name, name)
        for pid, code, name in projects.order_by(Project.code, Project.id)
    }
    tasks = (
        db.query(Task.id, SubProject.project_id, Task.code, Task.name)
        .join(SubProject, Task.sub_project_id == SubProject.id)
        .filter(
            SubProject.project_id.in_(project_targets), Task.id.in_(visible_task_ids_for(user, db))
        )
        .order_by(SubProject.project_id, Task.code, Task.id)
    )
    task_targets = {
        tid: Target("task", tid, pid, code, name, project_targets[pid].name)
        for tid, pid, code, name in tasks
    }
    return project_targets, task_targets


def mention_groups(question: str, targets: list[Target]):
    spans: dict[tuple[int, int], set[Target]] = {}
    for target in targets:
        code = normalize(target.code)
        labels = {code, normalize(target.name)}
        if target.kind == "project":
            alias = re.fullmatch(r"[a-z]+(\d{2,}[a-z][a-z0-9]*)", code)
            if alias:
                labels.add(alias[1])
        for label in labels - {""}:
            left = r"(?<![a-z0-9_-])" if re.match(r"[a-z0-9]", label) else ""
            right = r"(?![a-z0-9_-])" if re.search(r"[a-z0-9]$", label) else ""
            for match in re.finditer(left + re.escape(label) + right, question):
                spans.setdefault(match.span(), set()).add(target)

    # A full name or code takes precedence over an alias contained in it.
    groups = []
    end = 0
    for span in sorted(spans, key=lambda item: (item[0], -item[1])):
        if span[1] > end:
            groups.append((span, spans[span]))
            end = span[1]
    return groups


def without_mentions(question, groups):
    remaining = list(question)
    for (start, end), _ in groups:
        remaining[start:end] = " " * (end - start)
    return "".join(remaining)


def unresolved_reference(question, groups, remaining):
    spans = [span for span, _ in groups]
    for match in CODE_TOKEN.finditer(question):
        token = match[0]
        labeled = re.match(r"\s*(?:项目|任务)", question[match.end() :])
        if (
            re.search(r"[a-z]", token)
            and (labeled or re.search(r"\d", token) and not re.fullmatch(r"top\d+", token))
            and not any(start <= match.start() and match.end() <= end for start, end in spans)
        ):
            return True
    for match in QUOTED_NAME.finditer(question):
        index = match.lastindex
        if index and not any(
            match.start(index) <= start <= end <= match.end(index)
            and not question[match.start(index) : start].strip()
            and not question[end : match.end(index)].strip()
            for start, end in spans
        ):
            return True
    for match in re.finditer(r"(?:项目|任务)\s*:\s*", question):
        if not any(
            start >= match.end() and not question[match.end() : start].strip(' 《「“"')
            for start, _ in spans
        ):
            return True
    # Do not treat an unrecognized named project as a portfolio-wide request.
    unnamed = DEICTIC.sub("", ALL_PROJECTS.sub("", ALL_TASKS.sub("", remaining)))
    unnamed = re.sub(
        r"请问|帮我|我想|列出|看看|查看|显示|了解|解释|今天|现在|我的任务|我负责的(?:项目|任务)",
        "",
        unnamed,
    )
    return bool(
        re.search(
            r"[\u4e00-\u9fff]{2,}(?:(?:项目|任务)(?:的)?(?:工作重点|本周重点|优先事项|优先级|待办|进展|排期)"
            r"|(?:为什么|为何)(?:可能)?(?:延期|延误|延迟|阻塞))",
            unnamed,
        )
    )


def limit_for(question):
    match = LIMIT.search(question)
    if not match:
        return 5
    try:
        return min(MAX_LIMIT, max(1, delay_count(match[1] or match[2])))
    except (HTTPException, ValueError):
        return 5


def schedule_delays(question):
    compact = "".join(question.split())
    if SCHEDULE_FILLER.sub("", WORKDAYS.sub("", compact)):
        return []
    try:
        options = [
            delay_count(value.removesuffix("个"))
            for match in WORKDAYS.finditer(compact)
            for value in re.split(r"、|,|/|和|或者|或|与", match[1])
        ]
    except (HTTPException, ValueError):
        return []
    delays = list(dict.fromkeys(options))
    return delays if 1 <= len(delays) <= 3 and all(1 <= value <= 365 for value in delays) else []


def plan_question(db, user, payload: PlanRequest):
    question = normalize(payload.question)
    project_targets, task_targets = visible_targets(db, user)
    project = project_targets.get(payload.project_id)
    task = task_targets.get(payload.task_id)
    if (payload.project_id and not project) or (payload.task_id and not task):
        raise HTTPException(404, "所选项目或任务不存在或不可访问")
    if project and task and task.project_id != project.id:
        raise HTTPException(422, "所选任务须属于当前项目")
    anchor = task or project
    groups = mention_groups(question, [*project_targets.values(), *task_targets.values()])
    remaining = without_mentions(question, groups)
    found = [scenario for scenario, pattern in INTENTS.items() if re.search(pattern, remaining)]
    if (
        "explain" in found
        and "schedule" in found
        and not re.search(r"比较|推演|模拟|顺延|推迟|延后", remaining)
    ):
        found.remove("schedule")
    scenario = found[0] if len(found) == 1 else None
    limit = limit_for(remaining)
    mine_only = scenario == "priorities" and bool(MINE.search(remaining))

    def respond(message, target=None, choices=(), *, ready=False, start=None, end=None, delays=()):
        options = sorted(
            set(choices), key=lambda item: (item.project_name, item.kind, item.code, item.id)
        )
        return {
            "status": "ready" if ready else "clarify",
            "scenario": scenario,
            "project_ids": [target.project_id] if ready and target else [],
            "task_ids": [target.id] if ready and target and target.kind == "task" else [],
            "targets": [asdict(target)] if target else [],
            "choices": [asdict(item) for item in options[:MAX_CHOICES]],
            "message": message,
            "limit": limit,
            "mine_only": mine_only,
            "start_date": start.isoformat() if start else None,
            "end_date": end.isoformat() if end else None,
            "delays": list(delays),
        }

    if not scenario:
        message = (
            "检测到多个操作，请一次提出一种需求"
            if found
            else "请选择工作重点、异常解释、周报、纪要更新、措施跟踪或排期比较"
        )
        return respond(message, anchor)
    choices = [anchor] if anchor else list(project_targets.values())
    if unresolved_reference(question, groups, remaining):
        return respond("未能确认所指项目或任务，请使用当前可见的完整名称或编号", anchor)
    if anchor and (ALL_PROJECTS.search(remaining) or task and ALL_TASKS.search(remaining)):
        return respond("当前页面限定分析范围，请返回项目工作台查看全部可见项目", anchor)

    narrowed = []
    for _, candidates in groups:
        inside = {item for item in candidates if not anchor or item.project_id == anchor.project_id}
        if task:
            inside = (
                {task} if task in inside else {item for item in inside if item.kind == "project"}
            )
        if not inside:
            return respond("提问中的对象超出当前页面范围，请切换到对应项目或任务后重试", anchor)
        narrowed.append(inside)

    target = anchor
    if narrowed:
        common_projects = set.intersection(
            *[{item.project_id for item in group} for group in narrowed]
        )
        if not common_projects:
            return respond("问题中提到了不同项目，请保留一个项目后重试", anchor)
        eligible = [
            {item for item in group if item.project_id in common_projects} for group in narrowed
        ]
        if len(common_projects) != 1:
            return respond("检测到多个匹配对象，请选择一个项目或任务", anchor, set.union(*eligible))
        if any(len({item.kind for item in group}) > 1 for group in eligible):
            return respond("项目与任务名称相同，请使用完整编号区分", anchor)
        task_groups = [group for group in eligible if all(item.kind == "task" for item in group)]
        if task_groups:
            common_tasks = set.intersection(*task_groups)
            if not common_tasks:
                return respond("问题中提到了不同任务，请保留一个任务后重试", anchor)
            if len(common_tasks) != 1:
                return respond("检测到多个匹配任务，请选择一个任务", anchor, common_tasks)
            target = next(iter(common_tasks))
        elif not task:
            target = project_targets[next(iter(common_projects))]

    if not target and (scenario != "priorities" or DEICTIC.search(remaining)):
        return respond("请选择要分析的项目或任务", choices=choices)

    if scenario == "schedule":
        if user.role not in MANAGERS:
            return respond("排期比较需要项目管理权限", target)
        if not target or target.kind != "task":
            return respond(
                "请选择要比较排期的任务",
                target,
                (
                    item
                    for item in task_targets.values()
                    if not target or item.project_id == target.project_id
                ),
            )
        if user.role == "project_lead" and (
            db.query(Project.owner_id).filter_by(id=target.project_id).scalar() != user.id
        ):
            return respond("请由当前项目负责人比较排期", target)
        delays = schedule_delays(remaining)
        if not delays:
            return respond("请给出 1 至 3 个明确的顺延工作日数，可在排期面板中设置固定节点", target)
        return respond("已找到任务和工作日方案，请核对后比较", target, ready=True, delays=delays)

    start = end = None
    if scenario in {"weekly", "followup", "explain"}:
        this_week = bool(re.search(r"本周|这周", remaining))
        last_week = bool(re.search(r"上周|上一周", remaining))
        if this_week and last_week:
            return respond("请明确选择本周或上周", target)
        if this_week or last_week:
            today = date.today()
            monday = today - timedelta(days=today.weekday())
            start = monday - timedelta(days=7) if last_week else monday
            end = monday - timedelta(days=1) if last_week else today
    message = (
        "已按所选范围确定操作，请核对后继续" if target else "将从当前账号可见的项目中查找工作重点"
    )
    return respond(message, target, ready=True, start=start, end=end)
