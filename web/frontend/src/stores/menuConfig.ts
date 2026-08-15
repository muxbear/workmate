import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import type { PermResource, PermType, PermStatus, BtnVariant, RoleCoverage } from '@/types/admin'
import {
  fetchResources,
  createResource,
  updateResource,
  deleteResource,
  reorderResource,
} from '@/services/rbacApi'
import { useRbacStore } from '@/stores/rbac'

export type ResourceDropPlacement = 'before' | 'after' | 'inside'

export const useMenuConfigStore = defineStore('menuConfig', () => {
  const resources = ref<PermResource[]>([])
  const selectedId = ref<string | null>(null)
  const expandedIds = ref<Set<string>>(new Set())
  const activeTab = ref<'basic' | 'buttons' | 'roles'>('basic')
  const searchQuery = ref('')
  const loading = ref(false)
  const saving = ref(false)
  const saved = ref(false)
  const draggingResourceId = ref<string | null>(null)
  const dropTargetId = ref<string | null>(null)
  const dropPlacement = ref<ResourceDropPlacement | null>(null)

  const selected = computed(() => resources.value.find((r) => r.id === selectedId.value) ?? null)

  const buttonsOfSelected = computed(() => {
    const sel = selected.value
    if (!sel || sel.type !== 'menu') return []
    return resources.value
      .filter((r) => r.parentId === sel.id && r.type === 'button')
      .sort((a, b) => a.sortOrder - b.sortOrder)
  })

  const childrenOf = (parentId: string | null) =>
    resources.value
      .filter((r) => r.parentId === parentId)
      .sort((a, b) => a.sortOrder - b.sortOrder)

  const roots = computed(() => childrenOf(null))
  const draggingResource = computed(() =>
    resources.value.find((r) => r.id === draggingResourceId.value) ?? null,
  )
  const draggingEnabled = computed(() => !searchQuery.value.trim())

  async function fetchAll() {
    loading.value = true
    try {
      resources.value = await fetchResources()
      let home = resources.value.find((r) => r.id === 'g-home')
      if (!home) {
        home = {
          id: 'g-home',
          parentId: null,
          type: 'catalog',
          label: '首页',
          permKey: 'home',
          path: undefined,
          icon: 'LayoutDashboard',
          sortOrder: 0,
          status: 'active',
          isBuiltin: true,
          description: '首页概览',
          btnVariant: undefined,
          danger: false,
        }
        resources.value.unshift(home)
      } else {
        home.parentId = null
        home.sortOrder = 0
      }

      const overview = resources.value.find((r) => r.permKey === 'control:overview')
      if (overview) {
        overview.parentId = 'g-home'
        overview.sortOrder = 1
      }
      if (!selectedId.value && resources.value.length > 0) {
        selectedId.value = resources.value[0].id
      }
      expandedIds.value = new Set(resources.value.filter((r) => r.type === 'catalog').map((r) => r.id))
    } finally {
      loading.value = false
    }
  }

  function selectResource(id: string) {
    selectedId.value = id
    const r = resources.value.find((x) => x.id === id)
    if (r && r.type !== 'button') {
      activeTab.value = 'basic'
    }
  }

  function toggleExpand(id: string) {
    const next = new Set(expandedIds.value)
    next.has(id) ? next.delete(id) : next.add(id)
    expandedIds.value = next
  }

  function isDescendant(sourceId: string, targetId: string): boolean {
    const childrenByParent = new Map<string | null, string[]>()
    for (const resource of resources.value) {
      const list = childrenByParent.get(resource.parentId) ?? []
      list.push(resource.id)
      childrenByParent.set(resource.parentId, list)
    }

    const stack = [targetId]
    while (stack.length) {
      const current = stack.pop() as string
      const children = childrenByParent.get(current) ?? []
      for (const childId of children) {
        if (childId === sourceId) return true
        stack.push(childId)
      }
    }
    return false
  }

  function canDropResource(
    source: PermResource,
    target: PermResource,
    placement: ResourceDropPlacement,
  ): boolean {
    if (!source || !target || source.id === target.id) return false
    if (isDescendant(source.id, target.id)) return false

    const newParentId = placement === 'inside' ? target.id : target.parentId

    if (source.type === 'catalog') {
      return newParentId === null && placement !== 'inside'
    }

    if (source.type === 'menu') {
      if (!newParentId) {
        return source.parentId === null && placement !== 'inside'
      }
      const parent = resources.value.find((r) => r.id === newParentId)
      return parent?.type === 'catalog'
    }

    if (source.type === 'button') {
      if (!newParentId) return false
      const parent = resources.value.find((r) => r.id === newParentId)
      return parent?.type === 'menu'
    }

    return false
  }

  function setDraggingResource(id: string | null) {
    draggingResourceId.value = id
    if (!id) {
      dropTargetId.value = null
      dropPlacement.value = null
    }
  }

  function setDropTarget(id: string | null, placement: ResourceDropPlacement | null) {
    dropTargetId.value = id
    dropPlacement.value = placement
  }

  function resetDragState() {
    draggingResourceId.value = null
    dropTargetId.value = null
    dropPlacement.value = null
  }

  async function moveResource(
    sourceId: string,
    targetId: string,
    placement: ResourceDropPlacement,
  ): Promise<boolean> {
    const source = resources.value.find((r) => r.id === sourceId)
    const target = resources.value.find((r) => r.id === targetId)
    if (!source || !target || !canDropResource(source, target, placement)) {
      return false
    }

    const snapshot = resources.value.map((r) => ({ ...r }))
    const newParentId = placement === 'inside' ? target.id : target.parentId
    const siblings = resources.value
      .filter((r) => r.parentId === newParentId && r.id !== sourceId)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((r) => r.id)

    let insertIndex = siblings.length
    if (placement !== 'inside') {
      const targetIndex = siblings.indexOf(targetId)
      if (targetIndex === -1) return false
      insertIndex = placement === 'before' ? targetIndex : targetIndex + 1
    }

    siblings.splice(insertIndex, 0, sourceId)

    const next = resources.value.map((r) => ({
      ...r,
      parentId: r.id === sourceId ? newParentId : r.parentId,
    }))
    siblings.forEach((id, index) => {
      const item = next.find((r) => r.id === id)
      if (item) item.sortOrder = (index + 1) * 10
    })
    resources.value = next

    try {
      const updated = await reorderResource({ sourceId, targetId, placement })
      resources.value = updated
      showSaved()
      return true
    } catch (error) {
      resources.value = snapshot
      throw error
    }
  }

  async function handleCreate(data: {
    parentId: string | null
    type: PermType
    label: string
    permKey: string
    path?: string
    icon: string
    sortOrder: number
    status: string
    description?: string
    btnVariant?: BtnVariant
    danger?: boolean
  }) {
    saving.value = true
    try {
      const r = await createResource(data as Record<string, unknown> as Partial<PermResource>)
      resources.value.push(r)
      selectedId.value = r.id
      if (data.parentId) expandedIds.value = new Set([...expandedIds.value, data.parentId])
      showSaved()
      return r
    } finally { saving.value = false }
  }

  async function handleUpdate(data: {
    id: string
    label: string
    permKey: string
    path?: string
    icon: string
    sortOrder: number
    status: string
    description?: string
    btnVariant?: BtnVariant
    danger?: boolean
  }) {
    saving.value = true
    try {
      const r = await updateResource(data as PermResource)
      if (r) {
        const idx = resources.value.findIndex((x) => x.id === r.id)
        if (idx !== -1) resources.value[idx] = r
      }
      showSaved()
      return r
    } finally { saving.value = false }
  }

  async function handleDelete(id: string) {
    saving.value = true
    try {
      await deleteResource(id)
      const idsToDelete = new Set<string>([id])
      let changed = true
      while (changed) {
        changed = false
        for (const r of resources.value) {
          if (r.parentId && idsToDelete.has(r.parentId) && !idsToDelete.has(r.id)) {
            idsToDelete.add(r.id)
            changed = true
          }
        }
      }
      resources.value = resources.value.filter((r) => !idsToDelete.has(r.id))
      if (idsToDelete.has(selectedId.value ?? '')) {
        selectedId.value = resources.value[0]?.id ?? null
      }
      return true
    } finally { saving.value = false }
  }

  function showSaved() {
    saved.value = true
    setTimeout(() => (saved.value = false), 2000)
  }

  // Role coverage — reads from actual RBAC store permission data
  const roleCoverages = computed<RoleCoverage[]>(() => {
    const sel = selected.value
    if (!sel) return []
    const rbacStore = useRbacStore()
    return rbacStore.roles.map((role) => ({
      roleKey: role.key,
      roleName: role.name,
      hasPermission: rbacStore.permsMap[role.id]?.granted.has(sel.permKey) ?? false,
    }))
  })

  return {
    resources,
    selectedId,
    expandedIds,
    activeTab,
    searchQuery,
    loading,
    saving,
    saved,
    selected,
    buttonsOfSelected,
    roots,
    draggingResourceId,
    dropTargetId,
    dropPlacement,
    draggingResource,
    draggingEnabled,
    roleCoverages,
    childrenOf,
    fetchAll,
    selectResource,
    toggleExpand,
    handleCreate,
    handleUpdate,
    handleDelete,
    setDraggingResource,
    setDropTarget,
    resetDragState,
    canDropResource,
    moveResource,
  }
})
