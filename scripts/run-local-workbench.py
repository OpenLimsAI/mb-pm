"""Run the fixed localhost workbench with a private, persistent local configuration."""

import argparse
import logging
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import dotenv_values


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="启动 localhost:1234 本地工作台")
    parser.add_argument(
        "--config", type=Path, default=root / "backend/.local/runtime.env"
    )
    args = parser.parse_args()
    if not args.config.is_file():
        raise SystemExit(
            "缺少本地私有配置；请沿用已有数据库、模型和加密密钥，勿改接空库。"
        )
    config = dotenv_values(args.config)
    if config.get("APP_ENV") != "development":
        raise SystemExit("此脚本仅用于本地开发配置。")
    if config.get("PMS_PUBLIC_URL") != "http://localhost:1234":
        raise SystemExit("本地浏览器入口必须保持 http://localhost:1234。")
    if config.get("APP_PROCESS_ROLE") != "combined":
        raise SystemExit("本地单进程工作台需要 APP_PROCESS_ROLE=combined。")
    if config.get("ASSISTANT_REQUEST_WORKER_ENABLED", "").lower() != "true":
        raise SystemExit(
            "请开启 ASSISTANT_REQUEST_WORKER_ENABLED，避免问题排队后无人处理。"
        )
    if any(
        config.get(name, "").lower() != "false"
        for name in ("AUTO_MIGRATE_SCHEMA", "AUTO_SEED")
    ):
        raise SystemExit("复用本地数据时必须关闭自动迁移与演示数据初始化。")
    if urlsplit(config.get("DATABASE_URL", "")).hostname not in {
        "127.0.0.1",
        "localhost",
        "::1",
    }:
        raise SystemExit("本地统一入口只允许连接已配置的回环开发数据库。")
    if config.get("KNOWLEDGE_NOTES_ORIGIN") != "http://localhost:4322":
        raise SystemExit("本地知识库笔记来源必须为 http://localhost:4322。")
    static = root / "dist"
    if not (static / "index.html").is_file():
        raise SystemExit("请先构建真实 API、combined 模式的本地前端。")
    os.environ.update(
        {name: value for name, value in config.items() if value is not None}
    )
    os.environ["STATIC_DIR"] = str(static)
    backend = root / "backend"
    os.chdir(backend)
    sys.path.insert(0, str(backend))
    sys.path.insert(0, str(root / "scripts"))

    import uvicorn

    from local_model_dns import install

    install()
    logging.getLogger("httpx").setLevel(logging.WARNING)
    uvicorn.run("app.main:app", host="127.0.0.1", port=1234, access_log=False)


if __name__ == "__main__":
    main()
