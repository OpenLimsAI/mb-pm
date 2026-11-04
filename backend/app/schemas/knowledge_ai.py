"""A bounded OpenAI-compatible turn; endpoints and credentials are never inputs."""

import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

MAX_REQUEST_BYTES = 1024 * 1024


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", protected_namespaces=())


class TextPart(Input):
    type: Literal["text"]
    text: str = Field(max_length=200_000)


class FunctionCall(Input):
    name: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    arguments: str = Field(max_length=200_000)


class ToolCall(Input):
    id: str = Field(min_length=1, max_length=160)
    type: Literal["function"] = "function"
    function: FunctionCall


class Message(Input):
    role: Literal["system", "developer", "user", "assistant", "tool"]
    content: str | list[TextPart] | None = Field(default=None, max_length=200_000)
    name: str | None = Field(default=None, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    tool_call_id: str | None = Field(default=None, min_length=1, max_length=160)
    tool_calls: list[ToolCall] | None = Field(default=None, max_length=32)
    # Some compatible providers require this field on subsequent tool turns.
    reasoning_content: str | None = Field(default=None, max_length=200_000)

    @model_validator(mode="after")
    def association(self):
        if self.role == "tool":
            if not self.tool_call_id or self.content is None:
                raise ValueError("tool replies require a call id and content")
        elif self.tool_call_id is not None:
            raise ValueError("only tool replies have tool_call_id")
        if self.role != "assistant" and (self.tool_calls or self.reasoning_content is not None):
            raise ValueError("tool calls and reasoning belong to assistant turns")
        if self.content is None and not self.tool_calls:
            raise ValueError("message content is required")
        if isinstance(self.content, list) and len(self.content) > 64:
            raise ValueError("too many content parts")
        return self


class Function(Input):
    name: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    description: str | None = Field(default=None, max_length=8000)
    parameters: dict = Field(default_factory=lambda: {"type": "object", "properties": {}})
    strict: bool | None = None


class Tool(Input):
    type: Literal["function"] = "function"
    function: Function


class FunctionName(Input):
    name: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")


class ToolChoice(Input):
    type: Literal["function"] = "function"
    function: FunctionName


class ResponseFormat(Input):
    type: Literal["text", "json_object", "json_schema"]
    json_schema: dict | None = None

    @model_validator(mode="after")
    def schema_required(self):
        if (self.type == "json_schema") != (self.json_schema is not None):
            raise ValueError("json_schema must match the format")
        return self


class Completion(Input):
    model: str | None = Field(default=None, min_length=1, max_length=80)
    settings_revision: int | None = Field(default=None, ge=0)
    messages: list[Message] = Field(min_length=1, max_length=128)
    tools: list[Tool] | None = Field(default=None, max_length=32)
    tool_choice: Literal["auto", "none", "required"] | ToolChoice | None = None
    parallel_tool_calls: bool | None = None
    stream: Literal[False] = False
    max_tokens: int | None = Field(default=None, ge=1, le=65536)
    max_completion_tokens: int | None = Field(default=None, ge=1, le=65536)
    temperature: float | None = Field(default=None, ge=0, le=2, allow_inf_nan=False)
    top_p: float | None = Field(default=None, ge=0, le=1, allow_inf_nan=False)
    frequency_penalty: float | None = Field(default=None, ge=-2, le=2, allow_inf_nan=False)
    presence_penalty: float | None = Field(default=None, ge=-2, le=2, allow_inf_nan=False)
    stop: str | list[str] | None = None
    response_format: ResponseFormat | None = None

    @model_validator(mode="after")
    def bounded_turn(self):
        if self.max_tokens is not None and self.max_completion_tokens is not None:
            raise ValueError("choose one output limit")
        stops = self.stop if isinstance(self.stop, list) else [self.stop] if self.stop else []
        if len(stops) > 4 or any(not 0 < len(item) <= 256 for item in stops):
            raise ValueError("invalid stop sequences")
        names = [tool.function.name for tool in self.tools or []]
        if len(names) != len(set(names)):
            raise ValueError("tool names must be unique")
        if isinstance(self.tool_choice, ToolChoice) and self.tool_choice.function.name not in names:
            raise ValueError("selected tool is not declared")
        if self.tool_choice == "required" and not names:
            raise ValueError("required tools are missing")
        pending = set()
        for message in self.messages:
            if pending and message.role != "tool":
                raise ValueError("tool replies must complete before another turn")
            if message.tool_calls:
                ids = [call.id for call in message.tool_calls]
                if len(set(ids)) != len(ids):
                    raise ValueError("duplicate tool call id")
                pending.update(ids)
            if message.role == "tool":
                if message.tool_call_id not in pending:
                    raise ValueError("tool reply has no matching call")
                pending.remove(message.tool_call_id)
        if pending:
            raise ValueError("tool results are missing")
        value = self.model_dump(exclude_none=True)
        if len(json.dumps(value, ensure_ascii=False).encode()) > MAX_REQUEST_BYTES:
            raise ValueError("turn exceeds capacity")
        # Bound opaque JSON schemas without dereferencing or executing them.
        stack = [(value, 0)]
        while stack:
            item, depth = stack.pop()
            if depth > 32:
                raise ValueError("JSON nesting exceeds capacity")
            if isinstance(item, dict):
                stack.extend((child, depth + 1) for child in item.values())
            elif isinstance(item, list):
                stack.extend((child, depth + 1) for child in item)
        return self
