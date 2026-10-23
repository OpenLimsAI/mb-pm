"""导出所有 ORM 模型，方便其他模块统一引用。

CTO Lite 版仅保留组合管理所需的核心实体：用户 / 项目 / 子项目 / 任务 /
任务依赖 / 模板 / 审计日志，以及 IAM 身份绑定与会话、项目 / 财务 AI 分析记录。生产、设备、预警等模块在 Lite 版中不启用。
"""

from app.models.ai import FinanceAIAnalysis, ProjectAIAnalysis  # noqa: F401
from app.models.audit_log import AuditLog  # noqa: F401
from app.models.baseline import ProjectBaseline  # noqa: F401
from app.models.finance import ProjectFinance  # noqa: F401
from app.models.iam import (  # noqa: F401
    IAMIdentity,
    IAMLogin,
    IAMSession,
    PasswordChangeRequired,
)
from app.models.portal import PortalLogin, PortalSession  # noqa: F401
from app.models.project import Project, ProjectMember  # noqa: F401
from app.models.solution import (  # noqa: F401
    KnowledgeSolution,
    SolutionActor,
    SolutionAnswer,
    SolutionEvent,
    SolutionSource,
    SolutionVersion,
)
from app.models.task import SubProject, Task, TaskDependency  # noqa: F401
from app.models.template import Template, TemplateVersion  # noqa: F401
from app.models.user import User  # noqa: F401
