"""产物表结构与历史库迁移单元测试（临时 SQLite）。"""

from pathlib import Path

from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session

from db.base import Base
from db.engine import ARTIFACT_COLUMN_MIGRATIONS
from db.models.chat_artifact import ChatArtifact

# 改造前的历史表结构（无持久化字段）
_LEGACY_TABLE_SQL = """
CREATE TABLE chat_artifacts (
    id VARCHAR(36) PRIMARY KEY,
    thread_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    file_path VARCHAR(500) NOT NULL,
    filename VARCHAR(255) NOT NULL,
    file_type VARCHAR(100) NOT NULL DEFAULT '',
    file_size BIGINT NOT NULL DEFAULT 0,
    source_tool VARCHAR(64) NOT NULL DEFAULT '',
    created_at TIMESTAMP
)
"""


def test_chat_artifact_table_has_persistence_columns(tmp_path: Path) -> None:
    """产物表可直接建表并写入 / 读回持久化字段。"""
    engine = create_engine(f"sqlite:///{tmp_path / 'artifact.db'}")
    Base.metadata.create_all(engine, tables=[ChatArtifact.__table__])
    with Session(engine) as session:
        session.add(
            ChatArtifact(
                thread_id="t1",
                user_id="u1",
                file_path="/workspace/a.md",
                filename="a.md",
                file_type="text/markdown",
            )
        )
        session.commit()
        row = session.execute(select(ChatArtifact)).scalar_one()
        assert row.artifact_id
        assert row.status == "pending"
        assert row.storage_key == ""
        assert row.file_size == 0


def test_legacy_table_can_be_migrated(tmp_path: Path) -> None:
    """历史表结构可通过 ALTER 补齐产物持久化字段。"""
    engine = create_engine(f"sqlite:///{tmp_path / 'legacy.db'}")
    with engine.begin() as conn:
        conn.execute(text(_LEGACY_TABLE_SQL))
        conn.execute(
            text(
                "INSERT INTO chat_artifacts (id, thread_id, user_id, file_path, filename)"
                " VALUES ('row-1', 't1', 'u1', '/workspace/a.md', 'a.md')"
            )
        )
        for column, column_type in ARTIFACT_COLUMN_MIGRATIONS.items():
            conn.execute(
                text(f"ALTER TABLE chat_artifacts ADD COLUMN {column} {column_type}")
            )
        conn.execute(
            text("UPDATE chat_artifacts SET artifact_id = 'aid-new', status = 'pending'")
        )
        columns = {
            row[1] for row in conn.execute(text("PRAGMA table_info(chat_artifacts)"))
        }
        assert set(ARTIFACT_COLUMN_MIGRATIONS).issubset(columns)
        migrated = conn.execute(
            text("SELECT artifact_id, status FROM chat_artifacts WHERE id = 'row-1'")
        ).one()
        assert migrated[0] == "aid-new"
        assert migrated[1] == "pending"
