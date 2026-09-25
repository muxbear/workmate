"""配置收敛（迭代 5 T5.7）。

四件事各钉一条用例，都是"改错了不报错、只静静失效"的那类：

1. **一个开关只有一个出处**：知识库配置迁入 core 之后，agent 侧不能再留副本——
   留副本的后果是改一处不生效，而改动方以为自己改对了；
2. **接线要真的换过来**：core 里改了值、知识库模块还读旧对象，是同一类失效；
3. **弱口令不能有默认值**：Milvus 出厂口令是公开的，缺配置时要明确失败；
4. **端口不能自己撞自己**：CHROMA_PORT 曾与应用端口同为 8001。
"""

import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2]
SRC_DIR = BACKEND_DIR / "src"

#: 从 agent 配置迁到 core 的知识库配置项（agent 侧不应再有同名属性）
MOVED_FIELDS = (
    "VECTOR_DB_BACKEND",
    "MILVUS_URI",
    "MILVUS_USER",
    "MILVUS_PASSWORD",
    "MILVUS_DEFAULT_DB",
    "CHROMA_HOST",
    "CHROMA_PORT",
    "CHROMA_PERSIST_DIR",
    "DOC_UPLOAD_DIR",
    "INDEXING_MAX_CONCURRENT",
    "KB_MAX_PER_USER",
    "KB_MAX_DOCS_PER_KB",
    "KB_MAX_STORAGE_MB_PER_USER",
    "KB_MAX_FILE_MB",
    # 死配置：没有任何读取方，留着只会让运维以为自己改的开关生效了
    "DEFAULT_EMBEDDING_MODEL",
    "DEFAULT_EMBEDDING_DIM",
    "DOC_STORE_BACKEND",
    "GRAPH_STORE_BACKEND",
    "BM25_DEFAULT_K1",
    "BM25_DEFAULT_B",
)


class TestSingleSourceOfTruth:
    def test_core_owns_the_kb_settings(self):
        from core.config import get_settings

        settings = get_settings()

        assert settings.MILVUS_URI
        assert settings.CHROMA_HOST
        assert settings.KB_MAX_FILE_MB > 0

    def test_agent_settings_has_no_copy(self):
        """agent 配置里不该再有一份同名副本（两个出处 = 迟早改一处不生效）。"""
        from agent.config import settings

        duplicated = [f for f in MOVED_FIELDS if hasattr(settings, f)]

        assert duplicated == [], f"这些项在 agent 配置里又出现了一份副本: {duplicated}"

    def test_kb_modules_read_the_core_settings(self):
        """接线必须真的换过来，否则 core 里的值改了、知识库还在读旧的那套。"""
        from api.knowledge_base import doc_service, quota
        from core.config import get_settings

        assert doc_service.settings is get_settings()
        assert quota.settings is get_settings()


class TestPackageInitDoesNotCloseAnImportCycle:
    """回归：``agent.config → core.config → core.cache → agent.config`` 曾构成环。

    症状很刁：**只在从 agent 侧入口导入时炸**——应用、运维脚本、评测脚本都从那边进来，
    而单测进程里模块早被 conftest 导入过，所以必须开**子进程**跑一次全新的导入顺序，
    在同一个进程里测不出来。
    """

    def _run(self, code: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-c", code],
            cwd=str(BACKEND_DIR), capture_output=True, text=True,
            env={**os.environ, "PYTHONPATH": str(SRC_DIR)},
        )

    def test_importing_agent_config_first_works(self):
        proc = self._run("import agent.config.config; from agent.config import settings")

        assert proc.returncode == 0, proc.stderr

    def test_importing_core_config_first_works(self):
        proc = self._run("import core.config; from core.config import get_settings")

        assert proc.returncode == 0, proc.stderr

    def test_core_config_alone_does_not_pull_agent(self):
        """根因守卫：导入 ``core.config`` 不该顺带把 agent 侧拉进来。

        ``core/__init__`` 一旦在初始化时导入 ``core.cache``（它反向读 agent.config），
        环就闭合了——这条断言直接钉住"包初始化不做重活"。
        """
        proc = self._run(
            "import sys, core.config; "
            "assert 'agent.config' not in sys.modules, "
            "'导入 core.config 把 agent 侧拉进来了，环会从这里闭上'",
        )

        assert proc.returncode == 0, proc.stderr


