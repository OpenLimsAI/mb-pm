"""数据库会话工厂 + FastAPI 依赖。"""

from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings

_is_sqlite = settings.DATABASE_URL.startswith("sqlite")

if _is_sqlite:
    # SQLite：允许跨线程使用（uvicorn 多线程），无需连接池调参。
    engine = create_engine(
        settings.DATABASE_URL,
        connect_args={"check_same_thread": False},
        pool_pre_ping=True,
        echo=False,
    )
else:
    engine = create_engine(
        settings.DATABASE_URL,
        pool_pre_ping=True,
        pool_size=10,
        max_overflow=20,
        echo=False,
    )

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db() -> Generator[Session, None, None]:
    """FastAPI 依赖：每请求一个事务，自动提交/回滚。"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
