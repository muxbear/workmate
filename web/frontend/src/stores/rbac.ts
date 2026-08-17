import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import type { RoleDef, PermResource, DataResource, DataScope } from '@/types/admin'
import {
  fetchRoles,
  fetchRolePermissions,
  saveRolePermissions,
  createRole,
  deleteRole,
} from '@/services/rbacApi'

// Frontend-only role presentation defaults
const ROLE_COLORS: Record<string, { color: string; badgeColor: string }> = {
  super_admin: { color: 'from-red-500/20 to-red-500/5', badgeColor: 'bg-red-500/15 text-red-300 border-red-500/30' },
  admin: { color: 'from-amber-500/20 to-amber-500/5', badgeColor: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  manager: { color: 'from-blue-500/20 to-blue-500/5', badgeColor: 'bg-blue-500/15 text-blue-300 border-blue-500/30' },
  member: { color: 'from-emerald-500/20 to-emerald-500/5', badgeColor: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  guest: { color: 'from-slate-500/20 to-slate-500/5', badgeColor: 'bg-slate-500/15 text-slate-300 border-slate-500/30' },
}

function roleColors(key: string) {
  if (key.startsWith('custom_')) {
    return { color: 'from-violet-500/20 to-violet-500/5', badgeColor: 'bg-violet-500/15 text-violet-300 border-violet-500/30' }
  }
  return ROLE_COLORS[key] || ROLE_COLORS.guest
}

// Statically defined data resources for the data scope tab
const DATA_RESOURCES: DataResource[] = [
  { id: 'conversation', label: '对话数据', desc: '包含用户与智能体的历史对话记录', icon: 'MessagesSquare' },
  { id: 'knowledge', label: '知识库数据', desc: '包含知识库文档、实体与关系数据', icon: 'Database' },
  { id: 'agent', label: '智能体数据', desc: '包含智能体配置、技能、工具绑定', icon: 'Bot' },
  { id: 'mcp', label: 'MCP 数据', desc: '包含 MCP 工具安装与配置信息', icon: 'CloudMoon' },
  { id: 'scheduled', label: '定时任务数据', desc: '包含所有定时任务及执行记录', icon: 'Timer' },
  { id: 'user', label: '用户数据', desc: '包含人员、账号及组织架构信息', icon: 'Users' },
  { id: 'audit-log', label: '审计日志', desc: '包含各管理操作留痕与登录记录', icon: 'LayoutList' },
]

export const useRbacStore = defineStore('rbac', () => {
  const roles = ref<RoleDef[]>([])
  const permResources = ref<PermResource[]>([])
  const dataResources = ref<DataResource[]>(DATA_RESOURCES)
  const activeRoleId = ref<string>('')
  const activeTab = ref<'func' | 'data'>('func')
  const searchQuery = ref('')
  const loading = ref(false)
  const saving = ref(false)

  const permsMap = ref<Record<string, { granted: Set<string>; dataScope: Record<string, DataScope> }>>({})

  const activeRole = computed(() => roles.value.find((r) => r.id === activeRoleId.value) ?? null)
  const isSuper = computed(() => activeRole.value?.key === 'super_admin')
  const readonly = computed(() => {
    if (!activeRole.value) return true
    return isSuper.value
  })

  const activePermState = computed(() => {
    return permsMap.value[activeRoleId.value] ?? { granted: new Set<string>(), dataScope: {} }
  })

  const activeGranted = computed(() => activePermState.value.granted)

  function getChildren(permId: string): PermResource[] {
    return permResources.value.filter((r) => r.parentId === permId)
  }

  function getRoots(): PermResource[] {
    return permResources.value.filter((r) => r.parentId === null)
  }

  function getDescendantPermKeys(permId: string): string[] {
    const keys: string[] = []
    function walk(id: string) {
      const children = getChildren(id)
      for (const c of children) {
        keys.push(c.permKey)
        walk(c.id)
      }
    }
    walk(permId)
    return keys
  }

  function getAncestorChain(permId: string): string[] {
    const chain: string[] = []
    let current = permResources.value.find((r) => r.id === permId)
    while (current?.parentId) {
      chain.push(current.parentId)
      current = permResources.value.find((r) => r.id === current!.parentId)
    }
    return chain
  }

  function getCheckState(permId: string): 'all' | 'partial' | 'none' {
    if (isSuper.value) return 'all'

    const node = permResources.value.find((r) => r.id === permId)
    if (!node) return 'none'

    // Include the node's own permKey + all descendant permKeys
    const allKeys = [node.permKey, ...getDescendantPermKeys(permId)]
    const count = allKeys.filter((k) => activeGranted.value.has(k)).length
    if (count === 0) return 'none'
    if (count === allKeys.length) return 'all'
    return 'partial'
  }

  function togglePerm(permId: string) {
    if (readonly.value) return

    const node = permResources.value.find((r) => r.id === permId)
    if (!node) return

    const subKeys = [node.permKey, ...getDescendantPermKeys(permId)]
    const currentGranted = permsMap.value[activeRoleId.value]?.granted ?? new Set()
    const newGranted = new Set(currentGranted)

    const allChecked = subKeys.every((k) => currentGranted.has(k))

    if (allChecked) {
      for (const k of subKeys) newGranted.delete(k)
    } else {
      for (const k of subKeys) newGranted.add(k)
    }

    if (!permsMap.value[activeRoleId.value]) {
      permsMap.value[activeRoleId.value] = { granted: newGranted, dataScope: {} }
    } else {
      permsMap.value[activeRoleId.value] = {
        ...permsMap.value[activeRoleId.value],
        granted: newGranted,
      }
    }
  }

  function setDataScope(resourceId: string, scope: DataScope) {
    if (readonly.value) return
    const current = permsMap.value[activeRoleId.value] ?? { granted: new Set(), dataScope: {} }
    permsMap.value[activeRoleId.value] = {
      ...current,
      dataScope: { ...current.dataScope, [resourceId]: scope },
    }
  }

  async function fetchAll() {
    loading.value = true
    try {
      const r = await fetchRoles()
      // Augment with frontend presentation fields
      roles.value = r.map((role) => ({
        ...role,
        status: (role as Record<string, unknown>).is_active !== false ? 'active' as const : 'inactive' as const,
        ...roleColors(role.key),
      }))

      // Load permissions for each role
      for (const role of roles.value) {
        try {
          const perms = await fetchRolePermissions(role.id)
          const scope: Record<string, DataScope> = {}
          for (const ds of perms.dataScopes) {
            scope[ds.resourceKey] = ds.scope
          }
          permsMap.value[role.id] = {
            granted: new Set(perms.granted),
            dataScope: scope,
          }
        } catch {
          permsMap.value[role.id] = { granted: new Set(), dataScope: {} }
        }
      }

      if (!activeRoleId.value && roles.value.length > 0) {
        activeRoleId.value = roles.value[0].id
      }
    } finally {
      loading.value = false
    }
  }

  function setPermResources(resources: PermResource[]) {
    permResources.value = resources
  }

  function selectRole(roleId: string) {
    activeRoleId.value = roleId
  }

  async function handleSave() {
    saving.value = true
    try {
      const state = activePermState.value
      const dataScopes = Object.entries(state.dataScope).map(([resourceKey, scope]) => ({
        resourceKey,
        scope,
      }))
      await saveRolePermissions(activeRoleId.value, [...state.granted], dataScopes)
      return true
    } finally {
      saving.value = false
    }
  }

  async function handleCreateRole(data: { name: string; description: string; copyFrom: string }) {
    const r = await createRole({
      key: `custom_${Date.now()}`,
      name: data.name,
      description: data.description,
      copyPermissionsFrom: data.copyFrom || undefined,
    })
    const augmented: RoleDef = {
      ...r,
      status: (r as Record<string, unknown>).is_active !== false ? 'active' as const : 'inactive' as const,
      ...roleColors(r.key),
    }
    roles.value.push(augmented)

    // Load the new role's permissions (already copied by backend)
    try {
      const perms = await fetchRolePermissions(r.id)
      const scope: Record<string, DataScope> = {}
      for (const ds of perms.dataScopes) {
        scope[ds.resourceKey] = ds.scope
      }
      permsMap.value[r.id] = {
        granted: new Set(perms.granted),
        dataScope: scope,
      }
    } catch {
      permsMap.value[r.id] = { granted: new Set(), dataScope: {} }
    }

    activeRoleId.value = r.id
    return augmented
  }

  async function handleDeleteRole(id: string) {
    await deleteRole(id)
    roles.value = roles.value.filter((r) => r.id !== id)
    delete permsMap.value[id]
    if (activeRoleId.value === id) {
      activeRoleId.value = roles.value[0]?.id ?? ''
    }
  }

  return {
    roles,
    permResources,
    dataResources,
    activeRoleId,
    activeTab,
    searchQuery,
    loading,
    saving,
    activeRole,
    isSuper,
    readonly,
    activeGranted,
    activePermState,
    getChildren,
    getRoots,
    getCheckState,
    getDescendantPermKeys,
    togglePerm,
    setDataScope,
    fetchAll,
    selectRole,
    handleSave,
    handleCreateRole,
    handleDeleteRole,
    setPermResources,
  }
})
