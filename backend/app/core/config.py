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

    # —— AI 设置 —— #
    # 服务商地址 / 模型 / API Key 保存在后端本机文件（0600，不回传浏览器、不进 Git / 镜像）；
    # 部署时指向持久化、受保护的目录。
    AI_SETTINGS_PATH: str = ".local/ai-settings.json"

    # Public search is opt-in and server-owned; never expose this key to browsers.
    ASSISTANT_WEB_ENABLED: bool = False
    ASSISTANT_WEB_API_KEY: str = ""
    ASSISTANT_WEB_MAX_RESULTS: int = Field(default=5, ge=1, le=8)

    # —— 信息获取（真实采集与受保护的原文归档）—— #
    KNOWLEDGE_NOTES_ORIGIN: str = "https://kb.openlims.ai"
    NOTES_WISDOM_CORE_URL: str = ""
    NOTES_WISDOM_TOKEN: str = ""
    NOTES_WISDOM_WORKER_ENABLED: bool = False

    # 旧行业信息已下线；仅保留历史数据。新「知识源」在独立界面设计阶段。
    INFORMATION_APP_ENABLED: bool = False
    INFORMATION_DATA_DIR: str = ".local/information"
    INFORMATION_MAX_ARCHIVE_MB: int = 5120
    INFORMATION_WORKER_ENABLED: bool = False
    INFORMATION_KB_URL: str = ""
    INFORMATION_KB_SECRET: str = ""

    # —— 应用 —— #
    APP_ENV: str = "development"
    # 同时作为 IAM 会话令牌的加密密钥：须为 ≥32 字符的随机值，否则 IAM 登录返回 503。
    APP_SECRET: str = "change-me"
    # CTO Lite 前端默认跑在 5175，并经同源代理访问 API。会话 cookie 会随跨域凭据请求发送，
    # 故只放行本系统自己的前端（localhost 的 cookie 不区分端口，勿加入其他本地应用的端口）。
    APP_CORS_ORIGINS: str = "http://localhost:5175"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.APP_CORS_ORIGINS.split(",") if o.strip()]

    # —— 日志 —— #
    LOG_LEVEL: str = "INFO"

    # —— mb-casd / Casdoor IAM —— #
    # 后端完成「授权码 + PKCE」交换，令牌加密存于服务端，浏览器只持有 HttpOnly 会话 cookie。
    # CASDOOR_ENDPOINT：浏览器可访问的 Casdoor 地址，也是校验 token `iss` 的期望值（须与 iss 字节一致）。
    # CASDOOR_INTERNAL_URL：后端访问 Casdoor 的地址（换 token / 拉 JWKS），容器内可指向
    #   host.docker.internal 或内网地址；留空则同 CASDOOR_ENDPOINT。
    # CASDOOR_JWKS_URL：单独覆盖 JWKS 地址（兼容旧配置）；留空则为 {内部地址}/.well-known/jwks。
    CASDOOR_ENDPOINT: str = "http://localhost:8000"
    CASDOOR_INTERNAL_URL: str = ""
    CASDOOR_JWKS_URL: str = ""
    CASDOOR_CLIENT_ID: str = "mppm-client-id-0001"
    CASDOOR_CLIENT_SECRET: str = ""  # 仅后端保存，绝不下发浏览器
    CASDOOR_ORG: str = "mabpharm"
    # 用户在浏览器中访问本系统的 origin（协议 + 主机 + 端口，不带路径）。
    # 回调 {PMS_PUBLIC_URL}/api/v1/auth/callback 与登出回跳 {PMS_PUBLIC_URL}/login
    # 须登记在 Casdoor 应用的 redirectUris 中（localhost / 127.0.0.1 由 Casdoor 免登记放行）。
    PMS_PUBLIC_URL: str = "http://localhost:5175"
    # Explicit MDM root including deployment path; blank disables launch. No identity in URL.
    MDM_PUBLIC_URL: str = ""
    MDM_DELEGATION_CLIENT_ID: str = ""
    MDM_SOURCE_NAMESPACE: str = "mdm"
    OIDC_GLOBAL_LOGOUT_ENABLED: bool = False
    CASDOOR_ACCOUNT_STATUS_VISIBLE: bool = False
    IAM_SESSION_SECONDS: int = Field(default=3600, ge=60, le=604800)
    # Renewable sessions remain idle-limited; the browser never receives OAuth tokens.
    IAM_SESSION_ABSOLUTE_SECONDS: int = Field(default=28800, ge=300, le=604800)
    IAM_REFRESH_LEEWAY_SECONDS: int = Field(default=120, ge=0, le=300)
    IAM_COOKIE_SECURE: bool = False  # HTTPS 部署必须设为 true

    # 独立员工门户。留空只兼容本地 / 同域过渡模式；生产 www 必须配置独立 IAM 应用。
    PORTAL_PUBLIC_URL: str = ""
    PORTAL_CLIENT_ID: str = ""
    PORTAL_CLIENT_SECRET: str = ""
    PORTAL_JWKS_URL: str = ""

    @property
    def casdoor_issuer(self) -> str:
        return self.CASDOOR_ENDPOINT.rstrip("/")

    @property
    def casdoor_internal_url(self) -> str:
        return (self.CASDOOR_INTERNAL_URL or self.CASDOOR_ENDPOINT).rstrip("/")

    @property
    def casdoor_jwks_url(self) -> str:
        return self.CASDOOR_JWKS_URL or f"{self.casdoor_internal_url}/.well-known/jwks"

    @property
    def casdoor_token_url(self) -> str:
        return f"{self.casdoor_internal_url}/api/login/oauth/access_token"

    @property
    def pms_origin(self) -> str:
        return self.PMS_PUBLIC_URL.rstrip("/")

    @property
    def iam_callback_url(self) -> str:
        return f"{self.pms_origin}/api/v1/auth/callback"

    @property
    def portal_origin(self) -> str:
        return (self.PORTAL_PUBLIC_URL or self.PMS_PUBLIC_URL).rstrip("/")

    @property
    def portal_client_id(self) -> str:
        return self.PORTAL_CLIENT_ID or self.CASDOOR_CLIENT_ID

    @property
    def portal_client_secret(self) -> str:
        return self.PORTAL_CLIENT_SECRET or self.CASDOOR_CLIENT_SECRET

    @property
    def portal_callback_url(self) -> str:
        if self.PORTAL_PUBLIC_URL:
            return f"{self.portal_origin}/api/v1/portal/callback"
        return self.iam_callback_url


settings = Settings()
