"""Authenticated upload parsing with cleanup on limits, disconnects and cancellation."""

from contextlib import asynccontextmanager
from urllib.parse import parse_qsl

from starlette.datastructures import FormData
from starlette.exceptions import HTTPException
from starlette.formparsers import MultiPartException, MultiPartParser


@asynccontextmanager
async def upload_form(request, *, max_files, max_fields, max_part_size):
    # Call only inside the endpoint, after its identity/role dependency succeeds.
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type == "application/x-www-form-urlencoded":
        # Feedback without attachments may use a regular form; bound it before
        # decoding instead of allowing an unlimited number of small fields.
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > max_fields * max_part_size * 6:
                raise HTTPException(413, "表单内容过大")
        try:
            entries = parse_qsl(
                raw.decode("utf-8"), keep_blank_values=True, max_num_fields=max_fields
            )
        except (ValueError, UnicodeError):
            raise HTTPException(400, "表单格式不正确或字段过多") from None
        if any(len(value.encode("utf-8")) > max_part_size for pair in entries for value in pair):
            raise HTTPException(413, "表单字段过长")
        yield FormData(entries)
        return
    if content_type != "multipart/form-data":
        raise HTTPException(415, "上传需要表单格式")
    parser = MultiPartParser(
        request.headers,
        request.stream(),
        max_files=max_files,
        max_fields=max_fields,
        max_part_size=max_part_size,
    )
    try:
        form = await parser.parse()
    except BaseException as exc:
        # Starlette only does this itself for MultiPartException. Receive-level
        # size/time limits and client cancellation must also close spooled files.
        for file in parser._files_to_close_on_error:
            file.close()
        if isinstance(exc, MultiPartException):
            raise HTTPException(400, exc.message) from None
        raise
    try:
        yield form
    finally:
        await form.close()
