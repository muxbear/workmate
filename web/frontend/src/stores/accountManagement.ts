import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import type { AccountInfo, AccountCreateRequest, AccountUpdateRequest, RoleDef } from '@/types/admin'
import {
  fetchAccounts,
  fetchAccount,
  createAccount,
  updateAccount,
  deleteAccount,
  toggleAccountStatus,
  unlockAccount,
  resetAccountPassword,
} from '@/services/adminApi'
import { fetchRoles, fetchUserRoles, setUserRoles } from '@/services/rbacApi'

export const useAccountManagementStore = defineStore('accountManagement', () => {
  const accounts = ref<AccountInfo[]>([])
  const selectedAccount = ref<AccountInfo | null>(null)
  const searchQuery = ref('')
  const currentPage = ref(1)
  const pageSize = ref(20)
  const total = ref(0)
  const loading = ref(false)
  const saving = ref(false)

  const totalPages = computed(() => Math.ceil(total.value / pageSize.value) || 1)

  async function loadAccounts() {
    loading.value = true
    try {
      const res = await fetchAccounts({
        search: searchQuery.value || undefined,
        page: currentPage.value,
        pageSize: pageSize.value,
      })
      accounts.value = res.items
      total.value = res.total
      // Load roles for each visible account
      for (const a of res.items) {
        try {
          const roleRes = await fetchUserRoles(a.id)
          accountRoles.value[a.id] = roleRes.roles.map((r: RoleDef) => r.id)
        } catch { /* ignore */ }
      }
    } finally {
      loading.value = false
    }
  }

  async function loadAccountDetail(id: string) {
    const detail = await fetchAccount(id)
    selectedAccount.value = detail
    return detail
  }

  async function handleCreate(data: AccountCreateRequest) {
    saving.value = true
    try {
      const a = await createAccount(data)
      await loadAccounts()
      return a
    } finally {
      saving.value = false
    }
  }

  async function handleUpdate(id: string, data: AccountUpdateRequest) {
    saving.value = true
    try {
      const a = await updateAccount(id, data)
      const idx = accounts.value.findIndex((x) => x.id === id)
      if (idx !== -1) accounts.value[idx] = a
      if (selectedAccount.value?.id === id) selectedAccount.value = a
      return a
    } finally {
      saving.value = false
    }
  }

  async function handleDelete(id: string) {
    saving.value = true
    try {
      await deleteAccount(id)
      accounts.value = accounts.value.filter((a) => a.id !== id)
      if (selectedAccount.value?.id === id) selectedAccount.value = null
      total.value = Math.max(0, total.value - 1)
    } finally {
      saving.value = false
    }
  }

  async function handleToggleStatus(id: string) {
    saving.value = true
    try {
      const a = await toggleAccountStatus(id)
      const idx = accounts.value.findIndex((x) => x.id === id)
      if (idx !== -1) accounts.value[idx] = a
      if (selectedAccount.value?.id === id) selectedAccount.value = a
      return a
    } finally {
      saving.value = false
    }
  }

  async function handleUnlock(id: string) {
    saving.value = true
    try {
      await unlockAccount(id)
    } finally {
      saving.value = false
    }
  }

  async function handleResetPassword(id: string) {
    saving.value = true
    try {
      const res = await resetAccountPassword(id)
      return res.tempPassword
    } finally {
      saving.value = false
    }
  }

  // Role state
  const allRoles = ref<RoleDef[]>([])
  const accountRoles = ref<Record<string, string[]>>({})  // accountId → roleIds
  const rolesLoaded = ref(false)

  async function loadAllRoles() {
    if (rolesLoaded.value) return
    try {
      allRoles.value = await fetchRoles()
      rolesLoaded.value = true
    } catch { /* ignore */ }
  }

  async function loadAccountRoles(accountId: string): Promise<string[]> {
    try {
      const res = await fetchUserRoles(accountId)
      const ids = res.roles.map((r: RoleDef) => r.id)
      accountRoles.value[accountId] = ids
      return ids
    } catch {
      return accountRoles.value[accountId] || []
    }
  }

  async function handleSetRoles(accountId: string, roleIds: string[]) {
    await setUserRoles(accountId, roleIds)
    accountRoles.value[accountId] = roleIds
  }

  function getAccountRoleNames(accountId: string): string[] {
    const ids = accountRoles.value[accountId] || []
    return ids.map((id) => allRoles.value.find((r) => r.id === id)?.name || id)
  }

  return {
    accounts, selectedAccount, searchQuery, currentPage, pageSize,
    total, totalPages, loading, saving,
    allRoles, accountRoles, rolesLoaded,
    loadAccounts, loadAccountDetail,
    handleCreate, handleUpdate, handleDelete,
    handleToggleStatus, handleUnlock, handleResetPassword,
    loadAllRoles, loadAccountRoles, handleSetRoles, getAccountRoleNames,
  }
})
