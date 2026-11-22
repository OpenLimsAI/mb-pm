# ruff: noqa: B008
"""Feedback HTTP router (business & persistence logic in services/feedback_operations.py)."""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.api.multipart import upload_form
from app.api.v1 import portal  # noqa: F401
from app.api.v1.solutions import identity
from app.db.session import get_db
from app.services import accounts, iam_admin  # noqa: F401
from app.services import feedback_operations as ops
from app.services import feedback_workflow as workflow  # noqa: F401
from app.services.feedback_operations import (  # noqa: F401
    APPLICATIONS,
    MAX_IMAGE,
    ContentInput,
    EnabledInput,
    ManagementInput,
    ReadInput,
    RemindInput,
    ReplyInput,
    SimilarInput,
    Status,
    StatusInput,
    TransitionInput,
    activity_output,
    can_delete,
    complete,
    find_feedback,
    fingerprint,
    image_type,
    new_activity,
    notifications_output,
    output,
    participants,
    replay,
    summaries,
    uploaded_images,
)

router = APIRouter(prefix="/feedback", tags=["feedback"])


async def json_input(request: Request, model, *, limit=16_000):
    # Identity and Origin have passed before even malformed JSON is parsed.
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type and content_type != "application/json" and not content_type.endswith("+json"):
        raise HTTPException(415, "请使用 JSON 提交")
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > limit:
            raise HTTPException(413, "提交内容过长")
        data.extend(chunk)
    try:
        return model.model_validate_json(bytes(data))
    except ValidationError:
        raise HTTPException(422, "请检查处理状态或回复内容（回复为 1 至 2000 字）") from None


async def status_input(request: Request, claims: dict = Depends(identity)):
    del claims
    return await json_input(request, StatusInput)


async def reply_input(request: Request, claims: dict = Depends(identity)):
    del claims
    return await json_input(request, ReplyInput)


def body_dependency(model, *, limit=16_000):
    async def parsed(request: Request, claims: dict = Depends(identity)):
        del claims
        return await json_input(request, model, limit=limit)

    return parsed


@router.get("")
def listing(db: Session = Depends(get_db), claims: dict = Depends(identity)):
    return ops.list_feedbacks(db, claims)


@router.post("", status_code=201)
async def create(
    request: Request,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    # Parse only after identity has passed. Never declare File/Form dependencies here.
    async with upload_form(request, max_files=3, max_fields=10, max_part_size=20_000) as form:
        parsed = await ops.parse_create_form(form)
    return ops.persist_created_feedback(db, claims, parsed)


@router.patch("/{feedback_id}")
def update(
    feedback_id: str,
    payload: StatusInput = Depends(status_input),
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    return ops.update_feedback_status(db, feedback_id, payload, claims)


@router.get("/{feedback_id}/activities")
def activities(
    feedback_id: str,
    before: str | None = Query(default=None, min_length=1, max_length=32),
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    return ops.list_feedback_activities(db, feedback_id, before, claims)


@router.post("/{feedback_id}/replies", status_code=201)
def reply(
    feedback_id: str,
    payload: ReplyInput = Depends(reply_input),
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    return ops.reply_to_feedback(db, feedback_id, payload, claims)


@router.get("/images/{image_id}")
def image(image_id: str, db: Session = Depends(get_db), claims: dict = Depends(identity)):
    content, content_type = ops.get_feedback_image(db, image_id, claims)
    return Response(
        content,
        media_type=content_type,
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'",
        },
    )


@router.delete("/{feedback_id}", status_code=204)
def delete_feedback(
    feedback_id: str,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    ops.remove_feedback(db, feedback_id, claims)
    return Response(status_code=204)


@router.get("/people")
def people(db: Session = Depends(get_db), claims: dict = Depends(identity)):
    return {
        "items": [{"id": key, "name": value} for key, value in participants(db, claims).items()]
    }


@router.get("/notifications")
def notifications(
    unread_only: bool = False, db: Session = Depends(get_db), claims: dict = Depends(identity)
):
    return notifications_output(db, claims, unread_only)


@router.post("/notifications/read")
def read_notifications(
    payload: ReadInput = Depends(body_dependency(ReadInput, limit=16000)),
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    return ops.mark_notifications_read(db, payload, claims)


@router.get("/workbench")
def workbench(db: Session = Depends(get_db), claims: dict = Depends(identity)):
    return ops.build_workbench(db, claims)


@router.post("/similar")
def similar(
    payload: SimilarInput = Depends(body_dependency(SimilarInput, limit=40000)),
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    return ops.find_similar_feedbacks(db, payload, claims)


@router.patch("/{feedback_id}/content")
def edit_content(
    feedback_id: str,
    payload: ContentInput = Depends(body_dependency(ContentInput, limit=64000)),
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    return ops.edit_feedback_content(db, feedback_id, payload, claims)


@router.patch("/{feedback_id}/content-with-images")
async def edit_with_images(
    feedback_id: str,
    request: Request,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    async with upload_form(request, max_files=3, max_fields=10, max_part_size=20_000) as form:
        payload, keep, pictures = await ops.parse_edit_with_images_form(form)
    return ops.apply_edit_with_images(db, feedback_id, claims, payload, keep, pictures)


@router.post("/{feedback_id}/claim")
def claim(feedback_id: str, db: Session = Depends(get_db), claims: dict = Depends(identity)):
    return ops.claim_feedback(db, feedback_id, claims)


@router.patch("/{feedback_id}/management")
def management(
    feedback_id: str,
    payload: ManagementInput = Depends(body_dependency(ManagementInput, limit=16000)),
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    return ops.update_feedback_management(db, feedback_id, payload, claims)


@router.post("/{feedback_id}/transition", status_code=201)
def transition(
    feedback_id: str,
    payload: TransitionInput = Depends(body_dependency(TransitionInput, limit=64000)),
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    return ops.transition_feedback(db, feedback_id, payload, claims)


@router.post("/{feedback_id}/replies-with-images", status_code=201)
async def reply_with_images(
    feedback_id: str,
    request: Request,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    async with upload_form(request, max_files=3, max_fields=3, max_part_size=12_000) as form:
        payload, pictures = await ops.parse_reply_with_images_form(form)
    return ops.apply_reply_with_images(db, feedback_id, claims, payload, pictures)


@router.put("/{feedback_id}/vote")
def vote(
    feedback_id: str,
    payload: EnabledInput = Depends(body_dependency(EnabledInput, limit=16000)),
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    return ops.set_feedback_vote(db, feedback_id, payload, claims)


@router.put("/{feedback_id}/follow")
def follow(
    feedback_id: str,
    payload: EnabledInput = Depends(body_dependency(EnabledInput, limit=16000)),
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    return ops.set_feedback_follow(db, feedback_id, payload, claims)


@router.post("/{feedback_id}/read")
def read_feedback(
    feedback_id: str, db: Session = Depends(get_db), claims: dict = Depends(identity)
):
    return ops.mark_feedback_read(db, feedback_id, claims)


@router.post("/{feedback_id}/remind", status_code=201)
def remind(
    feedback_id: str,
    payload: RemindInput = Depends(body_dependency(RemindInput, limit=16000)),
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    return ops.remind_feedback(db, feedback_id, payload, claims)


@router.get("/{feedback_id}")
def detail(feedback_id: str, db: Session = Depends(get_db), claims: dict = Depends(identity)):
    return ops.get_feedback_detail(db, feedback_id, claims)
