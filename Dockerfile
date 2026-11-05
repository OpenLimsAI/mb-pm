# syntax=docker/dockerfile:1
#
# CMC-PMS · CTO Lite —— 单镜像（前端 SPA + FastAPI 后端同源托管）。
# 数据库为独立的 PostgreSQL 实例，通过 DATABASE_URL 注入（见 docker-compose.yml）。

# ============ Stage 1: 构建前端 SPA ============
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS frontend
WORKDIR /web

# 依赖层缓存：仅 package 清单变更才重新安装
COPY package.json package-lock.json ./
RUN npm ci

# 构建所需源码与配置
COPY index.html vite.config.ts tailwind.config.js postcss.config.js ./
COPY tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY src ./src
COPY public ./public
# npm prebuild 生成版本更新 HTML；仅引入说明内容与生成器。
COPY scripts/build-release-notes.mjs scripts/build-production.mjs scripts/production-build.mjs scripts/verify-production-build.mjs ./scripts/
COPY docs/releases/notes.json docs/releases/style.css ./docs/releases/

# 同源部署：前端调用后端相对路径 /api/v1，并启用真实 API（非 mock）
ARG VITE_APP_MODE
ARG SOURCE_REVISION
ENV VITE_APP_MODE=$VITE_APP_MODE \
    SOURCE_REVISION=$SOURCE_REVISION \
    VITE_USE_API=true \
    VITE_API_URL=/api/v1
RUN npm run build:production # 产物 → /web/dist，校验生产 API 与源码版本

# ============ Stage 2: 后端 + 静态资源 运行镜像 ============
FROM python:3.11-slim@sha256:db20d8506e2f15b6db39b40b6015ca46bae855dec6dd326d462cfe79ae972893 AS app
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    STATIC_DIR=/code/static \
    APP_ENV=production \
    AUTO_SEED=false \
    AUTO_MIGRATE_SCHEMA=false

WORKDIR /code

# psycopg[binary] 自带 libpq，无需系统级编译依赖，镜像保持精简
COPY backend/requirements.lock ./
RUN pip install --require-hashes -r requirements.lock \
    && pip uninstall --yes setuptools wheel
# 运行镜像不执行系统软件安装；移除未使用的 APT 及其库，减少运行时攻击面。
RUN dpkg --purge apt libapt-pkg7.0
RUN groupadd --gid 10001 app && useradd --uid 10001 --gid app --no-create-home app \
    && mkdir -p /code/.local /data/ai /data/information \
    && chown app:app /code/.local /data/ai /data/information

# 后端源码（含 app/seed/seed.json 种子）
COPY backend/app ./app
COPY backend/alembic ./alembic
COPY backend/alembic.ini ./alembic.ini

# 前端构建产物 → 后端同源托管目录
COPY --from=frontend /web/dist ./static

USER 10001:10001
EXPOSE 8000

# Production schema upgrades run once via python -m app.db.upgrade with separate owner credentials.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
