"""Deterministic, bounded query expansion and explainable lexical relevance.

These are topic matches, never a probability or a check that a claim is true.
No model, embeddings, or extra service is used.
"""

import re
import unicodedata

# Deliberately small terminology map. Expansion is only used when that term
# occurs in the question, and is capped at one supplementary query.
ALIASES = (
    ("大语言模型", "large language model", "llm"),
    ("检索增强生成", "retrieval augmented generation", "rag"),
    ("抗体药物偶联物", "antibody drug conjugate", "adc"),
    ("药品生产质量管理规范", "good manufacturing practice", "gmp"),
    ("质量源于设计", "quality by design", "qbd"),
    ("关键质量属性", "critical quality attribute", "cqa"),
    ("关键工艺参数", "critical process parameter", "cpp"),
    ("质量管理体系", "quality management system", "qms"),
    ("化学制造和控制", "chemistry manufacturing and controls", "cmc"),
    ("药代动力学", "pharmacokinetics", "pk"),
    ("药效动力学", "pharmacodynamics", "pd"),
    ("临床试验", "clinical trial"),
    ("稳定性", "stability"),
    ("生物利用度", "bioavailability"),
)
ENGLISH_STOP = set(
    "a an the of to in on and or is are for from what how why which please "
    "knowledge base document documents summarize explain about with answer question "
    "this that based some compare differences".split()
)
CHINESE_STOP = (
    "知识库",
    "资料",
    "文档",
    "信息",
    "相关",
    "内容",
    "总结",
    "根据",
    "请问",
    "请",
    "介绍",
    "一下",
    "进行",
    "如何",
    "哪些",
    "什么",
    "是否",
    "告诉我",
    "中的",
    "有什么",
    "有哪些",
    "关于",
    "以及",
    "的",
    "了",
    "与",
    "和",
    "是",
    "在",
    "及",
)


def normalized(text):
    return unicodedata.normalize("NFKC", str(text)).casefold()


def contains(text, term):
    if re.fullmatch(r"[a-z0-9 -]+", term):
        return bool(re.search(r"(?<![a-z0-9])" + re.escape(term) + r"(?![a-z0-9])", text))
    return term in text


def query_terms(question):
    text = normalized(question)
    groups = [group for group in ALIASES if any(contains(text, word) for word in group)]
    latin = sorted(set(re.findall(r"[a-z][a-z0-9_+-]*", text)) - ENGLISH_STOP)
    chinese = text
    for stop in CHINESE_STOP:
        chinese = chinese.replace(stop, " ")
    grams = set()
    for word in re.findall(r"[\u3400-\u9fff]{2,}", chinese):
        grams.update(word[i : i + 2] for i in range(len(word) - 1))
    return groups, latin[:40], sorted(grams)[:100]


def relevance(question, title, text):
    groups, latin, grams = query_terms(question)
    title, body = normalized(title), normalized(text)
    combined = title + "\n" + body
    hits = set()
    score = 0
    for group in groups:
        matched = [word for word in group if contains(combined, word)]
        if matched:
            hits.add(matched[0])
            score += 8 + 4 * any(contains(title, word) for word in group)
    latin_hits = [word for word in latin if contains(combined, word)]
    gram_hits = [word for word in grams if word in combined]
    for word in latin_hits:
        hits.add(word)
        score += 3 + 3 * contains(title, word)
    for word in gram_hits:
        hits.add(word)
        score += 1 + 2 * (word in title)
    group_hit = any(any(contains(combined, word) for word in group) for group in groups)
    eligible = bool(hits) and (
        group_hit
        if groups
        else (
            (bool(latin_hits) and len(latin_hits) >= min(2, len(latin)))
            or (bool(gram_hits) and len(gram_hits) >= min(2, len(grams)))
        )
    )
    return {
        "lexical_score": score,
        "matched_terms": sorted(hits)[:20],
        "evidence_eligible": eligible,
    }


def query_variants(question):
    question = " ".join(question.split())
    # Preserve both subject and newest constraints without sending >1000 chars.
    primary = question if len(question) <= 1000 else question[:498] + " … " + question[-499:]
    groups, _, _ = query_terms(question)
    aliases = []
    for group in groups[:3]:
        aliases.extend(word for word in group if not contains(normalized(question), word))
    if aliases:
        return [primary, (primary[:600] + " " + " ".join(aliases))[:1000]]
    # For long natural-language queries, a compact keyword retry may help Core.
    _, latin, grams = query_terms(question)
    terms = " ".join(latin + grams[:12])
    return [primary, terms] if terms and terms != primary else [primary]


def rank_result(question, value, *, filter_irrelevant=False):
    """Deduplicate and rank observed rows, retaining an explicit lexical basis."""
    if not isinstance(value, dict) or value.get("error"):
        return value
    result = dict(value)
    for key in ("chunks", "page_refs"):
        rows, seen = [], set()
        for row in value.get(key, []):
            item = dict(row)
            match = relevance(question, item.get("title", ""), item.get("text", ""))
            item.update(match)
            identity = (item.get("path"), item.get("text", ""))
            if identity in seen or (filter_irrelevant and not match["evidence_eligible"]):
                continue
            seen.add(identity)
            rows.append(item)
        result[key] = sorted(rows, key=lambda row: -row["lexical_score"])
    result["ranking_basis"] = "lexical_topic_match_not_fact_verification"
    return result


def catalogue_question(question):
    # Only an unqualified whole-library catalogue/count can use list_pages.total.
    # A topic-specific count ("ADC论文有多少") needs retrieval, not the global total.
    text = normalized(question).strip()
    if re.search(r"多少|几[篇份条个]|数量|总数|目录|列出全部|所有", text) and re.fullmatch(
        r"(?:请问|请|帮我|查看|统计|查询|我们|的|当前|目前|现在|本轮|已授权|知识库|中|里|"
        r"一共|总共|有|共有|包含|全部|所有|多少|几|篇|份|条|个|资料|文档|论文|来源|"
        r"页面|数量|总数|目录|列出|完整|有效|？|\?|。|\s)+",
        text,
    ):
        return True
    words = re.findall(r"[a-z]+", text)
    return (
        bool(set(words) & {"count", "catalogue", "catalog", "many"})
        and set(words).issubset(
            {
                "please",
                "show",
                "list",
                "all",
                "the",
                "a",
                "of",
                "in",
                "our",
                "my",
                "current",
                "knowledge",
                "base",
                "how",
                "many",
                "are",
                "there",
                "count",
                "catalogue",
                "catalog",
                "documents",
                "papers",
                "pages",
                "sources",
                "materials",
            }
        )
        and not re.search(r"[\u3400-\u9fff]", text)
    )
