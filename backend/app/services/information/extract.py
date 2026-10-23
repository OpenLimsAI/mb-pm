"""PDF extraction runs outside the web process, with memory/CPU/output bounds."""

import json
import subprocess
import sys
from pathlib import Path


def extract_pdf(path: Path):
    try:
        result = subprocess.run(
            [sys.executable, "-m", "app.services.information.extract", str(path)],
            capture_output=True,
            timeout=55,
        )
        if result.returncode or len(result.stdout) > 12 * 1024 * 1024:
            raise ValueError("PDF 解析进程失败或达到资源上限，原文已保留")
        value = json.loads(result.stdout)
        if value.get("error"):
            raise ValueError(value["error"])
        return value["text"]
    except (subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        raise ValueError("PDF 解析超时，原文已保留，可重试解析") from exc


def main():
    import resource

    resource.setrlimit(resource.RLIMIT_CPU, (40, 40))
    # Darwin does not support lowering RLIMIT_AS; production Linux enforces the cap.
    if sys.platform.startswith("linux"):
        resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024, 768 * 1024 * 1024))
    from pypdf import PdfReader

    try:
        reader = PdfReader(sys.argv[1])
        if reader.is_encrypted:
            raise ValueError("PDF 已加密，需要管理员提供可读取版本")
        if len(reader.pages) > 1000:
            raise ValueError("PDF 超过 1000 页，需拆分后处理")
        parts = []
        size = 0
        for number, page in enumerate(reader.pages, 1):
            text = page.extract_text(extraction_mode="plain") or ""
            size += len(text)
            if size > 2_000_000:
                raise ValueError("PDF 正文超过解析大小上限")
            if text.strip():
                parts.append(f"\n\n## 第 {number} 页\n\n{text}")
        text = "".join(parts).strip()
        if len(text) < 80:
            raise ValueError("未提取到足够的可读正文，可能是扫描件，需 OCR 后再索引")
        print(json.dumps({"text": text}))
    except Exception as exc:
        print(json.dumps({"error": f"{type(exc).__name__}: {str(exc)[:350]}"}))


if __name__ == "__main__":
    main()
