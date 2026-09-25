import { computed } from 'vue'
import { usePermissionStore } from '@/stores/permission'

/**
 * 知识库写操作的权限开关（迭代 5 T5.1）。
 *
 * 权限校验有**两条轴**，缺一不可：
 *
 * 1. **资源归属**（已有的 `readonly`）：公共库、他人分享给我的库——不是自己的库，
 *    就不能改；
 * 2. **角色权限**（本组合式函数）：即使库是自己的，若当前角色没有对应权限键
 *    （如访客角色），同样不能建库/传文档/删库。
 *
 * 两者合并成 `canXxx` 后再交给界面显隐。后端对这些接口已经挂了 `RequirePermission`
 * （见 `api/rbac/deps.py`），所以这里的显隐是**体验**层面的：让用户看不到点了会 403
 * 的按钮，而不是把权限判定的责任交给前端。
 *
 * 键的归属（与后端接线保持一致）：
 * - `knowledge:create` 建库；`knowledge:edit` 改配置/重建/分享/发布/图谱重抽；
 * - `knowledge:upload` 上传/删除/重试/取消文档、编辑切片；`knowledge:delete` 删库。
 */
export function useKbPermissions() {
  const permission = usePermissionStore()

  return {
    canCreate: computed(() => permission.hasPermission('knowledge:create')),
    canEdit: computed(() => permission.hasPermission('knowledge:edit')),
    canUpload: computed(() => permission.hasPermission('knowledge:upload')),
    canDelete: computed(() => permission.hasPermission('knowledge:delete')),
  }
}
