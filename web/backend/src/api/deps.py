from collections.abc import AsyncGenerator

from fastapi import HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from core.cache import KeyValueCache
from core.security import decode_token
from db.engine import get_db as _get_db

_cache: KeyValueCache | None = None


def set_cache(cache: KeyValueCache) -> None:
    global _cache
    _cache = cache


async def get_cache() -> KeyValueCache:
    assert _cache is not None, "Cache 未被初始化"
    return _cache


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async for session in _get_db():
        yield session


def get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "127.0.0.1"


def get_vector_store(request: Request):
    """取应用启动时挂到 ``app.state`` 上的向量库实例。

    启动未完成或因故没挂上时返回 ``None``——调用方据此给出可读错误，而不是让
    ``AttributeError`` 冒到 500。此处不写返回类型：向量库是 ``BaseVectorStore``
    的子类，但本模块不该为了一个标注去依赖 ``core.rag``。
    """
    return getattr(request.app.state, "vector_store", None)

async def get_current_user_id(request: Request) -> str:
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = auth.split(" ", 1)[1] # auth.split(" ", 1), 对 auth 使用 " " 进行分割, 1 表示分割 1 次
    # 1.验证签名 2.检查过期时间 3.检查类型: "access" 可能用于验证 Token 的用途（例如区分 access token 和 refresh token）。
    # payload: 如果验证通过，返回 Token 中携带的数据载荷（通常是一个字典），包含用户ID、过期时间等信息。如果验证失败，该函数内部通常会直接抛出异常（如 401 或 403）
    payload = decode_token(token, "access")
    return str(payload["sub"])


async def get_current_token_payload(request: Request) -> dict:
    """解析当前请求的 access token，返回完整 payload."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = auth.split(" ", 1)[1]
    return decode_token(token, "access")


def scope_missing(payload: dict, required: str) -> bool:
    """已解码的 token payload 是否缺少 required scope.

    - OAuth2 客户端 token（含 ``client_id`` claim）：必须携带 scope 且包含 required。
    - Web 第一方 token（无 ``client_id`` claim）：恒不缺——按自身登录态放行
      （Web 登录不受 OAuth2 scope 约束）。

    这是全平台唯一的 scope 判定原语：REST 的 ``require_scope`` 与 MCP 服务
    （``mcp_servers/request_auth``）都据此收敛，避免"网页里拒了、MCP 里却放行"。
    """
    if "client_id" not in payload:
        return False
    return required not in set(str(payload.get("scope", "")).split())


def ensure_scopes(payload: dict, required: str) -> None:
    """校验已解码的 token payload 是否满足 scope 要求；不满足抛 403.

    单独成函数，是为了让拿不到依赖注入的接口复用同一份口径——例如 SSE 路由
    （EventSource 不能自定义请求头，token 只能走查询参数、自行 ``decode_token``）。
    """
    if scope_missing(payload, required):
        raise HTTPException(status_code=403, detail=f"Insufficient scope: {required}")


def require_scope(required: str):
    """资源接口 scope 校验依赖工厂，返回通过校验的 user_id."""

    async def _dependency(request: Request) -> str:
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Not authenticated")
        token = auth.split(" ", 1)[1]
        payload = decode_token(token, "access")
        ensure_scopes(payload, required)
        return str(payload["sub"])

    # 与 RequirePermission 的 ``__permission_key__`` 同一用途：路由是用装饰器声明依赖的，
    # 运行期无法反查"这个接口要求什么 scope"，结构断言只能靠标记遍历路由表。
    _dependency.__scope_key__ = required  # type: ignore[attr-defined]
    return _dependency


def require_scope_from_query(required: str, param: str = "token"):
    """同 ``require_scope``，但 token 取自查询参数——给 SSE 这类拿不到请求头的接口用.

    浏览器的 ``EventSource`` 无法自定义请求头，token 只能挂在 URL 上（与通知流一致）。
    判定复用同一份 ``ensure_scopes``，因此两条路的放行口径不会分叉；
    同时它也是"可被结构断言看见"的依赖——手写 ``decode_token`` 的接口
    在路由表上不带任何标记，漏挂与否只能靠人肉检查。
    """

    async def _dependency(request: Request) -> str:
        token = request.query_params.get(param, "")
        if not token:
            raise HTTPException(status_code=401, detail="Not authenticated")
        try:
            payload = decode_token(token, "access")
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001 - 无效 token 一律按未认证处理
            raise HTTPException(status_code=401, detail="Invalid token") from exc
        ensure_scopes(payload, required)
        return str(payload["sub"])

    _dependency.__scope_key__ = required  # type: ignore[attr-defined]
    return _dependency
