import instance from './request'
import type {
  PermResource,
  RoleDef,
  RolePermissionsResponse,
  MyPermissionsResponse,
  UserRolesResponse,
} from '@/types/admin'

// ── Permission Resources ─────────────────────────────────────────

export async function fetchResources(): Promise<PermResource[]> {
  const res = await instance.get('/rbac/resources')
  return res.data.data
}

export async function createResource(data: Partial<PermResource>): Promise<PermResource> {
  const res = await instance.post('/rbac/resources', {
    parentId: data.parentId,
    type: data.type,
    label: data.label,
    permKey: data.permKey,
    path: data.path,
    icon: data.icon,
    sortOrder: data.sortOrder,
    status: data.status,
    description: data.description,
    btnVariant: data.btnVariant,
    danger: data.danger,
  })
  return res.data.data
}

export async function updateResource(data: PermResource): Promise<PermResource> {
  const res = await instance.put(`/rbac/resources/${data.id}`, {
    parentId: data.parentId,
    type: data.type,
    label: data.label,
    permKey: data.permKey,
    path: data.path,
    icon: data.icon,
    sortOrder: data.sortOrder,
    status: data.status,
    description: data.description,
    btnVariant: data.btnVariant,
    danger: data.danger,
  })
  return res.data.data
}

export async function deleteResource(id: string): Promise<{ deleted: number }> {
  const res = await instance.delete(`/rbac/resources/${id}`)
  return res.data.data
}

// ── Roles ────────────────────────────────────────────────────────

export async function fetchRoles(): Promise<RoleDef[]> {
  const res = await instance.get('/rbac/roles')
  return res.data.data
}

export async function createRole(data: {
  key: string
  name: string
  description?: string
  parentRoleId?: string
  sortOrder?: number
  copyPermissionsFrom?: string
}): Promise<RoleDef> {
  const res = await instance.post('/rbac/roles', {
    key: data.key,
    name: data.name,
    description: data.description,
    parentRoleId: data.parentRoleId,
    sortOrder: data.sortOrder,
    copyPermissionsFrom: data.copyPermissionsFrom,
  })
  return res.data.data
}

export async function updateRole(
  id: string,
  data: { name?: string; description?: string; isActive?: boolean; parentRoleId?: string; sortOrder?: number },
): Promise<RoleDef> {
  const res = await instance.put(`/rbac/roles/${id}`, {
    name: data.name,
    description: data.description,
    isActive: data.isActive,
    parentRoleId: data.parentRoleId,
    sortOrder: data.sortOrder,
  })
  return res.data.data
}

export async function deleteRole(id: string): Promise<{ deleted: string }> {
  const res = await instance.delete(`/rbac/roles/${id}`)
  return res.data.data
}

// ── Role-Permission Assignment ───────────────────────────────────

export async function fetchRolePermissions(roleId: string): Promise<RolePermissionsResponse> {
  const res = await instance.get(`/rbac/roles/${roleId}/permissions`)
  return res.data.data
}

export async function saveRolePermissions(
  roleId: string,
  granted: string[],
  dataScopes: { resourceKey: string; scope: string }[],
): Promise<RolePermissionsResponse> {
  const res = await instance.put(`/rbac/roles/${roleId}/permissions`, {
    granted,
    dataScopes,
  })
  return res.data.data
}

// ── User-Role Assignment ─────────────────────────────────────────

export async function fetchUserRoles(userId: string): Promise<UserRolesResponse> {
  const res = await instance.get(`/rbac/users/${userId}/roles`)
  return res.data.data
}

export async function setUserRoles(userId: string, roleIds: string[]): Promise<UserRolesResponse> {
  const res = await instance.put(`/rbac/users/${userId}/roles`, { roleIds })
  return res.data.data
}

// ── Current User Permissions ─────────────────────────────────────

export async function fetchMyPermissions(): Promise<MyPermissionsResponse> {
  const res = await instance.get('/rbac/my-permissions')
  return res.data.data
}
