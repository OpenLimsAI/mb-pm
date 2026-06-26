"""演示模式登录 — 仅凭 username 即可发 JWT。

生产替换：用 OAuth2PasswordRequestForm 接收 username + password，
verify_password 校验后再 create_access_token。
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.security import create_access_token
from app.db.session import get_db
from app.models import User
from app.schemas.auth import LoginRequest, TokenResponse
from app.schemas.user import UserOut

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter_by(username=payload.username, is_active=True).first()
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "user not found or inactive")
    token = create_access_token(subject=user.id, extra={"role": user.role})
    return TokenResponse(access_token=token, user=UserOut.model_validate(user))


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return UserOut.model_validate(user)
