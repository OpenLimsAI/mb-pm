"""门户只返回身份与应用准入信息，不包含业务数据或令牌。"""

from typing import Literal

from pydantic import BaseModel


class PortalUserOut(BaseModel):
    id: str
    username: str
    display_name: str


class PortalApplicationOut(BaseModel):
    id: Literal["pm", "kb"]
    enabled: bool
    reason: str | None = None


class PortalMeOut(BaseModel):
    user: PortalUserOut
    applications: list[PortalApplicationOut]
