# ruff: noqa: B008
"""Feedback visible to signed-in members of the organization."""

from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.api.v1.solutions import identity
from app.db.session import get_db
from app.models.feedback import Feedback, FeedbackImage

router = APIRouter(prefix="/feedback", tags=["feedback"])
MAX_IMAGE = 5 * 1024 * 1024


def output(row):
    return {
        "id": row.id,
        "category": row.category,
        "description": row.description,
        "status": row.status,
        "author_name": row.author_name,
        "created_at": row.created_at.isoformat(),
        "images": [image.id for image in row.images],
    }


def image_type(data: bytes):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


@router.get("")
def listing(db: Session = Depends(get_db), claims: dict = Depends(identity)):
    rows = db.scalars(
        select(Feedback)
        .options(selectinload(Feedback.images).defer(FeedbackImage.content))
        .where(Feedback.issuer == claims["iss"])
        .order_by(Feedback.created_at.desc(), Feedback.id.desc())
    ).all()
    return [output(row) for row in rows]


@router.post("", status_code=201)
async def create(
    category: Literal["bug", "feature"] = Form(...),
    description: str = Form(...),
    images: list[UploadFile] = File(default=[]),
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    description = description.strip()
    if not description or len(description) > 5000:
        raise HTTPException(422, "请填写 1 至 5000 字的反馈描述")
    if len(images) > 3:
        raise HTTPException(422, "最多上传 3 张图片")
    attachments = []
    for file in images:
        data = await file.read(MAX_IMAGE + 1)
        if len(data) > MAX_IMAGE:
            raise HTTPException(413, "每张图片不能超过 5 MB")
        content_type = image_type(data)
        if not content_type:
            raise HTTPException(422, "仅支持 PNG、JPEG 或 WebP 图片")
        attachments.append(FeedbackImage(id=uuid4().hex, content_type=content_type, content=data))
    name = claims.get("displayName") or claims.get("name") or claims["sub"]
    row = Feedback(
        id=uuid4().hex,
        issuer=claims["iss"],
        author_id=claims["sub"],
        author_name=str(name)[:255],
        category=category,
        description=description,
        images=attachments,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return output(row)


class StatusInput(BaseModel):
    status: Literal["open", "fixed"]


@router.patch("/{feedback_id}")
def update(
    feedback_id: str,
    payload: StatusInput,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    row = db.get(Feedback, feedback_id)
    if not row or row.issuer != claims["iss"]:
        raise HTTPException(404, "反馈不存在")
    row.status = payload.status
    db.commit()
    return output(row)


@router.get("/images/{image_id}")
def image(image_id: str, db: Session = Depends(get_db), claims: dict = Depends(identity)):
    result = db.execute(
        select(FeedbackImage)
        .join(Feedback)
        .where(FeedbackImage.id == image_id, Feedback.issuer == claims["iss"])
    ).scalar_one_or_none()
    if not result:
        raise HTTPException(404, "图片不存在")
    return Response(
        result.content,
        media_type=result.content_type,
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'",
        },
    )
