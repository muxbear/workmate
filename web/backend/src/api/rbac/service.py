"""RBAC business logic layer."""

import logging

from fastapi import HTTPException
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from api.rbac.schemas import (
    DataScopeItem,
    MyMenuNode,
    MyPermissionsResponse,
    PermResourceResponse,
    ResourceCreateRequest,
    ResourceUpdateRequest,
    RoleCreateRequest,
    RolePermissionsResponse,
    RoleResponse,
    RoleUpdateRequest,
    UserRolesResponse,
    UserRolesUpdateRequest,
)
from db.models.data_scope import DataScope
from db.models.permission_resource import PermissionResource
from db.models.role import Role
from db.models.role_permission import RolePermission
from db.models.user_role import UserRole

logger = logging.getLogger(__name__)


class RbacService:
    """RBAC business logic orchestrator."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    # ── Permission Resource CRUD ──────────────────────────────────

    async def list_resources(self) -> list[PermResourceResponse]:
        result = await self.db.execute(
            select(PermissionResource).order_by(PermissionResource.sort_order)
        )
        resources = result.scalars().all()
        return [self._to_resource_response(r) for r in resources]

    async def create_resource(self, req: ResourceCreateRequest) -> PermResourceResponse:
        existing = await self.db.execute(
            select(PermissionResource).where(PermissionResource.perm_key == req.perm_key)
        )
        if existing.scalar_one_or_none():
            raise HTTPException(status_code=409, detail=f"权限标识 '{req.perm_key}' 已存在")

        if req.parent_id:
            parent = await self._get_resource(req.parent_id)
            if not parent:
                raise HTTPException(status_code=404, detail="父资源不存在")

        resource = PermissionResource(
            parent_id=req.parent_id,
            type=req.type,
            label=req.label,
            perm_key=req.perm_key,
            path=req.path,
            icon=req.icon,
            sort_order=req.sort_order,
            status=req.status,
            is_builtin=False,
            description=req.description,
            btn_variant=req.btn_variant,
            danger=req.danger,
        )
        self.db.add(resource)
        await self.db.flush()
        await self.db.refresh(resource)
        return self._to_resource_response(resource)

    async def update_resource(self, resource_id: str, req: ResourceUpdateRequest) -> PermResourceResponse:
        resource = await self._get_resource(resource_id)
        if not resource:
            raise HTTPException(status_code=404, detail="资源不存在")

        updates: dict[str, object] = {}
        for field in (
            "parent_id", "type", "label", "perm_key", "path", "icon",
            "sort_order", "status", "description", "btn_variant", "danger",
        ):
            val = getattr(req, field, None)
            if val is not None:
                updates[field] = val

        if not updates:
            raise HTTPException(status_code=400, detail="没有要更新的字段")

        if "perm_key" in updates:
            existing = await self.db.execute(
                select(PermissionResource).where(
                    PermissionResource.perm_key == updates["perm_key"],
                    PermissionResource.id != resource_id,
                )
            )
            if existing.scalar_one_or_none():
                raise HTTPException(status_code=409, detail=f"权限标识 '{updates['perm_key']}' 已存在")

        await self.db.execute(
            update(PermissionResource).where(PermissionResource.id == resource_id).values(**updates)
        )
        await self.db.flush()
        await self.db.refresh(resource)
        return self._to_resource_response(resource)

    async def delete_resource(self, resource_id: str) -> dict[str, object]:
        resource = await self._get_resource(resource_id)
        if not resource:
            raise HTTPException(status_code=404, detail="资源不存在")
        if resource.is_builtin:
            raise HTTPException(status_code=403, detail="内置资源不可删除")

        # Cascade delete children
        ids_to_delete = {resource_id}
        changed = True
        while changed:
            changed = False
            result = await self.db.execute(select(PermissionResource.id))
            for (rid,) in result.all():
                if rid in ids_to_delete:
                    continue
                r = await self._get_resource(rid)
                if r and r.parent_id in ids_to_delete:
                    ids_to_delete.add(rid)
                    changed = True

        # Delete role_permissions referencing deleted perm_keys
        result = await self.db.execute(
            select(PermissionResource.perm_key).where(PermissionResource.id.in_(ids_to_delete))
        )
        deleted_keys = [row[0] for row in result.all()]
        if deleted_keys:
            await self.db.execute(
                delete(RolePermission).where(RolePermission.perm_key.in_(deleted_keys))
            )

        await self.db.execute(
            delete(PermissionResource).where(PermissionResource.id.in_(ids_to_delete))
        )
        await self.db.flush()
        return {"deleted": len(ids_to_delete)}

    # ── Role CRUD ─────────────────────────────────────────────────

    async def list_roles(self) -> list[RoleResponse]:
        result = await self.db.execute(select(Role).order_by(Role.sort_order))
        roles = result.scalars().all()
        user_counts = await self._compute_user_counts()
        return [self._to_role_response(r, user_counts) for r in roles]

    async def create_role(self, req: RoleCreateRequest) -> RoleResponse:
        existing = await self.db.execute(select(Role).where(Role.key == req.key))
        if existing.scalar_one_or_none():
            raise HTTPException(status_code=409, detail=f"角色标识 '{req.key}' 已存在")

        role = Role(
            key=req.key,
            name=req.name,
            description=req.description,
            is_builtin=False,
            parent_role_id=req.parent_role_id,
            sort_order=req.sort_order,
        )
        self.db.add(role)
        await self.db.flush()

        # Copy permissions from source role if requested
        if req.copy_permissions_from:
            await self._copy_permissions(req.copy_permissions_from, role.id)

        await self.db.refresh(role)
        return self._to_role_response(role, {})

    async def update_role(self, role_id: str, req: RoleUpdateRequest) -> RoleResponse:
        role = await self._get_role(role_id)
        if not role:
            raise HTTPException(status_code=404, detail="角色不存在")

        updates: dict[str, object] = {}
        for field in ("name", "description", "is_active", "parent_role_id", "sort_order"):
            val = getattr(req, field, None)
            if val is not None:
                updates[field] = val

        if updates:
            await self.db.execute(update(Role).where(Role.id == role_id).values(**updates))
            await self.db.flush()
            await self.db.refresh(role)

        user_counts = await self._compute_user_counts()
        return self._to_role_response(role, user_counts)

    async def delete_role(self, role_id: str) -> dict[str, object]:
        role = await self._get_role(role_id)
        if not role:
            raise HTTPException(status_code=404, detail="角色不存在")
        if role.is_builtin:
            raise HTTPException(status_code=403, detail="内置角色不可删除")

        await self.db.execute(delete(UserRole).where(UserRole.role_id == role_id))
        await self.db.execute(delete(RolePermission).where(RolePermission.role_id == role_id))
        await self.db.execute(delete(DataScope).where(DataScope.role_id == role_id))
        await self.db.execute(delete(Role).where(Role.id == role_id))
        await self.db.flush()
        return {"deleted": role_id}

    # ── Role-Permission Assignment ────────────────────────────────

    async def get_role_permissions(self, role_id: str) -> RolePermissionsResponse:
        role = await self._get_role(role_id)
        if not role:
            raise HTTPException(status_code=404, detail="角色不存在")

        result = await self.db.execute(
            select(RolePermission.perm_key).where(RolePermission.role_id == role_id)
        )
        granted = [row[0] for row in result.all()]

        scope_result = await self.db.execute(
            select(DataScope).where(DataScope.role_id == role_id)
        )
        data_scopes = [
            DataScopeItem(resourceKey=s.resource_key, scope=s.scope)
            for s in scope_result.scalars().all()
        ]

        return RolePermissionsResponse(role_id=role_id, granted=granted, data_scopes=data_scopes)

    async def save_role_permissions(
        self, role_id: str, req
    ) -> RolePermissionsResponse:

        role = await self._get_role(role_id)
        if not role:
            raise HTTPException(status_code=404, detail="角色不存在")
        if role.is_builtin and role.key == "super_admin":
            raise HTTPException(status_code=403, detail="超级管理员权限不可修改")

        # Replace permissions
        await self.db.execute(
            delete(RolePermission).where(RolePermission.role_id == role_id)
        )
        for perm_key in req.granted:
            self.db.add(RolePermission(role_id=role_id, perm_key=perm_key))

        # Replace data scopes
        await self.db.execute(delete(DataScope).where(DataScope.role_id == role_id))
        for ds in req.data_scopes:
            self.db.add(DataScope(
                role_id=role_id,
                resource_key=ds.resource_key,
                scope=ds.scope,
                custom_dept_ids="[]",
            ))

        await self.db.flush()
        return await self.get_role_permissions(role_id)

    # ── User-Role Assignment ──────────────────────────────────────

    async def get_user_roles(self, user_id: str) -> UserRolesResponse:
        result = await self.db.execute(
            select(Role).join(UserRole, UserRole.role_id == Role.id).where(UserRole.user_id == user_id)
        )
        roles = result.scalars().all()
        user_counts = await self._compute_user_counts()
        return UserRolesResponse(
            user_id=user_id,
            roles=[self._to_role_response(r, user_counts) for r in roles],
        )

    async def set_user_roles(self, user_id: str, req: UserRolesUpdateRequest) -> UserRolesResponse:
        await self.db.execute(delete(UserRole).where(UserRole.user_id == user_id))
        for role_id in req.role_ids:
            role = await self._get_role(role_id)
            if not role:
                raise HTTPException(status_code=404, detail=f"角色 {role_id} 不存在")
            self.db.add(UserRole(user_id=user_id, role_id=role_id))
        await self.db.flush()
        return await self.get_user_roles(user_id)

    # ── Current-user Permissions ──────────────────────────────────

    async def get_my_permissions(self, user_id: str) -> MyPermissionsResponse:
        roles = await self._get_user_roles_with_data(user_id)
        role_keys = [r.key for r in roles]

        is_super = any(r.key == "super_admin" for r in roles)

        # Collect granted permKeys
        if is_super:
            # Super admin gets all active permKeys
            result = await self.db.execute(
                select(PermissionResource.perm_key).where(
                    PermissionResource.status == "active"
                )
            )
            perm_keys = [row[0] for row in result.all()]
        else:
            role_ids = [r.id for r in roles]
            result = await self.db.execute(
                select(RolePermission.perm_key).where(
                    RolePermission.role_id.in_(role_ids)
                )
            )
            perm_keys = list({row[0] for row in result.all()})

        # Collect menus (catalog + menu types, active, user has permission)
        result = await self.db.execute(
            select(PermissionResource).where(
                PermissionResource.type.in_(["catalog", "menu"]),
                PermissionResource.status == "active",
            ).order_by(PermissionResource.sort_order)
        )
        all_menus = result.scalars().all()

        menus: list[MyMenuNode] = []
        for m in all_menus:
            # For super admin, include all menus.
            # For others, include catalog if any child menu is accessible,
            # include menu if its permKey is granted.
            if is_super:
                menus.append(self._to_menu_node(m))
            elif m.type == "catalog":
                # Include catalog if any child menu's permKey is in the granted set
                child_result = await self.db.execute(
                    select(PermissionResource.id).where(
                        PermissionResource.parent_id == m.id,
                        PermissionResource.type == "menu",
                        PermissionResource.perm_key.in_(perm_keys),
                    )
                )
                if child_result.first():
                    menus.append(self._to_menu_node(m))
            elif m.type == "menu" and m.perm_key in perm_keys:
                menus.append(self._to_menu_node(m))

        # Collect data scopes
        if is_super:
            # Super admin gets 'all' for all resource keys
            result = await self.db.execute(
                select(DataScope.resource_key).distinct()
            )
            resource_keys = [row[0] for row in result.all()]
            data_scopes = [DataScopeItem(resourceKey=rk, scope="all") for rk in resource_keys]
        else:
            role_ids = [r.id for r in roles]
            result = await self.db.execute(
                select(DataScope).where(DataScope.role_id.in_(role_ids))
            )
            scopes = result.scalars().all()
            # Deduplicate by resource_key: prefer broader scope
            scope_map: dict[str, str] = {}
            scope_order = {"all": 0, "dept_and_children": 1, "dept": 2, "self": 3, "custom": 4, "none": 5}
            for s in scopes:
                if s.resource_key not in scope_map or scope_order.get(s.scope, 99) < scope_order.get(scope_map[s.resource_key], 99):
                    scope_map[s.resource_key] = s.scope
            data_scopes = [DataScopeItem(resourceKey=k, scope=v) for k, v in scope_map.items()]

        return MyPermissionsResponse(
            user_id=user_id,
            roles=role_keys,
            perm_keys=perm_keys,
            menus=menus,
            data_scopes=data_scopes,
        )

    # ── Seed data ─────────────────────────────────────────────────

    async def seed_builtin_data(self) -> None:
        """Seed built-in roles and permission resources on first run."""
        existing = await self.db.execute(select(Role).where(Role.is_builtin))
        if existing.first():
            return  # Already seeded

        logger.info("Seeding built-in RBAC data...")

        # Built-in roles
        roles_data = [
            {"key": "super_admin", "name": "超级管理员", "description": "拥有所有权限，不可删除", "sort_order": 1},
            {"key": "admin", "name": "管理员", "description": "系统管理员，拥有大部分管理权限", "sort_order": 2},
            {"key": "manager", "name": "部门主管", "description": "管理部门成员和数据", "sort_order": 3},
            {"key": "member", "name": "普通成员", "description": "基础功能访问权限", "sort_order": 4},
            {"key": "guest", "name": "访客", "description": "只读访客权限", "sort_order": 5},
        ]
        role_map: dict[str, str] = {}  # key -> id
        for rd in roles_data:
            role = Role(key=rd["key"], name=rd["name"], description=rd["description"],
                        is_builtin=True, sort_order=rd["sort_order"])
            self.db.add(role)
            await self.db.flush()
            role_map[rd["key"]] = role.id

        # Permission resources
        resources_data: list[dict[str, object]] = [
            # Chat
            {"id": "g-chat", "parent": None, "type": "catalog",
             "label": "聊天", "perm_key": "chat", "icon": "MessageSquare", "sort": 1},
            {"id": "m-chat", "parent": "g-chat", "type": "menu",
             "label": "对话", "perm_key": "chat:conversation", "path": "/chat", "icon": "MessageSquare", "sort": 1},
            {"id": "b-chat-send", "parent": "m-chat", "type": "button",
             "label": "发送消息", "perm_key": "chat:send", "icon": "Send", "sort": 1},
            {"id": "b-chat-create", "parent": "m-chat", "type": "button",
             "label": "创建对话", "perm_key": "chat:create", "icon": "Plus", "sort": 2},
            {"id": "b-chat-delete", "parent": "m-chat", "type": "button",
             "label": "删除对话", "perm_key": "chat:delete", "icon": "Trash2", "sort": 3, "danger": True},

            {"id": "g-kb", "parent": None, "type": "catalog",
             "label": "知识库", "perm_key": "knowledge", "icon": "Database", "sort": 2},
            {"id": "m-kb", "parent": "g-kb", "type": "menu",
             "label": "知识库", "perm_key": "knowledge:base", "path": "/knowledge-base",
             "icon": "Database", "sort": 1},
            {"id": "b-kb-create", "parent": "m-kb", "type": "button",
             "label": "创建知识库", "perm_key": "knowledge:create", "icon": "Plus", "sort": 1},
            {"id": "b-kb-upload", "parent": "m-kb", "type": "button",
             "label": "上传文档", "perm_key": "knowledge:upload", "icon": "Upload", "sort": 2},
            {"id": "b-kb-delete", "parent": "m-kb", "type": "button",
             "label": "删除知识库", "perm_key": "knowledge:delete", "icon": "Trash2",
             "sort": 3, "danger": True},

            # Control
            {"id": "g-ctrl", "parent": None, "type": "catalog",
             "label": "控制", "perm_key": "control", "icon": "LayoutGrid", "sort": 3},
            {"id": "m-ctrl-overview", "parent": "g-ctrl", "type": "menu",
             "label": "概览", "perm_key": "control:overview", "path": "/overview",
             "icon": "LayoutDashboard", "sort": 1},
            {"id": "m-ctrl-scheduled", "parent": "g-ctrl", "type": "menu",
             "label": "定时任务", "perm_key": "control:scheduled",
             "path": "/scheduled-tasks", "icon": "Timer", "sort": 2},
            {"id": "b-ctrl-task-create", "parent": "m-ctrl-scheduled", "type": "button",
             "label": "创建任务", "perm_key": "control:task:create", "icon": "Plus", "sort": 1},
            {"id": "b-ctrl-task-run", "parent": "m-ctrl-scheduled", "type": "button",
             "label": "立即执行", "perm_key": "control:task:run", "icon": "Play", "sort": 2},

            # Agent
            {"id": "g-agent", "parent": None, "type": "catalog",
             "label": "智能体", "perm_key": "agent", "icon": "Bot", "sort": 4},
            {"id": "m-agent-manage", "parent": "g-agent", "type": "menu",
             "label": "智能体管理", "perm_key": "agent:manage", "path": "/agents",
             "icon": "Bot", "sort": 1},
            {"id": "m-agent-models", "parent": "g-agent", "type": "menu",
             "label": "模型", "perm_key": "agent:models", "path": "/models",
             "icon": "Brain", "sort": 2},
            {"id": "m-agent-tools", "parent": "g-agent", "type": "menu",
             "label": "工具", "perm_key": "agent:tools", "path": "/tools",
             "icon": "Wrench", "sort": 3},
            {"id": "m-agent-skills", "parent": "g-agent", "type": "menu",
             "label": "技能", "perm_key": "agent:skills", "path": "/skills",
             "icon": "Zap", "sort": 4},

            # MCP
            {"id": "g-mcp", "parent": None, "type": "catalog",
             "label": "MCP", "perm_key": "mcp", "icon": "CloudMoon", "sort": 5},
            {"id": "m-mcp-square", "parent": "g-mcp", "type": "menu",
             "label": "MCP 广场", "perm_key": "mcp:square", "path": "/mcp",
             "icon": "CloudMoon", "sort": 1},

            # Admin
            {"id": "g-admin", "parent": None, "type": "catalog",
             "label": "管理", "perm_key": "admin", "icon": "Shield", "sort": 6},
            {"id": "m-admin-dashboard", "parent": "g-admin", "type": "menu",
             "label": "后台管理", "perm_key": "admin:dashboard", "path": "/admin",
             "icon": "Shield", "sort": 1},
            {"id": "m-admin-users", "parent": "g-admin", "type": "menu",
             "label": "人员管理", "perm_key": "admin:users", "path": "/admin/users",
             "icon": "Users", "sort": 2},
            {"id": "b-admin-user-create", "parent": "m-admin-users", "type": "button",
             "label": "创建用户", "perm_key": "admin:user:create", "icon": "UserPlus", "sort": 1},
            {"id": "b-admin-user-edit", "parent": "m-admin-users", "type": "button",
             "label": "编辑用户", "perm_key": "admin:user:edit", "icon": "Edit2", "sort": 2},
            {"id": "b-admin-user-delete", "parent": "m-admin-users", "type": "button",
             "label": "删除用户", "perm_key": "admin:user:delete", "icon": "Trash2",
             "sort": 3, "danger": True},
            {"id": "m-admin-rbac", "parent": "g-admin", "type": "menu",
             "label": "角色权限", "perm_key": "admin:rbac", "path": "/admin/rbac",
             "icon": "ShieldCheck", "sort": 3},
            {"id": "b-admin-role-create", "parent": "m-admin-rbac", "type": "button",
             "label": "创建角色", "perm_key": "admin:role:create", "icon": "Plus", "sort": 1},
            {"id": "b-admin-role-save", "parent": "m-admin-rbac", "type": "button",
             "label": "保存配置", "perm_key": "admin:role:save", "icon": "Save", "sort": 2},
            {"id": "m-admin-resources", "parent": "g-admin", "type": "menu",
             "label": "资源管理", "perm_key": "admin:resources", "path": "/admin/resources",
             "icon": "FolderTree", "sort": 4},
            {"id": "m-admin-org", "parent": "g-admin", "type": "menu",
             "label": "机构部门", "perm_key": "admin:org", "path": "/admin/org",
             "icon": "Building2", "sort": 5},
            {"id": "b-admin-org-create", "parent": "m-admin-org", "type": "button",
             "label": "创建部门", "perm_key": "admin:org:create", "icon": "Plus", "sort": 1},
            {"id": "b-admin-org-edit", "parent": "m-admin-org", "type": "button",
             "label": "编辑部门", "perm_key": "admin:org:edit", "icon": "Edit2", "sort": 2},
            {"id": "b-admin-org-delete", "parent": "m-admin-org", "type": "button",
             "label": "删除部门", "perm_key": "admin:org:delete", "icon": "Trash2",
             "sort": 3, "danger": True},
            {"id": "m-admin-accounts", "parent": "g-admin", "type": "menu",
             "label": "账号管理", "perm_key": "admin:accounts", "path": "/admin/accounts",
             "icon": "KeyRound", "sort": 6},
        ]

        for rd in resources_data:
            resource = PermissionResource(
                id=rd["id"],
                parent_id=rd.get("parent"),
                type=str(rd["type"]),
                label=str(rd["label"]),
                perm_key=str(rd["perm_key"]),
                path=rd.get("path"),
                icon=str(rd.get("icon", "Folder")),
                sort_order=int(str(rd.get("sort", 0))),
                status="active",
                is_builtin=True,
                btn_variant=str(rd["btn_variant"]) if "btn_variant" in rd else None,
                danger=bool(rd.get("danger", False)),
            )
            self.db.add(resource)

        await self.db.flush()

        # Collect all permKeys
        all_perm_keys = [str(rd["perm_key"]) for rd in resources_data]

        # Default permission sets per role
        perm_sets: dict[str, list[str]] = {
            "super_admin": list(all_perm_keys),
            "admin": list(all_perm_keys),
            "manager": [
                "chat:conversation", "chat:send", "chat:create",
                "knowledge:base", "knowledge:create",
                "control:overview", "control:scheduled",
                "agent:manage", "agent:tools", "agent:skills",
                "mcp:square",
                "admin:dashboard", "admin:users", "admin:user:create", "admin:user:edit",
            ],
            "member": [
                "chat:conversation", "chat:send", "chat:create",
                "knowledge:base", "knowledge:create",
                "control:overview",
                "agent:manage", "agent:tools",
                "mcp:square",
                "admin:dashboard",
            ],
            "guest": [
                "chat:conversation", "chat:send",
                "control:overview",
                "mcp:square",
            ],
        }

        for role_key, perm_keys in perm_sets.items():
            role_id = role_map.get(role_key)
            if role_id:
                for pk in perm_keys:
                    self.db.add(RolePermission(role_id=role_id, perm_key=pk))

        # Default data scopes
        data_resources = [
            "conversation", "knowledge", "agent", "mcp",
            "scheduled", "user", "audit-log",
        ]
        scope_defaults = {
            "super_admin": "all",
            "admin": "all",
            "manager": "dept_and_children",
            "member": "self",
            "guest": "none",
        }
        for role_key, scope in scope_defaults.items():
            role_id = role_map.get(role_key)
            if role_id:
                for dr in data_resources:
                    self.db.add(DataScope(role_id=role_id, resource_key=dr, scope=scope))

        await self.db.flush()
        logger.info("Built-in RBAC data seeded successfully.")

    # ── Helpers ───────────────────────────────────────────────────

    async def _get_resource(self, resource_id: str) -> PermissionResource | None:
        result = await self.db.execute(
            select(PermissionResource).where(PermissionResource.id == resource_id)
        )
        return result.scalar_one_or_none()

    async def _get_role(self, role_id: str) -> Role | None:
        result = await self.db.execute(select(Role).where(Role.id == role_id))
        return result.scalar_one_or_none()

    async def _get_role_by_key(self, key: str) -> Role | None:
        result = await self.db.execute(select(Role).where(Role.key == key))
        return result.scalar_one_or_none()

    async def _compute_user_counts(self) -> dict[str, int]:
        result = await self.db.execute(select(UserRole))
        counts: dict[str, int] = {}
        for ur in result.scalars().all():
            counts[ur.role_id] = counts.get(ur.role_id, 0) + 1
        return counts

    async def _get_user_roles_with_data(self, user_id: str) -> list[Role]:
        result = await self.db.execute(
            select(Role)
            .join(UserRole, UserRole.role_id == Role.id)
            .where(UserRole.user_id == user_id, Role.is_active)
        )
        return list(result.scalars().all())

    async def _copy_permissions(self, source_role_key: str, target_role_id: str) -> None:
        source_role = await self._get_role_by_key(source_role_key)
        if not source_role:
            return

        result = await self.db.execute(
            select(RolePermission).where(RolePermission.role_id == source_role.id)
        )
        for rp in result.scalars().all():
            self.db.add(RolePermission(role_id=target_role_id, perm_key=rp.perm_key))

        scope_result = await self.db.execute(
            select(DataScope).where(DataScope.role_id == source_role.id)
        )
        for ds in scope_result.scalars().all():
            self.db.add(DataScope(
                role_id=target_role_id,
                resource_key=ds.resource_key,
                scope=ds.scope,
                custom_dept_ids=ds.custom_dept_ids,
            ))

    @staticmethod
    def _to_resource_response(r: PermissionResource) -> PermResourceResponse:
        return PermResourceResponse(
            id=r.id,
            parent_id=r.parent_id,
            type=r.type,
            label=r.label,
            perm_key=r.perm_key,
            path=r.path,
            icon=r.icon,
            sort_order=r.sort_order,
            status=r.status,
            is_builtin=r.is_builtin,
            description=r.description or "",
            btn_variant=r.btn_variant,
            danger=r.danger,
        )

    @staticmethod
    def _to_role_response(r: Role, user_counts: dict[str, int]) -> RoleResponse:
        return RoleResponse(
            id=r.id,
            key=r.key,
            name=r.name,
            description=r.description or "",
            is_builtin=r.is_builtin,
            is_active=r.is_active,
            parent_role_id=r.parent_role_id,
            sort_order=r.sort_order,
            user_count=user_counts.get(r.id, 0),
            created_at=r.created_at,
        )

    @staticmethod
    def _to_menu_node(r: PermissionResource) -> MyMenuNode:
        return MyMenuNode(
            id=r.id,
            parent_id=r.parent_id,
            type=r.type,
            label=r.label,
            path=r.path,
            icon=r.icon,
            sort_order=r.sort_order,
        )
