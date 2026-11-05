from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, field_validator, model_validator

from app.schemas.model_network import enterprise_url

Provider = Literal["deepseek", "minimax", "kimi", "ollama"]
# 分析提示词（告诉模型分析什么、按什么结构输出）的长度上限
MAX_PROMPT_LENGTH = 4000


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
    preserve_shared_models: bool = False
    # 默认分析提示词（项目 / 财务）；留空或与系统默认相同时使用系统默认
    analysis_prompt: str = Field(default="", max_length=MAX_PROMPT_LENGTH)
    finance_analysis_prompt: str = Field(default="", max_length=MAX_PROMPT_LENGTH)

    @model_validator(mode="after")
    def selected_model(self):
        if self.preserve_shared_models:
            if self.providers:
                raise ValueError("仅保存提示词时不能同时提交模型配置")
            return self
        for provider, config in self.providers.items():
            if config.model or config.api_key or provider == self.provider:
                enterprise_url(provider, config.base_url)
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

    @model_validator(mode="after")
    def approved_endpoint(self):
        enterprise_url(self.provider, self.config.base_url)
        return self


class AnalysisInput(BaseModel):
    focus: str = Field(default="", max_length=1500)
    # 本次临时修改的分析提示词；为空则使用 AI 设置中的默认提示词
    prompt: str | None = Field(default=None, max_length=MAX_PROMPT_LENGTH)
