"""应用设置。所有配置从环境变量加载，对应 .env 文件。"""

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # —— 数据库 —— #
    # 默认 SQLite 单文件，零依赖即可运行；切 PostgreSQL 只需改 DATABASE_URL，
    # 例如 postgresql+psycopg://cmc:cmc@localhost:5432/cmc_pms
    DATABASE_URL: str = Field(
        default="sqlite:///./cmc_pms_lite.db",
        description="SQLAlchemy URL，默认 SQLite，可切 PostgreSQL",
    )

    # 启动时若库为空则自动建表 + 灌种子数据
    AUTO_SEED: bool = True

    # —— 前端静态资源 —— #
    # 设为已构建的 SPA 目录（含 index.html）即由后端同源托管前端；
    # 留空则纯 API 模式（本地 dev 用 Vite 独立跑前端）。容器镜像里指向 /code/static。
    STATIC_DIR: str = ""

    # —— 应用 —— #
    APP_ENV: str = "development"
    APP_SECRET: str = "change-me"
    # CTO Lite 前端默认跑在 5175
    APP_CORS_ORIGINS: str = "http://localhost:5175,http://localhost:5173,http://localhost:5174"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.APP_CORS_ORIGINS.split(",") if o.strip()]

    # —— JWT —— #
    JWT_ALGORITHM: str = "HS256"
    JWT_ACCESS_EXPIRE_MINUTES: int = 480  # 8 小时

    # —— 日志 —— #
    LOG_LEVEL: str = "INFO"

    # —— Casdoor OIDC —— #
    # CASDOOR_ENDPOINT 用于校验 token 的 issuer（须与 token 的 iss 字节一致，即浏览器侧 http://localhost:8000）。
    # CASDOOR_JWKS_URL 是后端「拉取」JWKS 的地址，可与 issuer 不同：容器内需用 host.docker.internal
    # 才能访问宿主机上的 Casdoor。留空则默认 {CASDOOR_ENDPOINT}/.well-known/jwks。
    CASDOOR_ENDPOINT: str = "http://localhost:8000"
    CASDOOR_JWKS_URL: str = ""
    CASDOOR_CLIENT_ID: str = "mppm-client-id-0001"
    CASDOOR_ORG: str = "mabpharm"

    @property
    def casdoor_jwks_url(self) -> str:
        return self.CASDOOR_JWKS_URL or f"{self.CASDOOR_ENDPOINT}/.well-known/jwks"


settings = Settings()
