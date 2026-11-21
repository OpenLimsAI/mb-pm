"""Explicit query conditions. Unsupported conditions must never widen a query."""

import re
from datetime import date, timedelta


def reporting_period(question, today):
    """Return inclusive dates, or a clarification. Does not guess partial dates."""
    text = question
    if re.search(
        r"上上周|下下周|前年|后年|(?:本周|这周|上周|上一周)[一二三四五六日天]|星期|近[一二三四五六七八九十两]+[天周月年]|前[一二三四五六七八九十两0-9]+[周月年]|(?:日|\d)[前后](?!天)",
        text,
    ):
        return None, None, "请把时间条件写为明确的起止年月日"
    full = r"(?<!\d)(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?"
    short = r"(\d{1,2})[月/-](\d{1,2})日?"
    matches = list(re.finditer(full, text))
    relative = list(
        re.finditer(
            r"最近\s*(\d+)\s*天|近\s*(\d+)\s*天|本周|这周|上周|上一周|本月|上月|今天|今日|昨天|昨日|前天",
            text,
        )
    )
    if matches and relative or len(relative) > 1 or len(matches) > 2:
        return None, None, "请只指定一个明确的日期范围"
    try:
        if matches:
            start = date(*map(int, matches[0].groups()))
            end = start
            tail = text[matches[0].end() :]
            if len(matches) == 2:
                between = text[matches[0].end() : matches[1].start()].strip()
                if between not in {"至", "到", "~", "～", "—", "-"}:
                    raise ValueError()
                end = date(*map(int, matches[1].groups()))
            elif re.match(r"\s*(?:至|到(?!期)|~|～|—|-)\s*", tail):
                finish = re.match(r"\s*(?:至|到(?!期)|~|～|—|-)\s*" + short, tail)
                if not finish:
                    raise ValueError()
                end = date(start.year, *map(int, finish.groups()))
            remainder = re.sub(full, "", text)
            if len(matches) == 1 and re.match(r"\s*(?:至|到(?!期)|~|～|—|-)\s*", tail):
                remainder = text[: matches[0].start()] + tail[finish.end() :]
        elif relative:
            match = relative[0]
            term = match[0]
            end = today
            if match[1] or match[2]:
                days = int(match[1] or match[2])
                if not 1 <= days <= 366:
                    raise ValueError()
                start = today - timedelta(days=days - 1)
            elif term in {"本周", "这周", "上周", "上一周"}:
                start = today - timedelta(days=today.weekday())
                if term in {"上周", "上一周"}:
                    start, end = start - timedelta(days=7), start - timedelta(days=1)
            elif term in {"本月", "上月"}:
                start = today.replace(day=1)
                if term == "上月":
                    end = start - timedelta(days=1)
                    start = end.replace(day=1)
            else:
                start = end = today - timedelta(
                    days=2 if term == "前天" else 1 if term in {"昨天", "昨日"} else 0
                )
            remainder = text[: match.start()] + text[match.end() :]
        else:
            start = end = None
            remainder = text
        # Reject unsupported temporal clauses instead of silently using this week.
        if re.search(
            r"\d+[年月日天]|\d{1,4}[-/]\d|上上周|下周|明天|明年|去年|今年|季度|年度|月份|本年|个月|近期|最近|过去|截至|截止到|以前|以后|之前|之后",
            remainder,
        ):
            raise ValueError()
        if start and (start > end or (end - start).days > 366):
            raise ValueError()
    except (ValueError, OverflowError):
        return (
            None,
            None,
            "日期条件暂不能准确识别，请使用起止年月日，或本周、上周、本月、上月、最近N天",
        )
    return start, end, None


def priority_filter(question):
    matches = list(
        re.finditer(
            r"(?<![高中低最])([高中低])优先级|优先级\s*(?:是|为|[:：])?\s*([高中低])(?![高中低])",
            question,
        )
    )
    priorities = {match[1] or match[2] for match in matches}
    remainder = question
    for match in reversed(matches):
        remainder = remainder[: match.start()] + remainder[match.end() :]
    unmatched = re.sub(r"优先级(?=\s*(?:[?？。.!！]|$))", "", remainder)
    if (
        "优先级" in unmatched
        or len(priorities) > 1
        or (
            priorities
            and re.search(
                r"不|非|排除|高于|低于|至少|最多|(?:和|或|及|、|与|/)\s*[高中低]", question
            )
        )
        or re.search(
            r"[高中低最紧急]+优先级|优先级\s*(?:是|为|[:：]|最高|最低|大于|小于|[0-9])|紧急",
            remainder,
        )
    ):
        return None, "请明确一个优先级：高、中或低；暂不支持优先级比较或排除条件"
    return next(iter(priorities), None), None
