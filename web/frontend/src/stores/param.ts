import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { ParamItem, ParamPayload } from '@/types/param'
import {
  createParam,
  deleteParam,
  fetchChildrenParams,
  fetchParentParams,
  reorderParams,
  updateParam,
} from '@/services/paramApi'

export const useParamStore = defineStore('param', () => {
  const parents = ref<ParamItem[]>([])
  const children = ref<ParamItem[]>([])
  const selectedCode = ref<string | null>(null)
  const searchQuery = ref('')
  const loadingParents = ref(false)
  const loadingChildren = ref(false)

  const selectedParent = computed<ParamItem | null>(() => {
    if (!selectedCode.value) return null
    return parents.value.find((item) => item.paramCode === selectedCode.value) ?? null
  })

  const filteredParents = computed<ParamItem[]>(() => {
    const q = searchQuery.value.trim().toLowerCase()
    if (!q) return parents.value
    return parents.value.filter((item) => {
      return (
        item.paramCode.toLowerCase().includes(q) ||
        item.paramLabel.toLowerCase().includes(q) ||
        item.paramName.toLowerCase().includes(q)
      )
    })
  })

  async function fetchParents() {
    loadingParents.value = true
    try {
      parents.value = await fetchParentParams()
      if (parents.value.length === 0) {
        selectedCode.value = null
        children.value = []
        return
      }
      const keepSelection = parents.value.some((item) => item.paramCode === selectedCode.value)
      if (!keepSelection) {
        selectedCode.value = parents.value[0].paramCode
        await fetchChildren(selectedCode.value)
      }
    } finally {
      loadingParents.value = false
    }
  }

  async function fetchChildren(parentCode: string) {
    loadingChildren.value = true
    try {
      children.value = await fetchChildrenParams(parentCode)
    } finally {
      loadingChildren.value = false
    }
  }

  async function selectParent(parentCode: string) {
    if (selectedCode.value === parentCode) return
    selectedCode.value = parentCode
    await fetchChildren(parentCode)
  }

  async function handleCreate(payload: ParamPayload) {
    const created = await createParam(payload)
    if (payload.parentCode) {
      if (payload.parentCode === selectedCode.value) {
        children.value = [...children.value, created].sort((a, b) => a.sortOrder - b.sortOrder)
      }
    } else {
      parents.value = [...parents.value, created].sort((a, b) => a.sortOrder - b.sortOrder)
      selectedCode.value = created.paramCode
      children.value = []
    }
    return created
  }

  async function handleUpdate(item: ParamItem, payload: ParamPayload) {
    const updated = await updateParam(item.id, payload)
    if (!item.parentCode) {
      parents.value = parents.value.map((parent) => (parent.id === item.id ? updated : parent))
      if (selectedCode.value === item.paramCode) {
        selectedCode.value = updated.paramCode
        await fetchChildren(updated.paramCode)
      }
    } else {
      children.value = children.value.map((child) => (child.id === item.id ? updated : child))
    }
    return updated
  }

  async function handleDelete(item: ParamItem) {
    const result = await deleteParam(item.id)
    if (item.parentCode) {
      children.value = children.value.filter((child) => child.id !== item.id)
    } else {
      parents.value = parents.value.filter((parent) => parent.id !== item.id)
      if (selectedCode.value === item.paramCode) {
        selectedCode.value = null
        children.value = []
      }
    }
    return result
  }

  async function reorderParents(orderedIds: string[]) {
    const snapshot = parents.value.map((item) => ({ ...item }))
    const byId = new Map(parents.value.map((item) => [item.id, item]))
    const next = orderedIds
      .map((id) => byId.get(id))
      .filter((item): item is ParamItem => item !== undefined)
    parents.value = next
    try {
      parents.value = await reorderParams({
        scope: 'parents',
        parentCode: null,
        ids: orderedIds,
      })
    } catch (error) {
      parents.value = snapshot
      throw error
    }
  }

  async function reorderChildren(orderedIds: string[]) {
    const snapshot = children.value.map((item) => ({ ...item }))
    const byId = new Map(children.value.map((item) => [item.id, item]))
    const next = orderedIds
      .map((id) => byId.get(id))
      .filter((item): item is ParamItem => item !== undefined)
    children.value = next
    try {
      children.value = await reorderParams({
        scope: 'children',
        parentCode: selectedCode.value,
        ids: orderedIds,
      })
    } catch (error) {
      children.value = snapshot
      throw error
    }
  }

  function reset() {
    parents.value = []
    children.value = []
    selectedCode.value = null
    searchQuery.value = ''
    loadingParents.value = false
    loadingChildren.value = false
  }

  return {
    parents,
    children,
    selectedCode,
    selectedParent,
    filteredParents,
    searchQuery,
    loadingParents,
    loadingChildren,
    fetchParents,
    fetchChildren,
    selectParent,
    handleCreate,
    handleUpdate,
    handleDelete,
    reorderParents,
    reorderChildren,
    reset,
  }
})
