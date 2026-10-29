from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, field_validator, model_validator

Provider = Literal["deepseek", "minimax", "openai", "custom", "ollama"]


class ProviderConfig(BaseModel):
    base_url: str = Field(max_length=500)
    model: str = Field(default="", max_length=160)
    api_key: str | None = Field(default=None, max_length=2000)
    clear_key: bool = False

    @field_validator("base_url")
    @classmethod
    def valid_url(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        try:
            parts = urlsplit(value)
            _ = parts.port
        except ValueError:
            raise ValueError("接口地址格式不正确") from None
        if (
            parts.scheme not in ("http", "https")
            or not parts.hostname
            or parts.username
            or parts.password
            or parts.query
            or parts.fragment
        ):
            raise ValueError("请填写不含账号、查询参数的 HTTP / HTTPS 接口地址")
        return value

    @field_validator("model", "api_key")
    @classmethod
    def trim(cls, value: str | None) -> str | None:
        if value is not None and any(c in value for c in ("\n", "\r")):
            raise ValueError("不能包含换行")
        return value.strip() if value is not None else None


class AISettingsInput(BaseModel):
    provider: Provider = "deepseek"
    providers: dict[Provider, ProviderConfig]
    offline_fallback: bool = False

    @model_validator(mode="after")
    def selected_model(self):
        if self.provider not in self.providers or not self.providers[self.provider].model:
            raise ValueError("请填写当前服务商的模型名称")
        if (
            self.offline_fallback
            and not self.providers.get(
                "ollama", ProviderConfig(base_url="http://127.0.0.1:11434")
            ).model
        ):
            raise ValueError("请先选择备用本地模型")
        return self


class ConnectionInput(BaseModel):
    provider: Provider
    config: ProviderConfig


class AnalysisInput(BaseModel):
    focus: str = Field(default="", max_length=1500)
