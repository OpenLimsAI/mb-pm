"""ProjectFinances API —— 项目预算 / 支出（组合预算聚合用）。"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models import ProjectFinance, User
from app.schemas.finance import ProjectFinanceOut

router = APIRouter(prefix="/finances", tags=["finances"])


@router.get("", response_model=list[ProjectFinanceOut])
def list_finances(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return [ProjectFinanceOut.model_validate(f) for f in db.query(ProjectFinance).all()]
