"""按运行时用户动态切换根目录的文件后端（用于智能体交付目录）。"""

from __future__ import annotations

from pathlib import Path

from deepagents.backends.filesystem import FilesystemBackend
from langgraph.runtime import get_runtime

from core.storage.agent_staging import user_staging_dir


class UserScopedFilesystemBackend(FilesystemBackend):
    """把文件操作限定在当前用户交付目录下的文件后端。

    ``CompositeBackend`` 会把 ``/artifacts/`` 前缀剥离后交给本后端，因此
    ``/报告.md`` 实际读写 ``{root_dir}/{user_id}/报告.md``，实现用户级隔离；
    运行时用户缺失（非请求上下文）时回退到根目录，避免启动阶段报错。
    """

    def __init__(self, root_dir: str, *, max_file_size_mb: int = 100) -> None:
        """初始化并记录基础根目录。

        Args:
            root_dir: 交付目录的宿主根目录（``{WORKSPACE}/artifacts_agent``）。
            max_file_size_mb: 单文件大小上限（MB）。
        """
        self._scoped_cache: dict[str, Path] = {}
        super().__init__(
            root_dir=root_dir, virtual_mode=True, max_file_size_mb=max_file_size_mb
        )

    @property
    def cwd(self) -> Path:
        """返回当前用户的交付目录（按运行时上下文动态解析）。"""
        base: Path = self._base_cwd
        user_id = current_user_id()
        if not user_id:
            return base
        cached = self._scoped_cache.get(user_id)
        if cached is not None:
            return cached
        target = user_staging_dir(user_id)
        self._scoped_cache[user_id] = target
        return target

    @cwd.setter
    def cwd(self, value: Path) -> None:
        """记录基础根目录（由 ``FilesystemBackend`` 初始化时调用）。"""
        self._base_cwd = Path(value)


def current_user_id() -> str:
    """读取当前运行时上下文中的用户 ID（不可用时返回空串）。"""
    try:
        runtime = get_runtime()
    except Exception:
        return ""
    context = getattr(runtime, "context", None) if runtime is not None else None
    return str(getattr(context, "user_id", "") or "")
