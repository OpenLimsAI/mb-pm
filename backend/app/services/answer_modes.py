"""Shared, deterministic routing. Permissions and explicit scopes always win."""

import re
from dataclasses import dataclass

from fastapi import HTTPException


@dataclass(frozen=True)
class Plan:
    mode: str
    reason: str
    query: str


def followup(question):
    return len(question.strip()) <= 80 and bool(
        re.match(
            r"^(继续|再说|再详细|展开|还有呢|然后呢|为什么|那[么这它]|这些|上述|上面|它们|what about|and |why\b)",
            question.strip(),
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
):
    text = question.strip()
    no_web = bool(
        re.search(
            r"(?:不(?:要|用|必|允许|需要)?|无需|无须|禁止|别)(?:再|进行|使用|调用|用)?(?:联网|上网|搜索|网络|检索互联网)|仅(?:用|凭|使用)已有知识|只(?:用|凭|使用)(?:已有|模型)知识|离线(?:回答|模式)|without (?:web|internet)|(?:do not|don't) (?:browse|search)",
            text,
            re.I,
        )
    )
    private_intent = bool(
        re.search(
            r"知识库|论文库|已上传|上传的|所选资料|这些材料|这份资料|当前章节|本章|现有资料|已有资料|资料中的|材料中的|附带资料|公司内部|内部(?:资料|文件|数据|实验|项目)|本公司|本次材料|未公开|保密(?:资料|数据|文件|项目|实验|信息)|我们(?:自己的|的)(?:实验|项目|数据|资料)|我方(?:实验|项目|数据|资料)|\b(?:our internal|our confidential|unpublished (?:data|experiment|project))\b",
            text,
            re.I,
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
