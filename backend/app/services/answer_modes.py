"""Shared, deterministic routing. Permissions and explicit scopes always win."""

import re
from dataclasses import dataclass

from fastapi import HTTPException


@dataclass(frozen=True)
class Plan:
    mode: str
    reason: str
    query: str
    sources: tuple[str, ...] = ()


def deep_analysis(question):
    """Use higher reasoning only for an affirmative request in its own clause."""
    for clause in re.split(r"[，,。；;！!？?\n]", question):
        for match in re.finditer(
            r"深入分析|深度分析|详细推导|严谨推导|deep analysis|detailed derivation", clause, re.I
        ):
            prefix = clause[: match.start()]
            if not re.search(
                r"(?:不(?:要|用|必|需要|想)?|无需|无须|别|避免|禁止)(?:再|做|进行|使用|给我|太多|任何|特别|过多|额外|的|地|\s){0,6}$|(?:without|don't|do not|no need to)\s*(?:do|perform)?\s*$",
                prefix,
                re.I,
            ):
                return True
    return False


def followup(question):
    text = question.strip()
    if len(text) > 600 or re.search(
        r"换个(?:问题|话题)|另一个(?:问题|话题)|新(?:问题|话题)|unrelated|new topic", text, re.I
    ):
        return False
    return bool(
        re.match(
            r"^(?:(?:请|能否|请你|帮我)(?:再|继续)?\s*)?(继续|再说|再详细|展开|还有呢|然后呢|为什么|那[么这它]|这些|上述|上面|刚才|前面|它们|进一步|基于(?:上|前)|what about|and |why\b)",
            text,
            re.I,
        )
        or re.search(
            r"(?:这个|该|上述|前述|前面(?:的)?|上面(?:的)?)(?:问题|话题|主题|结论|方案)", text
        )
        or re.match(
            r"^(?:(?:请|帮我|请你)(?:再)?\s*)?(?:(?:把|将|对|关于)\s*)?(?:第[一二三四五六七八九十百\d]+(?:项|点|条|种|个|部分|节)|这(?:项|点|条|种)|that (?:item|point)|the (?:first|second|third|fourth) (?:item|point))",
            text,
            re.I,
        )
    )


def decide(
    question,
    requested,
    *,
    knowledge_allowed=True,
    constrained_sources=False,
    previous_mode="",
    previous_web_question="",
    reference_material_available=False,
):
    text = question.strip()
    no_web = bool(
        re.search(
            r"(?:不(?:要|用|必|允许|需要)?|无需|无须|禁止|别)(?:再|进行|使用|调用|用)?(?:联网|上网|搜索|网络|检索互联网)|仅(?:用|凭|使用)已有知识|只(?:用|凭|使用)(?:已有|模型)知识|离线(?:回答|模式)|without (?:web|internet)|(?:do not|don't) (?:browse|search)",
            text,
            re.I,
        )
    )
    application_intent = bool(
        re.search(
            r"知识库|论文库|公司内部|内部(?:资料|文件|数据|实验|项目|系统)|本公司|本(?:应用|系统)(?:中|内|里|的)?(?:资料|材料|文件|数据)|未公开|保密(?:资料|数据|文件|项目|实验|信息)|我们(?:自己的|的)(?:实验|项目|数据|资料)|我方(?:实验|项目|数据|资料)|\b(?:knowledge base|our internal|our confidential|unpublished (?:data|experiment|project))\b",
            text,
            re.I,
        )
    )
    provided_reference = bool(
        re.search(
            r"(?:本轮|本次|附带的?|这份|这些|已上传的?|上传的|提供的)(?:资料|材料|文件|文档|内容|正文|摘录)|附件|\b(?:attached|provided|uploaded) (?:materials?|files?|documents?|content|excerpts?)\b",
            text,
            re.I,
        )
    )
    private_intent = (
        application_intent
        or provided_reference
        or bool(
            re.search(
                r"已上传|上传的|所选资料|这些材料|这份资料|当前章节|本章|现有资料|已有资料|资料中的|材料中的|附带资料",
                text,
            )
        )
    )
    if constrained_sources:
        return Plan("knowledge", "仅在本次指定资料范围内查证", text)
    if requested == "knowledge":
        if not knowledge_allowed:
            raise HTTPException(422, "请先在数据设置中启用知识库，再使用仅知识库回答")
        return Plan("knowledge", "按你的设置，仅使用已授权知识库", text)
    if requested == "general":
        return Plan("general", "按你的设置，不联网回答", text)
    if reference_material_available and provided_reference and not application_intent:
        return Plan(
            "general", "依据本轮提供的资料回答，不读取知识库，也不将资料发送到联网搜索", text
        )
    if no_web:
        if private_intent:
            if not knowledge_allowed:
                raise HTTPException(422, "该问题涉及内部或知识库资料，请先在数据设置中启用知识库")
            return Plan("knowledge", "遵照不联网要求，仅查已授权知识库", text)
        return Plan("general", "遵照你的要求，本次不联网", text)
    if private_intent:
        if not knowledge_allowed:
            raise HTTPException(422, "该问题涉及内部或知识库资料，请先在数据设置中启用知识库")
        return Plan("knowledge", "问题涉及已授权知识库资料", text)
    if requested == "web":
        return Plan("web", "按你的设置，联网检索公开资料", text)
    if followup(text) and previous_mode == "knowledge":
        if not knowledge_allowed:
            raise HTTPException(422, "本次追问延续知识库资料，请先在数据设置中启用知识库")
        return Plan("knowledge", "延续本主题上一轮的知识库范围", text)
    if followup(text) and previous_mode == "web":
        query = (
            (previous_web_question[:1200] + "\n追问：" + text) if previous_web_question else text
        )
        return Plan("web", "延续本主题上一轮的公开联网检索", query)
    if re.search(
        r"最新|近期|最近|当前|目前|今天|今年|新闻|进展|联网|上网|搜索|检索|查找.{0,20}(?:论文|文献)|(?:论文|文献).{0,20}(?:查找|搜)|\b(?:latest|recent|current|today|news|search|202[6-9])\b",
        text,
        re.I,
    ):
        return Plan("web", "问题需要近期信息或公开资料检索", text)
    if followup(text) and previous_mode == "general":
        return Plan("general", "延续本主题上一轮的回答范围", text)
    return Plan("general", "通用问题，直接回答即可", text)


