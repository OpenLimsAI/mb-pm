#!/usr/bin/env bash
# 一键启动 CTO Lite 后端（FastAPI + SQLite）。
# 首次运行自动创建虚拟环境、安装依赖；启动时自动建表 + 灌种子数据。
set -e
cd "$(dirname "$0")"

PORT="${PORT:-8000}"

if [ ! -d .venv ]; then
  echo "首次运行：创建虚拟环境并安装依赖 ..."
  if command -v uv >/dev/null 2>&1; then
    uv venv --python 3.11 .venv
    uv pip install --python .venv -r requirements.txt
  else
    # 退化路径：寻找 3.11+ 解释器
    PY=""
    for c in python3.13 python3.12 python3.11; do
      command -v "$c" >/dev/null 2>&1 && { PY="$c"; break; }
    done
    [ -z "$PY" ] && { echo "需要 Python 3.11+（或安装 uv）"; exit 1; }
    "$PY" -m venv .venv
    .venv/bin/pip install --upgrade pip
    .venv/bin/pip install -r requirements.txt
  fi
fi

echo "启动后端： http://127.0.0.1:${PORT}  （文档 /docs）"
exec .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port "${PORT}" --reload