class TestCorePackageExports:
    def test_lazy_exports_are_available(self):
        from core import KeyValueCache, ok, rate_limit

        assert KeyValueCache.__name__ == "KeyValueCache"
        assert callable(rate_limit)
        assert callable(ok)

    def test_unknown_name_raises_attribute_error(self):
        import core

        with pytest.raises(AttributeError):
            core.this_name_does_not_exist  # noqa: B018 - 就是要取这个不存在的名字


class TestMilvusPasswordIsRequired:
    def test_declared_default_is_empty(self):
        """出厂口令 root/Milvus 不能作为默认值：部署忘了配就连上弱口令实例。"""
        from core.config import Settings

        assert Settings.model_fields["MILVUS_PASSWORD"].default == ""

    def test_missing_password_is_refused_with_guidance(self):
        import re

        from api.knowledge_base.facade import _vector_backend_kwargs

        settings = SimpleNamespace(
            VECTOR_DB_BACKEND="milvus", MILVUS_URI="http://x:19530", MILVUS_USER="root",
            MILVUS_PASSWORD="   ", MILVUS_DEFAULT_DB="ke_hermes",
        )

        with pytest.raises(RuntimeError) as exc:
            _vector_backend_kwargs(settings)

        assert "MILVUS_PASSWORD" in str(exc.value), "报错要说清缺哪个配置"
        assert re.search(r"chroma", str(exc.value), re.I), "要给出替代方案"

    def test_configured_password_is_passed_through(self):
        from api.knowledge_base.facade import _vector_backend_kwargs

        settings = SimpleNamespace(
            VECTOR_DB_BACKEND="milvus", MILVUS_URI="http://x:19530", MILVUS_USER="root",
            MILVUS_PASSWORD="s3cret", MILVUS_DEFAULT_DB="ke_hermes",
        )

        kwargs = _vector_backend_kwargs(settings)

        assert kwargs == {
            "uri": "http://x:19530", "user": "root",
            "password": "s3cret", "db_name": "ke_hermes",
        }

    def test_chroma_backend_needs_no_milvus_password(self):
        """用 Chroma 的部署不该被 Milvus 的口令要求拦住。"""
        from api.knowledge_base.facade import _vector_backend_kwargs

        settings = SimpleNamespace(
            VECTOR_DB_BACKEND="chroma", CHROMA_HOST="localhost",
            CHROMA_PORT=8000, CHROMA_PERSIST_DIR="./c",
        )

        assert _vector_backend_kwargs(settings)["port"] == 8000


class TestPortsDoNotCollide:
    def test_chroma_default_differs_from_app_port(self):
        """CHROMA_PORT 曾与应用端口同为 8001——本地起 Chroma 会把应用端口抢走。"""
        from core.config import Settings

        chroma = Settings.model_fields["CHROMA_PORT"].default
        app = Settings.model_fields["PORT"].default

        assert chroma != app, f"Chroma 默认端口与应用端口撞在一起（都是 {app}）"


class TestDocUploadDir:
    def test_configured_dir_wins(self):
        from core.config import Settings

        settings = Settings(DOC_UPLOAD_DIR="./tmp_docs")

        assert settings.doc_upload_dir == os.path.abspath("./tmp_docs")

    def test_falls_back_under_workspace(self):
        """未配置时落在 {WORKSPACE}/docs_upload——与 agent 的工作目录同源。"""
        from core.config import Settings, get_default_workspace

        settings = Settings(DOC_UPLOAD_DIR="")

        assert settings.doc_upload_dir == os.path.join(
            get_default_workspace(), "docs_upload",
        )
