"""门户「账号管理」的请求 / 响应体。账号与角色以 IAM 为准，项目管理成员档案（专业组、周工时）随账号维护。

身份（系统管理员 / 项目负责人 / 员工）如何对应 IAM 角色，见 services/accounts.py 开头的说明。
"""

from typing import Literal

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.schemas.account import check_password, check_username

Identity = Literal["admin", "lead", "staff"]
ActorTier = Literal["admin", "lead"]
# 与前端 src/mock/dictionaries.ts 的 specialtyGroups 一致
SpecialtyGroup = Literal["上游", "下游", "制剂", "分析", "稳定性", "工艺验证", "CMC综合"]
IssueKind = Literal[
    "iam_password_flag",
    "kb_missing",
    "pm_member_inactive",
    "pm_member_conflict",
    "default_account",
    "pm_only_member",
]


def _display_name(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("请填写姓名")
    return value


class PMMemberOut(BaseModel):
    id: str
    username: str
    active: bool
    bound: bool
    specialty_group: str | None
    weekly_hours: int


class AccountOut(BaseModel):
    id: str
    username: str
    display_name: str
    email: str
    created_at: str
    enabled: bool
    must_change_password: bool
    # Casdoor「是组织管理员」：只能在 IAM 管理台停用 / 删除 / 重置密码 / 改名
    org_admin: bool
    identity: Identity
    # 知识库默认对所有人开放（编辑）；false 时列入「需要处理」
    kb_enabled: bool
    # 实际持有的项目管理角色（多个时取最高的身份）
    pm_roles: list[str]
    # 账号管理不维护的其他角色（如 dikw-admin），只读显示
    other_roles: list[str]
    pm_member: PMMemberOut | None
    is_self: bool


class IssueOut(BaseModel):
    kind: IssueKind
    account_id: str | None = None
    member_id: str | None = None
    username: str
    display_name: str
    message: str


class AccountsOut(BaseModel):
    accounts: list[AccountOut]
    # 只有系统管理员看得到「需要处理」
    issues: list[IssueOut]
    # IAM 中已建立且启用的相关角色；界面据此禁用不存在的身份
    roles: list[str]
    # 当前操作人：系统管理员可改所有信息；项目负责人只能查看
    actor: ActorTier


class AccountCreate(BaseModel):
    username: str = Field(max_length=64)
    display_name: str = Field(max_length=50)
    password: str = Field(max_length=128)
    email: EmailStr | None = None
    identity: Identity = "staff"
    specialty_group: SpecialtyGroup | None = None
    weekly_hours: int = Field(40, ge=0, le=80)

    @field_validator("username")
    @classmethod
    def _username(cls, value: str) -> str:
        return check_username(value)

    @field_validator("display_name")
    @classmethod
    def _name(cls, value: str) -> str:
        return _display_name(value)

    @field_validator("password")
    @classmethod
    def _password(cls, value: str) -> str:
        return check_password(value)


class AccountUpdate(BaseModel):
    """只处理请求中出现（且不为 null）的字段；专业组传空字符串表示清空。"""

    display_name: str | None = Field(None, max_length=50)
    email: EmailStr | Literal[""] | None = None
    enabled: bool | None = None
    identity: Identity | None = None
    specialty_group: SpecialtyGroup | Literal[""] | None = None
    weekly_hours: int | None = Field(None, ge=0, le=80)

    @field_validator("display_name")
    @classmethod
    def _name(cls, value: str | None) -> str | None:
        return None if value is None else _display_name(value)


class UsernameUpdate(BaseModel):
    username: str = Field(max_length=64)

    @field_validator("username")
    @classmethod
    def _username(cls, value: str) -> str:
        return check_username(value)


class PasswordReset(BaseModel):
    password: str = Field(max_length=128)

    @field_validator("password")
    @classmethod
    def _password(cls, value: str) -> str:
        return check_password(value)
