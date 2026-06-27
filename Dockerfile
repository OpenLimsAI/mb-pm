# syntax=docker/dockerfile:1
#
# CMC-PMS · CTO Lite —— 单镜像（前端 SPA + FastAPI 后端同源托管）。
# 数据库为独立的 PostgreSQL 实例，通过 DATABASE_URL 注入（见 docker-compose.yml）。

# ============ Stage 1: 构建前端 SPA ============
FROM node:20-alpine AS frontend
WORKDIR /web

# 依赖层缓存：仅 package 清单变更才重新安装
COPY package.json package-lock.json ./
RUN npm ci

# 构建所需源码与配置
COPY index.html vite.config.ts tailwind.config.js postcss.config.js ./
COPY tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY src ./src
COPY public ./public

# 同源部署：前端调用后端相对路径 /api/v1，并启用真实 API（非 mock）
ENV VITE_USE_API=true \
    VITE_API_URL=/api/v1
RUN npm run build          # 产物 → /web/dist

# ============ Stage 2: 后端 + 静态资源 运行镜像 ============
FROM python:3.11-slim AS app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    STATIC_DIR=/code/static \
    APP_ENV=production

WORKDIR /code

# psycopg[binary] 自带 libpq，无需系统级编译依赖，镜像保持精简
COPY backend/requirements.txt ./
RUN pip install -r requirements.txt

# 后端源码（含 app/seed/seed.json 种子）
COPY backend/app ./app

# 前端构建产物 → 后端同源托管目录
COPY --from=frontend /web/dist ./static

EXPOSE 8000

# 启动即由 lifespan 自动建表 + 库空时灌种子（幂等），随后提供 SPA + /api/v1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
