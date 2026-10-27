"""门户只返回身份与应用准入信息，不包含业务数据或令牌。"""

from typing import Literal

from pydantic import BaseModel


class PortalUserOut(BaseModel):
    id: str
    username: str
    display_name: str


class PortalApplicationOut(BaseModel):
    id: Literal["pm", "kb", "information", "solutions", "feedback", "accounts", "mdm"]
    enabled: bool
    reason: str | None = None


class PortalMeOut(BaseModel):
    user: PortalUserOut
    # 非秘密身份隔离键：防止同一浏览器切换 IAM 发行方 / 组织 / 账号时混用界面草稿。
    identity_namespace: str = ""
    applications: list[PortalApplicationOut]
    # 管理员设置了临时密码：须先在门户里改密码
    must_change_password: bool = False
    # 「设置 › AI 分析」：系统管理员 / 项目负责人（cmc_lead）
    can_configure_ai: bool = False
