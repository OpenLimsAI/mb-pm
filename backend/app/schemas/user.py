"""User schemas。"""

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class UserBase(BaseModel):
    username: str = Field(..., max_length=50)
    display_name: str = Field(..., max_length=50)
    email: EmailStr
    role: str
    specialty_group: str | None = None
    weekly_available_hours: int = 40
    is_active: bool = True
    avatar_color: str | None = None


class UserCreate(UserBase):
    id: str | None = None  # 服务端可生成


class UserUpdate(BaseModel):
    display_name: str | None = None
    email: EmailStr | None = None
    role: str | None = None
    specialty_group: str | None = None
    weekly_available_hours: int | None = None
    is_active: bool | None = None
    avatar_color: str | None = None


class UserOut(UserBase):
    model_config = ConfigDict(from_attributes=True)
    id: str


class MeOut(UserOut):
    """当前登录用户；must_change_password 为 true 时须先改临时密码（其余接口返回 403）。"""

    must_change_password: bool = False
