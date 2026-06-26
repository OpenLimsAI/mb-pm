"""认证 schemas。演示模式只用 username + 角色映射。"""

from pydantic import BaseModel

from app.schemas.user import UserOut


class LoginRequest(BaseModel):
    username: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut
