"""自助注册、本人改用户名 / 改密码的请求体与校验规则（前端 src/lib/account.ts 同步）。"""

import re

from pydantic import BaseModel, EmailStr, Field, field_validator

# 小写字母 / 数字，可用 . _ - 分隔（不连续、不在首尾）；是 Casdoor 用户名规则的子集。
USERNAME_RE = re.compile(r"[a-z0-9]+(?:[._-][a-z0-9]+)*")
RESERVED_USERNAMES = {"admin", "administrator", "root", "system", "casdoor", "built-in", "app"}
PASSWORD_MIN, PASSWORD_MAX = 8, 64


def check_username(value: str) -> str:
    value = value.strip().lower()
    if not 3 <= len(value) <= 32:
        raise ValueError("用户名长度需为 3–32 个字符")
    if not USERNAME_RE.fullmatch(value):
        raise ValueError("用户名只能包含小写字母和数字，可用 . _ - 分隔（不能连用或出现在首尾）")
    if value in RESERVED_USERNAMES:
        raise ValueError("该用户名为系统保留，请换一个")
    return value


def check_password(value: str) -> str:
    if not PASSWORD_MIN <= len(value) <= PASSWORD_MAX:
        raise ValueError(f"密码长度需为 {PASSWORD_MIN}–{PASSWORD_MAX} 位")
    # 仅可见 ASCII：不含空格（Casdoor 拒绝），也避开 bcrypt 72 字节截断
    if not all("!" <= c <= "~" for c in value):
        raise ValueError("密码只能由英文字母、数字和符号组成，不能包含空格")
    if not (re.search(r"[A-Za-z]", value) and re.search(r"[0-9]", value)):
        raise ValueError("密码需同时包含字母和数字")
    return value


class RegisterInput(BaseModel):
    username: str = Field(max_length=64)
    display_name: str = Field(max_length=100)
    email: EmailStr
    password: str = Field(max_length=128)

    @field_validator("username")
    @classmethod
    def _username(cls, value: str) -> str:
        return check_username(value)

    @field_validator("display_name")
    @classmethod
    def _display_name(cls, value: str) -> str:
        value = value.strip()
        if not 1 <= len(value) <= 50:
            raise ValueError("姓名长度需为 1–50 个字符")
        if any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError("姓名包含无效字符")
        return value

    @field_validator("email")
    @classmethod
    def _email(cls, value: str) -> str:
        value = value.strip().lower()
        if len(value) > 120:
            raise ValueError("邮箱过长")
        return value

    @field_validator("password")
    @classmethod
    def _password(cls, value: str) -> str:
        return check_password(value)


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(max_length=128)

    @field_validator("new_password")
    @classmethod
    def _new_password(cls, value: str) -> str:
        return check_password(value)


class UsernameChange(BaseModel):
    new_username: str = Field(max_length=64)
    current_password: str = Field(min_length=1, max_length=128)

    @field_validator("new_username")
    @classmethod
    def _new_username(cls, value: str) -> str:
        return check_username(value)
