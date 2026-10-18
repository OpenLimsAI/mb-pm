"""登录请求体（嵌入式登录的开始步骤，项目管理与门户共用）。"""

from pydantic import BaseModel, Field


class LoginStart(BaseModel):
    # 登录后回到的站内路径；后端按 safe_return_to 规则校验，不合法时回首页
    return_to: str = Field("/", max_length=2048)
