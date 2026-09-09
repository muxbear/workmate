import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { fetchMyPermissions } from '@/services/rbacApi'
import type { MyMenuNode } from '@/types/admin'

export const usePermissionStore = defineStore('permission', () => {
  // ── State ──────────────────────────────────────────────────────
  const permKeys = ref<Set<string>>(new Set())
  const roles = ref<string[]>([])
  const activeRole = ref<string | null>(null)
  const menus = ref<MyMenuNode[]>([])
  const dataScopes = ref<Record<string, string>>({})
  const loaded = ref(false)
  const loading = ref(false)
  const error = ref<string | null>(null)

  // ── Getters ────────────────────────────────────────────────────
  const isSuperAdmin = computed(() => roles.value.includes('super_admin'))

  /** 当前角色第一个可访问的菜单路径，用于切换角色后的兜底跳转。 */
  const firstMenuPath = computed(() => {
    for (const group of menuGroups.value) {
      for (const item of group.items) {
        if (item.route) return item.route
      }
    }
    return '/overview'
  })

  /* Catalog→menu grouped structure for sidebar rendering */
  const menuGroups = computed(() => {
    const catalogs = menus.value
      .filter((m) => m.type === 'catalog')
      .sort((a, b) => a.sortOrder - b.sortOrder)
    const menuItems = menus.value
      .filter((m) => m.type === 'menu')
      .sort((a, b) => a.sortOrder - b.sortOrder)
    const rootMenuItems = menuItems.filter((m) => m.parentId === null)

    const grouped = catalogs
      .map((cat) => ({
        label: cat.label,
        icon: cat.icon,
        items: menuItems
          .filter((m) => m.parentId === cat.id)
          .map((m) => ({
            text: m.label,
            route: m.path || undefined,
            icon: m.icon,
          })),
      }))
      .filter((g) => g.items.length > 0)

    if (rootMenuItems.length > 0) {
      const rootGroup = {
        label: '首页',
        icon: 'LayoutDashboard',
        items: rootMenuItems.map((m) => ({
          text: m.label,
          route: m.path || undefined,
          icon: m.icon,
        })),
      }
      return [rootGroup, ...grouped]
    }

    return grouped
  })

  // ── Actions ────────────────────────────────────────────────────
  function hasPermission(permKey: string): boolean {
    if (isSuperAdmin.value) return true
    return permKeys.value.has(permKey)
  }

  function hasAnyPermission(...keys: string[]): boolean {
    return keys.some((k) => hasPermission(k))
  }

  function hasAllPermissions(...keys: string[]): boolean {
    return keys.every((k) => hasPermission(k))
  }

  function getDataScope(resourceKey: string): string {
    if (isSuperAdmin.value) return 'all'
    return dataScopes.value[resourceKey] || 'none'
  }

  async function load(force = false) {
    if (loading.value) return
    if (loaded.value && !force) return
    loading.value = true
    error.value = null
    try {
      const data = await fetchMyPermissions()
      permKeys.value = new Set(data.permKeys)
      roles.value = data.roles
      activeRole.value = data.activeRole ?? data.roles[0] ?? null
      menus.value = data.menus
      let homeMenu = menus.value.find((m) => m.id === 'g-home')
      if (!homeMenu) {
        homeMenu = {
          id: 'g-home',
          parentId: null,
          type: 'catalog',
          label: '首页',
          path: null,
          icon: 'LayoutDashboard',
          sortOrder: 0,
        }
        menus.value.unshift(homeMenu)
      } else {
        homeMenu.parentId = null
        homeMenu.sortOrder = 0
      }

      const overviewMenu = menus.value.find((m) => m.id === 'm-ctrl-overview')
      if (overviewMenu) {
        overviewMenu.parentId = 'g-home'
        overviewMenu.sortOrder = 1
      }
      const scope: Record<string, string> = {}
      for (const ds of data.dataScopes) {
        scope[ds.resourceKey] = ds.scope
      }
      dataScopes.value = scope
      loaded.value = true
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      error.value = msg
      console.error('[PermissionStore] Failed to load permissions:', msg)
      // Fallback: try to use roles from auth store login response
      try {
        const { useAuthStore } = await import('@/stores/auth')
        const authStore = useAuthStore()
        if (authStore.user?.roles?.length) {
          const activeKey = authStore.user.activeRole
          roles.value = activeKey ? [activeKey] : authStore.user.roles
          activeRole.value = activeKey ?? roles.value[0] ?? null
          console.warn(
            '[PermissionStore] Using roles from login response as fallback:',
            roles.value,
          )
          loaded.value = true
        }
      } catch {
        // Fallback failed, menus will be empty
      }
    } finally {
      loading.value = false
    }
  }

  function reset() {
    permKeys.value = new Set()
    roles.value = []
    activeRole.value = null
    menus.value = []
    dataScopes.value = {}
    loaded.value = false
    loading.value = false
    error.value = null
  }

  return {
    permKeys,
    roles,
    activeRole,
    menus,
    dataScopes,
    loaded,
    loading,
    error,
    isSuperAdmin,
    firstMenuPath,
    menuGroups,
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
    getDataScope,
    load,
    reset,
  }
})
