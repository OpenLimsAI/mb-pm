"""Templates API — CRUD + 版本管理 + Excel 导入导出。

路由：
    GET    /api/v1/templates                       列表
    POST   /api/v1/templates                       新建（含初始 V1.0）
    GET    /api/v1/templates/{id}                  详情（含全部版本）
    PATCH  /api/v1/templates/{id}                  改元数据
    DELETE /api/v1/templates/{id}
    POST   /api/v1/templates/{id}/versions         追加新版本
    GET    /api/v1/templates/{id}/export           导出 xlsx
    GET    /api/v1/templates/excel-format          下载空白导入模板
    POST   /api/v1/templates/import                Excel 导入 — multipart 上传
"""

from datetime import datetime, timezone
from io import BytesIO
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session, selectinload

from app.api.deps import get_current_user, require_role
from app.db.session import get_db
from app.models import Template, TemplateVersion, User
from app.schemas.template import (
    ImportResult,
    TemplateCreate,
    TemplateOut,
    TemplateUpdate,
    TemplateVersionCreate,
    TemplateVersionOut,
)
from app.services.excel import (
    count_nodes,
    export_template_to_xlsx,
    generate_blank_template_xlsx,
    parse_excel,
)

router = APIRouter(prefix="/templates", tags=["templates"])


def _next_version_number(template: Template) -> str:
    """V1.0 → V1.1 → V1.2 ...（保持与前端编辑器一致）。"""
    cur = template.current_version
    parts = cur.lstrip("V").split(".")
    try:
        major, minor = int(parts[0]), int(parts[1])
        return f"V{major}.{minor + 1}"
    except (ValueError, IndexError):
        return f"V{len(template.versions) + 1}.0"


# ============= CRUD =============

@router.get("", response_model=list[TemplateOut])
def list_templates(
    product_type: str | None = None,
    is_active: bool | None = Query(None),
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    q = db.query(Template).options(selectinload(Template.versions))
    if product_type:
        q = q.filter(Template.product_type == product_type)
    if is_active is not None:
        q = q.filter(Template.is_active == is_active)
    return [TemplateOut.model_validate(t) for t in q.all()]


@router.post("", response_model=TemplateOut, status_code=status.HTTP_201_CREATED)
def create_template(
    payload: TemplateCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin", "cmc_lead")),
):
    if not payload.id:
        payload.id = f"t-{uuid4().hex[:10]}"
    if db.query(Template).filter_by(id=payload.id).first():
        raise HTTPException(status.HTTP_409_CONFLICT, f"template {payload.id!r} exists")

    now = datetime.now(timezone.utc)
    template = Template(
        id=payload.id,
        name=payload.name,
        product_type=payload.product_type,
        current_version="V1.0",
        description=payload.description,
        is_active=payload.is_active,
        created_by=user.id,
    )
    db.add(template)
    db.flush()

    initial_version = TemplateVersion(
        id=f"v-{uuid4().hex[:10]}",
        template_id=template.id,
        version_number="V1.0",
        structure_json=payload.initial_structure,
        change_summary="初始版本",
        change_source="visual_edit",
        modified_by=user.id,
        modified_at=now,
        is_current=True,
    )
    db.add(initial_version)
    db.commit()
    db.refresh(template)
    return TemplateOut.model_validate(template)


@router.get("/excel-format")
def download_excel_format(_user: User = Depends(get_current_user)):
    """下载空白的导入模板 — 含字段说明 + 数据字典。"""
    data = generate_blank_template_xlsx()
    return StreamingResponse(
        BytesIO(data),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": 'attachment; filename="cmc-pms-template-import-format.xlsx"',
        },
    )


