"""MCP marketplace API endpoints."""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user_id, get_db
from api.mcp.schemas import InstallMcpRequest, McpToolResponse
from api.mcp.service import (
    get_mcp_tool,
    install_mcp_tool,
    list_mcp_tools,
    uninstall_mcp_tool,
)
from core.decorators import handle_errors
from core.response import ApiResponse, ok

router = APIRouter(prefix="/api/mcp", tags=["mcp"])


@router.get("/types", response_model=ApiResponse[list[dict[str, str]]])
@handle_errors
async def mcp_type_options(
    db: AsyncSession = Depends(get_db),
    _: str = Depends(get_current_user_id),
):
    """获取可选的 MCP 服务类型（供「MCP 服务」页面的筛选使用）。

    取值来自「参数配置」页面的 `mcp_type` 分组。这里只要求登录，不要求
    `admin:params`——MCP 页面本身对所有登录用户开放，若沿用参数配置的权限，
    非管理员会拿到空筛选。管理员改配置、普通用户读结果。
    """
    from api.params.service import MCP_TYPE_PARENT_CODE, list_param_options

    return ok(await list_param_options(db, MCP_TYPE_PARENT_CODE))



@router.get("/tools", response_model=ApiResponse[list[McpToolResponse]])
@handle_errors
async def mcp_tool_list(
    category: str | None = Query(None, description="Category filter key"),
    search: str | None = Query(None, description="Search keyword"),
    sort: str | None = Query("popular", description="Sort: popular, rating, recent"),
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[list[McpToolResponse]]:
    """List all MCP tools with optional filters and per-user install state."""
    result = await list_mcp_tools(db, user_id, category, search, sort)
    return ok(result)


@router.get("/tools/{tool_id}", response_model=ApiResponse[McpToolResponse])
@handle_errors
async def mcp_tool_detail(
    tool_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[McpToolResponse]:
    """Get a single MCP tool detail."""
    result = await get_mcp_tool(db, tool_id, user_id)
    return ok(result)


@router.post("/tools/{mcp_id}/install", response_model=ApiResponse[None])
@handle_errors
async def mcp_tool_install(
    mcp_id: str,
    body: InstallMcpRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[None]:
    """Install an MCP tool for the current user."""
    await install_mcp_tool(db, user_id, mcp_id, body.config)
    return ok(message="installed")


@router.delete("/tools/{tool_id}/uninstall", response_model=ApiResponse[None])
@handle_errors
async def mcp_tool_uninstall(
    tool_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[None]:
    """Uninstall an MCP tool for the current user."""
    await uninstall_mcp_tool(db, user_id, tool_id)
    return ok(message="uninstalled")
