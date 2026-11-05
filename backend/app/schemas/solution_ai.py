"""Private, bounded report model settings; no provider secret appears in outputs."""

import ipaddress
import re
from typing import Literal
from urllib.parse import urlsplit, urlunsplit

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator

from app.schemas.model_network import validate_origin

Provider = Literal["deepseek", "minimax", "kimi", "glm", "openai", "custom"]
RESERVED_IDS = {"system", "retrieval"}
METADATA_HOSTS = {"metadata", "metadata.google.internal", "instance-data.ec2.internal"}


def allowed_address(value: str) -> bool:
    """Explicit RFC1918/loopback/ULA self-hosting is allowed; special destinations are not."""
    address = ipaddress.ip_address(value)
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped or address.sixtofour or address.teredo:
            return False
        if address in ipaddress.ip_network("fd00:ec2::/32") or address in ipaddress.ip_network(
            "fd20:ce::/32"
        ):
            return False
    if str(address) in {"168.63.129.16", "100.100.100.200"}:
        return False
    if address.is_link_local or address.is_multicast or address.is_unspecified:
        return False
    # Only genuinely routable public destinations or explicit local model networks.
    local = (
        ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8")
        if address.version == 4
        else ("::1/128", "fc00::/7")
    )
    return any(address in ipaddress.ip_network(net) for net in local) or (
        address.is_global and not address.is_reserved
    )


def model_url(value: str) -> str:
    value = value.strip().rstrip("/")
    if any(ord(c) < 33 or ord(c) == 127 for c in value) or "\\" in value:
        raise ValueError("模型地址格式不正确")
    try:
        parts = urlsplit(value)
        host = (parts.hostname or "").rstrip(".").encode("idna").decode("ascii").lower()
        port = parts.port
        if (
            parts.scheme not in {"http", "https"}
            or not host
            or parts.username is not None
            or parts.password is not None
            or "?" in value
            or "#" in value
            or "%" in host
            or host in METADATA_HOSTS
            or host.endswith(".metadata.google.internal")
        ):
            raise ValueError("模型地址仅支持无凭据、查询和片段的 HTTP/HTTPS 地址")
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", host):
                raise ValueError("模型主机名称不正确") from None
            # Reject legacy numeric IP spellings (octal/hex/short IPv4).
            if re.fullmatch(r"[0-9.]+", host) or host.startswith("0x"):
                raise ValueError("请使用标准 IP 地址") from None
        else:
            if not allowed_address(str(address)):
                raise ValueError("不可连接元数据或特殊网络地址")
        authority = f"[{host}]" if ":" in host else host
        if port is not None:
            if port < 1:
                raise ValueError("模型端口不正确")
            authority += f":{port}"
        normalized = urlunsplit((parts.scheme, authority, parts.path, "", ""))
        validate_origin(normalized)
        return normalized
    except (UnicodeError, ValueError):
        raise ValueError("模型地址无效或属于禁止访问的网络地址") from None


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ModelProfile(Input):
    id: str = Field(min_length=1, max_length=80, pattern=r"^[a-zA-Z0-9_-]+$")
    name: str = Field(min_length=1, max_length=80)
    provider: Provider
    base_url: str = Field(min_length=1, max_length=500)
    model: str = Field(min_length=1, max_length=160)
    api_key: SecretStr | None = Field(default=None, max_length=2000)
    clear_key: bool = False

    @field_validator("id")
    @classmethod
    def profile_id(cls, value):
        if value in RESERVED_IDS:
            raise ValueError("模型标识已保留")
        return value

    @field_validator("name", "model")
    @classmethod
    def nonempty(cls, value):
        value = value.strip()
        if not value or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError("模型名称不可为空或包含控制字符")
        return value

    @field_validator("base_url")
    @classmethod
    def safe_endpoint(cls, value):
        return model_url(value)

    @field_validator("api_key")
    @classmethod
    def safe_key(cls, value):
        if value is not None:
            key = value.get_secret_value().strip()
            if any(ord(c) < 32 or ord(c) == 127 for c in key):
                raise ValueError("密钥不可包含控制字符")
            return SecretStr(key)
        return value


class ModelSettingsInput(Input):
    profiles: list[ModelProfile] = Field(max_length=20)
    default_profile_id: str | None = Field(default=None, max_length=80)
    revision: int = Field(ge=0)

    @model_validator(mode="after")
    def integrity(self):
        ids = {p.id for p in self.profiles}
        if len(ids) != len(self.profiles):
            raise ValueError("模型标识不可重复")
        if self.default_profile_id is not None and self.default_profile_id not in ids:
            raise ValueError("默认模型必须在本人配置中")
        return self


class ModelTestInput(Input):
    profile: ModelProfile


class SharedModelProfile(ModelProfile):
    id: str = Field(min_length=1, max_length=80, pattern=r"^(?:shared:)?[a-zA-Z0-9_-]{1,72}$")
    provider: Literal["deepseek", "minimax", "kimi", "glm", "openai", "custom", "ollama"]


class SharedModelSettingsInput(ModelSettingsInput):
    profiles: list[SharedModelProfile] = Field(max_length=20)


class SharedModelTestInput(Input):
    profile: SharedModelProfile
