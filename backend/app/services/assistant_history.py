"""Bounded user-topic continuity without reusing application answers or attachments."""

import json

from app.services import answer_modes


def sources(message):
    metadata = message.application_scope
    if isinstance(metadata, dict) and metadata.get("version") == 1:
        return set(metadata.get("used_sources", []))
    # Legacy rows do not distinguish permitted sources from actually used ones.
    # Treat them conservatively rather than exporting an old private question.
    try:
        declared = json.loads(message.data_sources)
    except (TypeError, ValueError):
        declared = []
    result = set(declared) if isinstance(declared, list) else set()
    if message.answer_mode == "knowledge":
        result.add("knowledge")
    if message.answer_mode == "application":
        result.add("projects")
    return result


def topic_questions(history, question, allowed_sources, *, public_only=False):
    """Keep recent distinct follow-ups plus their nearest concrete topic.

    Re-answering the same vague question must not evict its original subject.
    Stop at a scope boundary, so an older eligible topic cannot silently replace
    the actual private subject. Only user text is returned, never old evidence.
    """
    if not answer_modes.followup(question):
        return []
    result, seen = [], {question.strip()}
    for row in reversed(history):
        if row.role != "user":
            continue
        prior_sources = sources(row)
        if not prior_sources.issubset(allowed_sources) or (
            public_only and (row.answer_mode != "web" or prior_sources)
        ):
            break
        text = row.content.strip()
        if not text or text in seen:
            continue
        seen.add(text)
        concrete = not answer_modes.followup(text)
        if len(result) < 3 or concrete:
            result.append(row)
        if concrete:
            break
    return list(reversed(result))


def query(topic, question):
    if not topic:
        return question
    # Bound the query independently of the model prompt and preserve the topic
    # even when multiple re-answer requests occupy the most recent rounds.
    context = "\n".join(row.content[:450] for row in topic)
    return context[:1500] + "\n追问：" + question[:380]
