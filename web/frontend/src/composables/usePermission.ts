import { usePermissionStore } from '@/stores/permission'

export function usePermission() {
  const store = usePermissionStore()

  /** Check if the current user has a specific permission key. Super admin always returns true. */
  function hasPermission(permKey: string): boolean {
    return store.hasPermission(permKey)
  }

  /** Check if the user has any of the given permission keys. */
  function hasAnyPermission(...keys: string[]): boolean {
    return store.hasAnyPermission(...keys)
  }

  /** Check if the user has all of the given permission keys. */
  function hasAllPermissions(...keys: string[]): boolean {
    return store.hasAllPermissions(...keys)
  }

  return { hasPermission, hasAnyPermission, hasAllPermissions }
}
