"""Conservative lexical relevance checks for authorized source excerpts.

This is a topical-overlap gate, not a claim that a source answers a question.
Conversational filler and freshness words cannot select evidence. A title may
strengthen an actual body match, but cannot make unrelated body text evidence.
"""

import re
import unicodedata

# Remove whole phrases before generating CJK n-grams, so adjacent fragments do
# not create terms such as "我总". This deliberately needs no tokenization model.
_CJK_FILLER = frozenset(
    {
        "帮我总结一下",
        "帮我总结下",
        "帮我总结",
        "帮我",
        "请帮忙",
        "请问",
        "我想了解",
        "我想知道",
        "我想要",
        "告诉我",
        "介绍一下",
        "解释一下",
        "总结一下",
        "总结下",
        "总结",
        "概括",
        "介绍",
        "解释",
        "说明",
        "罗列",
        "列出",
        "给出",
        "查找",
        "查询",
        "搜索",
        "检索",
        "回答",
        "不能",
        "为什么",
        "是什么",
        "有什么",
        "有哪些",
        "怎么样",
        "怎么办",
        "怎么",
        "哪些",
        "什么",
        "如何",
        "是否",
        "可以",
        "这个",
        "这些",
        "那个",
        "那些",
        "上面",
        "上述",
        "下面",
        "下述",
        "之前",
        "当前",
        "本轮",
        "本次",
        "现在",
        "最新",
        "近期",
        "最近",
        "新的",
        "新近",
        "今天",
        "本周",
        "今年",
        "学术进展",
        "研究进展",
        "学术",
        "进展",
        "研究",
        "文献",
        "论文",
        "文章",
        "知识库",
        "知识",
        "相关",
        "内容",
        "信息",
        "材料",
        "资料",
        "依据",
        "证据",
        "来源",
        "范围",
        "问题",
        "章节",
        "现有",
        "提供",
        "进行",
        "关于",
        "我们",
        "你们",
        "继续",
        "比较",
        "不同",
        "差异",
        "实践",
        "经验",
        "结果",
        "方法",
    }
)
_FILLER_PATTERN = re.compile(
    "|".join(re.escape(term) for term in sorted(_CJK_FILLER, key=lambda term: (-len(term), term)))
)
_CJK = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]+")
_ENGLISH = re.compile(r"[a-z0-9]+(?:[-_+][a-z0-9]+)*")
_ENGLISH_FILLER = frozenset(
    "a about above advances all an and answer answers any are article articles as at "
    "available be been before below between by can cannot compare could current describe "
    "did different differences do does during each evidence explain find for from general "
    "given give has have help how i in information into is it its knowledge last latest "
    "literature materials me month months my need new next not now of on or our paper papers "
    "please previous progress provided question questions recent related relevant research "
    "result results scope search show since some source sources studies study such summarize "
    "summary tell than that the their them these they this those through to today topic topics "
    "under until up us use used using was we week weeks were what when where which who why "
    "will with without would year years you your".split()
)
_BOUNDARY_PARTICLES = "的了呢吗吧呀哦啊我你他它请"


def _normalized(value: str) -> str:
    # Excerpts are already bounded upstream; the cap also bounds long query work.
    return (
        unicodedata.normalize("NFKC", value[:8000])
        .casefold()
        .translate(str.maketrans({"‐": "-", "‑": "-", "–": "-", "−": "-"}))
    )


def _word_key(word: str) -> str:
    """Fold a few English plural forms without stemming technical identifiers."""
    if not word.isalpha() or len(word) <= 4:
        return word
    if word.endswith("ies") and word not in {"species", "series"}:
        return word[:-3] + "y"
    if word.endswith("s") and not word.endswith(("ss", "is", "us")):
        return word[:-1]
    return word


def _english_words(value: str) -> set[str]:
    return {
        _word_key(word)
        for word in _ENGLISH.findall(value)
        if len(word) >= 2 and not word.isdigit() and word not in _ENGLISH_FILLER
    }


def _query_parts(question: str) -> tuple[set[str], list[str]]:
    value = _normalized(question)
    english = _english_words(value) - _ENGLISH_FILLER
    chinese = [
        part
        for group in _CJK.findall(_FILLER_PATTERN.sub(" ", value))
        if len(part := group.strip(_BOUNDARY_PARTICLES)) >= 2
    ]
    return english, chinese


def relevance_terms(text: str) -> set[str]:
    """Return literal topical terms for ranking already relevant body excerpts.

    English words are normalized lightly; CJK terms use 2–8 character n-grams.
    Call ``relevant_excerpt`` before ranking: title hits and English substring
    hits alone must not select evidence. An empty term set means no topical
    query, never a request to return arbitrary sources.
    """
    english, chinese = _query_parts(text)
    terms = set(english)
    for word in english:
        if word.isalpha() and len(word) > 4:
            terms.add(word[:-1] + "ies" if word.endswith("y") else word + "s")
    for group in chinese:
        for width in range(2, min(8, len(group)) + 1):
            terms.update(group[start : start + width] for start in range(len(group) - width + 1))
    return terms


def relevant_excerpt(question: str, excerpt: str, title: str = "") -> bool:
    """Require meaningful literal topical overlap in the actual excerpt body.

    English matches use whole tokens. CJK matches require a three-character
    compound, two distinct bigrams, or a standalone two-character query topic.
    A lone bigram from a longer topic also needs a compound match in the title.
    This conservative gate cannot infer semantic similarity or answerability.
    """
    english, chinese = _query_parts(question)
    body = _normalized(excerpt)
    if english & _english_words(body):
        return True
    body_bigrams: set[str] = set()
    normalized_title = _normalized(title)
    title_compound = False
    for group in chinese:
        if len(group) == 2 and group in body:
            return True
        for width in range(3, min(8, len(group)) + 1):
            for start in range(len(group) - width + 1):
                term = group[start : start + width]
                if term in body:
                    return True
                if term in normalized_title:
                    title_compound = True
        body_bigrams.update(
            group[start : start + 2]
            for start in range(len(group) - 1)
            if group[start : start + 2] in body
        )
    return len(body_bigrams) >= 2 or bool(body_bigrams and title_compound)
