# ruff: noqa: F811
"""Usage is observed provider receipts, including paid invalid responses and unknown attempts."""

from test_information_live import store  # noqa: F401

from app.services.knowledge_source_status import resources


def test_empty_meter_has_zero_observed_requests_but_no_fabricated_price(store):
    s, _ = store
    result = resources(s)
    assert result["researchRequests"] == 0
    assert result["modelTokens"] == 0
    assert result["modelCost"] is None and result["indexCost"] is None


def test_actual_tokens_include_failed_validation_and_partial_usage_is_explicit(store):
    s, _ = store
    rows = [
        ("completed", {"total_tokens": 81}),
        ("failed_validation", {"prompt_tokens": 10, "completion_tokens": 5}),
        ("failed_request", None),
        ("submitted", None),
        ("completed", {}),
    ]
    for index, (status, usage) in enumerate(rows):
        s.put(
            "ks_research_call",
            {
                "id": s.key("ks_research_call", str(index)),
                "subject": "alice",
                "status": status,
                "usage": usage,
            },
        )
    s.db.commit()
    result = resources(s)
    assert result["researchRequests"] == 5 and result["confirmedModelResponses"] == 3
    assert result["unconfirmedModelRequests"] == 2 and result["generativeModelCalls"] is None
    assert result["modelUsageReceipts"] == 2 and result["modelTokens"] == 96
    assert result["modelTokenReceiptsMissing"] == 3 and result["modelUsageIncomplete"]
    assert result["modelCost"] is None


def test_unknown_usage_is_not_zero_and_completed_cache_is_not_a_new_call(store):
    s, _ = store
    s.put("ks_research_call", {"id": s.key("ks_research_call", "one"), "status": "failed_request"})
    s.put(
        "ks_research",
        {
            "id": s.key("ks_research", "cache"),
            "result": {"cached": True, "usage": {"total_tokens": 200}},
        },
    )
    s.db.commit()
    result = resources(s)
    assert result["researchRequests"] == 1 and result["modelTokens"] is None
    assert result["confirmedModelResponses"] == 0 and result["unconfirmedModelRequests"] == 1


def test_malformed_usage_does_not_become_confirmed_numeric_tokens(store):
    s, _ = store
    for index, value in enumerate([True, -10, "25", 2.5]):
        s.put(
            "ks_research_call",
            {
                "id": s.key("ks_research_call", str(index)),
                "status": "completed",
                "usage": {"total_tokens": value},
            },
        )
    s.db.commit()
    result = resources(s)
    assert result["confirmedModelResponses"] == 4
    assert result["modelTokens"] is None and result["modelTokenReceiptsMissing"] == 4


def test_automatic_filing_undo_tokens_are_only_current_owner_unexpired_unused(store):
    import time

    from app.services.knowledge_source_status import public_jobs

    s, _ = store
    for name, owner, expired, used in [
        ("own", "alice", False, False),
        ("other", "bob", False, False),
        ("expired", "alice", True, False),
        ("used", "alice", False, True),
    ]:
        s.put(
            "ks_undo",
            {
                "id": name,
                "subject": owner,
                "used": used,
                "expiresAt": time.time() + (-5 if expired else 1000),
            },
        )
    raw = {
        "id": "job",
        "app": "knowledge-sources",
        "actorSubject": "alice",
        "items": [],
        "ruleFiling": {
            "status": "completed",
            "undoTokens": ["own", "other", "expired", "used"],
            "results": [{"undoTokens": ["own", "other"], "undoToken": "own"}],
        },
    }
    s.put("job", raw)
    s.db.commit()
    alice = public_jobs(s, "alice")[0]
    assert alice["ruleFiling"]["undoTokens"] == ["own"] and alice["canUndoRuleFiling"]
    assert "undoTokens" not in alice["ruleFiling"]["results"][0]
    assert "undoToken" not in alice["ruleFiling"]["results"][0]
    assert public_jobs(s)[0]["ruleFiling"]["undoTokens"] == []
    assert public_jobs(s, "carol")[0]["canUndoRuleFiling"] is False
    assert s.get("job", "job")["ruleFiling"]["undoTokens"] == raw["ruleFiling"]["undoTokens"]
