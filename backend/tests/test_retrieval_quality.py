import pytest

from app.services.retrieval_quality import relevance_terms, relevant_excerpt

PERSIMMON_QUESTION = "帮我总结下柿子脱涩的最新的学术进展"
DRUG_EXCERPT = "新的重组表达载体需要符合药学变更研究指导原则，目的蛋白和宿主细胞均未改变。"
DRUG_TITLE = "《已上市生物制品药学变更研究技术指导原则（试行）》解读"


def test_freshness_words_do_not_select_unrelated_drug_evidence():
    terms = relevance_terms(PERSIMMON_QUESTION)
    assert {"柿子", "脱涩", "柿子脱涩"} <= terms
    assert not terms & {"新的", "最新", "研究", "学术", "进展", "总结"}
    assert not relevant_excerpt(PERSIMMON_QUESTION, DRUG_EXCERPT, DRUG_TITLE)


def test_generic_followup_requires_actual_topic_from_conversation():
    followup = "你搜索的范围是什么，为什么不能回答上面这个问题"
    assert relevance_terms(followup) == set()
    assert not relevant_excerpt(followup, "受理资料范围涉及银屑病背景，不能证明该问题的结论。")
    contextual_query = followup + " " + PERSIMMON_QUESTION
    assert not relevant_excerpt(contextual_query, DRUG_EXCERPT, DRUG_TITLE)
    assert relevant_excerpt(contextual_query, "柿子脱涩处理后可溶性单宁降低。")


@pytest.mark.parametrize(
    ("question", "excerpt"),
    [
        ("缓冲液稳定性有什么实践？", "缓冲液稳定性试验记录。条件为研究用样品，结果仍需复核。"),
        ("继续比较缓冲液", "缓冲液稳定性研究，但有条件限制。"),
        ("抗体有哪些相关研究？", "该抗体在控制条件下测定。"),
        ("柿子脱涩的方法", "柿子脱涩处理后需要确认可溶性单宁。"),
        ("Research Trehalose stability", "Trehalose observations require further verification."),
        ("CHO cells", "The CHO cell experiment requires replication."),
        ("IL-6 signalling", "IL‑6 was measured under controlled conditions."),
        ("Ｔｒｅｈａｌｏｓｅ", "Trehalose observations require verification."),
    ],
)
def test_meaningful_chinese_and_english_topics_are_retained(question, excerpt):
    assert relevant_excerpt(question, excerpt)


def test_generic_section_question_can_use_explicit_topic_context():
    generic = "当前章节有哪些相关知识？"
    source = "Trehalose observations require further verification under controlled conditions."
    assert not relevant_excerpt(generic, source)
    assert relevant_excerpt(generic + " 研究 Trehalose。作者待证假设：保证全部稳定。", source)


def test_title_alone_does_not_qualify_arbitrary_body_text():
    assert not relevant_excerpt(PERSIMMON_QUESTION, DRUG_EXCERPT, "柿子脱涩的最新研究")
    assert not relevant_excerpt(
        "Trehalose", "Methods and results require verification.", "Trehalose study"
    )
    # A matching title can strengthen a small, real topic match in the body.
    assert relevant_excerpt("柿子脱涩的方法", "脱涩处理需要控制条件。", "柿子脱涩的方法比较")


def test_english_terms_match_tokens_not_incidental_substrings():
    assert not relevant_excerpt("pH", "Pharmacy practices require review.")
    assert not relevant_excerpt("CHO", "Chromosome observations require replication.")
    assert relevant_excerpt("pH", "The pH was measured under controlled conditions.")


def test_metacharacters_are_not_executed_as_patterns():
    assert relevance_terms("[.*+?] (Trehalose)") == {"trehalose", "trehaloses"}
    assert relevant_excerpt("[.*+?] (Trehalose)", "Trehalose observations require replication.")
    assert not relevant_excerpt("[.*+?]", "Any source content")
    assert not relevant_excerpt("", "Any source content")
    assert not relevant_excerpt("最新研究、资料范围、相关问题", DRUG_EXCERPT)


def test_repeated_long_chinese_question_is_bounded_and_still_relevant():
    repeated = "缓冲液" * 600
    assert relevant_excerpt(repeated, "缓冲液稳定性试验记录。")
    assert len(relevance_terms(repeated)) < 30