def decide_personal(
    question,
    requested,
    *,
    data_sources,
    previous_mode="",
    previous_sources=(),
    previous_web_question="",
    reference_material_available=False,
):
    """Personal-only PM routing; report callers continue using decide unchanged."""
    text = question.strip()
    if requested in ("general", "knowledge"):
        plan = decide(text, requested, knowledge_allowed="knowledge" in data_sources)
        return Plan(
            plan.mode, plan.reason, plan.query, ("knowledge",) if plan.mode == "knowledge" else ()
        )
    explicit_project_system = bool(re.search(r"项目管理(?:应用|系统|数据)", text))
    if (
        reference_material_available
        and not explicit_project_system
        and re.search(
            r"(?:本轮|本次|附带的?|这份|这些|已上传的?|上传的|提供的)(?:资料|材料|文件|文档|内容|正文|摘录)|附件",
            text,
        )
        and not re.search(r"知识库|论文库|公司内部|内部系统|未公开|保密资料", text)
    ):
        plan = decide(
            text,
            requested,
            knowledge_allowed="knowledge" in data_sources,
            reference_material_available=True,
        )
        if plan.mode == "general":
            return plan
    project_intent = explicit_project_system or bool(
        re.search(
            r"(?:当前|目前|现有|现在|所有|全部|有哪些|有多少|几个|列出|罗列|查看|查询|统计).{0,10}项目|项目.{0,12}(?:清单|列表|目录|数量|有哪些|有多少|几个|状态|负责人|进度|起止|开始时间|结束时间|截止|延期|完成情况|概况|最新进展)|(?:我们|我方|本公司|我的|我负责|我参与).{0,6}项目",
            text,
        )
    )
    # A KB article about project management is still a KB question. Native PM
    # access requires an explicit current-directory/system request as well.
    if (
        re.search(r"知识库|论文库", text)
        and re.search(r"文章|论文|文献|指南|专题|概念|定义|方法", text)
        and not re.search(r"结合|综合|对照|关联|同时|联动", text)
        and not explicit_project_system
        and (
            re.search(
                r"^(?:请|帮我|请帮我)?(?:查询|检索|搜索|整理|总结|列出|介绍)?(?:一下)?(?:知识库|论文库)(?:中|里|内|的)",
                text,
            )
            or not re.search(
                r"(?:当前|目前|现有|现在|所有|全部|有哪些|有多少|几个|列出|罗列|查看|查询|统计).{0,10}项目",
                text,
            )
        )
    ):
        project_intent = False
    inherited = followup(text) and previous_mode == "application" and "projects" in previous_sources
    if project_intent or inherited:
        if "projects" not in data_sources:
            raise HTTPException(422, "该问题需要项目管理数据，请先在数据设置中勾选项目管理")
        joint = bool(re.search(r"知识库|论文库", text)) or (
            inherited and "knowledge" in previous_sources
        )
        if joint and "knowledge" not in data_sources:
            raise HTTPException(422, "该问题还需要知识库数据，请先在数据设置中勾选知识库")
        sources = ("projects", "knowledge") if joint else ("projects",)
        return Plan(
            "application",
            "依据项目管理只读目录与授权知识库回答"
            if joint
            else "依据当前账号可见的项目管理只读目录回答",
            text,
            sources,
        )
    plan = decide(
        text,
        requested,
        knowledge_allowed="knowledge" in data_sources,
        previous_mode=previous_mode,
        previous_web_question=previous_web_question,
        reference_material_available=reference_material_available,
    )
    return Plan(
        plan.mode, plan.reason, plan.query, ("knowledge",) if plan.mode == "knowledge" else ()
    )
