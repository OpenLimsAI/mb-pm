"""本人改用户名：项目管理（/account/username）与工作台「设置」（/portal/username）共用。

校验当前密码后改 IAM 用户名，并同步已绑定的项目管理成员；成员写库失败时撤销 IAM 改名。
操作对象只按调用者的 IAM sub 定位，不接受客户端传来的用户标识。
"""

import logging

from fastapi import HTTPException, status
from sqlalchemy import func
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import IAMIdentity, User
from app.services import iam_admin
from app.services.iam_admin import IAMError

log = logging.getLogger(__name__)


def _member_of(db: Session, subject: str, name: str) -> User | None:
    """账号对应的项目管理成员：已绑定的成员；未绑定时为用户名完全相同且未绑定其他 IAM 账号的预置成员
    （与首次登录关联的规则一致：大小写不同的同名成员不关联，须管理员核对，改名时按「已被占用」拒绝）。"""
    identity = db.get(IAMIdentity, (settings.casdoor_issuer, subject))
    if identity:
        return db.get(User, identity.user_id)
    candidate = db.query(User).filter(User.username == name).first()
    if (
        candidate is None
        or db.query(IAMIdentity)
        .filter_by(issuer=settings.casdoor_issuer, user_id=candidate.id)
        .first()
    ):
        return None
    return candidate


def change_own_username(
    db: Session, subject: str, new_name: str, current_password: str, member: User | None = None
) -> str:
    """member 为调用方已确定的项目管理成员；不传时按 sub 查找（含尚未绑定的同名预置成员，一并改名）。返回原用户名。"""
    old_name = iam_admin.get_user_by_sub(subject)["name"]
    if member is None:
        member = _member_of(db, subject, old_name)
    if new_name == old_name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "新用户名与当前用户名相同")
    # 预置但尚未开通 IAM 的业务用户也占用其用户名（首次登录按用户名关联）
    taken = db.query(User.id).filter(func.lower(User.username) == new_name)
    if member is not None:
        taken = taken.filter(User.id != member.id)
    if taken.first():
        raise HTTPException(status.HTTP_409_CONFLICT, "该用户名已被占用")
    if iam_admin.name_shared_across_orgs(old_name):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "IAM 的其他组织中有同名成员，为避免误改其角色，请联系 IAM 管理员修改用户名",
        )
    try:
        iam_admin.verify_password(old_name, current_password)
        iam_admin.rename_user(subject, new_name)
    except IAMError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    if member is None:
        return old_name
    member.username = new_name
    try:
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        try:
            iam_admin.rename_user(subject, old_name)
            detail = "用户名同步失败，已撤销修改，请稍后重试"
        except Exception:
            log.exception("用户名同步失败且 IAM 改名未能撤销：%s → %s", old_name, new_name)
            detail = f"用户名同步失败：IAM 中已改为 {new_name}，请联系管理员核对"
        raise HTTPException(status.HTTP_409_CONFLICT, detail) from exc
    return old_name