@router.post("/import", response_model=ImportResult)
async def import_excel(
    file: UploadFile = File(...),
    mode: str = Form("create"),  # 'create' | 'overwrite'
    template_id: str | None = Form(None),
    new_name: str | None = Form(None),
    product_type: str | None = Form(None),
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin", "cmc_lead")),
):
    """Excel 上传 + 校验。

    mode=create     : new_name + product_type 必填
    mode=overwrite  : template_id 必填，导入会作为该模板的新版本
    """
    if mode not in ("create", "overwrite"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "mode 必须是 'create' 或 'overwrite'")

    raw = await file.read()
    structure, errors = parse_excel(raw)

    if errors or structure is None:
        return ImportResult(success=False, errors=errors)

    summary = count_nodes(structure)
    now = datetime.now(timezone.utc)

    if mode == "create":
        if not new_name or not product_type:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "create 模式需提供 new_name + product_type")
        # 把根节点的 name 改为 new_name
        structure["name"] = new_name

        tmpl = Template(
            id=f"t-{uuid4().hex[:10]}",
            name=new_name, product_type=product_type,
            current_version="V1.0", description="通过 Excel 批量导入创建",
            is_active=True, created_by=user.id,
        )
        db.add(tmpl); db.flush()
        ver = TemplateVersion(
            id=f"v-{uuid4().hex[:10]}",
            template_id=tmpl.id, version_number="V1.0",
            structure_json=structure,
            change_summary=f"Excel 导入：{summary['subProjects']} 子项目 / {summary['tasks']} 任务",
            change_source="excel_import",
            modified_by=user.id, modified_at=now, is_current=True,
        )
        db.add(ver); db.commit()
        return ImportResult(success=True, template_id=tmpl.id, version_id=ver.id, summary=summary)

    # overwrite 模式
    if not template_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "overwrite 模式需提供 template_id")
    tmpl = db.query(Template).filter_by(id=template_id).first()
    if not tmpl:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "template not found")

    new_version_number = _next_version_number(tmpl)
    structure["name"] = tmpl.name

    # 老版本全部 is_current=False
    db.query(TemplateVersion).filter_by(template_id=tmpl.id).update({"is_current": False})
    new_ver = TemplateVersion(
        id=f"v-{uuid4().hex[:10]}",
        template_id=tmpl.id, version_number=new_version_number,
        structure_json=structure,
        change_summary=f"Excel 覆盖导入：{summary['subProjects']} 子项目 / {summary['tasks']} 任务",
        change_source="excel_import",
        modified_by=user.id, modified_at=now, is_current=True,
    )
    db.add(new_ver)
    tmpl.current_version = new_version_number
    db.commit()
    return ImportResult(success=True, template_id=tmpl.id, version_id=new_ver.id, summary=summary)


@router.get("/{template_id}", response_model=TemplateOut)
def get_template(
    template_id: str,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    tmpl = (
        db.query(Template)
        .options(selectinload(Template.versions))
        .filter_by(id=template_id)
        .first()
    )
    if not tmpl:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "template not found")
    return TemplateOut.model_validate(tmpl)


@router.patch("/{template_id}", response_model=TemplateOut)
def update_template(
    template_id: str,
    payload: TemplateUpdate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_role("admin", "cmc_lead")),
):
    tmpl = db.query(Template).options(selectinload(Template.versions)).filter_by(id=template_id).first()
    if not tmpl:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "template not found")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(tmpl, k, v)
    db.commit()
    db.refresh(tmpl)
    return TemplateOut.model_validate(tmpl)


@router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_template(
    template_id: str,
    db: Session = Depends(get_db),
    _user: User = Depends(require_role("admin", "cmc_lead")),
):
    tmpl = db.query(Template).filter_by(id=template_id).first()
    if not tmpl:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "template not found")
    db.delete(tmpl)
    db.commit()


# ============= Versions =============

@router.post("/{template_id}/versions", response_model=TemplateVersionOut, status_code=status.HTTP_201_CREATED)
def add_version(
    template_id: str,
    payload: TemplateVersionCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin", "cmc_lead")),
):
    tmpl = db.query(Template).filter_by(id=template_id).first()
    if not tmpl:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "template not found")

    # 老版本全部 is_current=False
    db.query(TemplateVersion).filter_by(template_id=template_id).update({"is_current": False})

    ver = TemplateVersion(
        id=f"v-{uuid4().hex[:10]}",
        template_id=template_id,
        version_number=payload.version_number,
        structure_json=payload.structure_json,
        change_summary=payload.change_summary,
        change_source=payload.change_source,
        modified_by=user.id,
        modified_at=datetime.now(timezone.utc),
        is_current=True,
    )
    db.add(ver)
    tmpl.current_version = payload.version_number
    db.commit()
    db.refresh(ver)
    return TemplateVersionOut.model_validate(ver)


# ============= Excel 导出 =============

@router.get("/{template_id}/export")
def export_template(
    template_id: str,
    version_id: str | None = Query(None, description="不传 = 当前版本"),
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    tmpl = db.query(Template).options(selectinload(Template.versions)).filter_by(id=template_id).first()
    if not tmpl:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "template not found")

    if version_id:
        ver = next((v for v in tmpl.versions if v.id == version_id), None)
    else:
        ver = next((v for v in tmpl.versions if v.is_current), None)
    if not ver:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "version not found")

    data = export_template_to_xlsx(tmpl.name, ver.version_number, ver.structure_json)
    safe_name = tmpl.name.replace(" ", "_")
    filename = f"{safe_name}_{ver.version_number}.xlsx"
    return StreamingResponse(
        BytesIO(data),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
