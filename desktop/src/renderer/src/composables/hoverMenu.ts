import type { Ref } from 'vue'

/** hover 菜单控制器：按钮移入打开，移出延迟关闭（给鼠标移入菜单留时间） */
export interface HoverMenu {
  open: () => void
  scheduleClose: () => void
  cancelClose: () => void
  closeNow: () => void
}

/** 创建 hover 菜单控制器（R6：自 PromptInput 外提；模型下拉与「+」菜单共用） */
export function createHoverMenu(flag: Ref<boolean>): HoverMenu {
  let closeTimer: ReturnType<typeof setTimeout> | null = null
  const open = (): void => {
    if (closeTimer) clearTimeout(closeTimer)
    flag.value = true
  }
  const scheduleClose = (): void => {
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = setTimeout(() => {
      flag.value = false
    }, 200)
  }
  const cancelClose = (): void => {
    if (closeTimer) clearTimeout(closeTimer)
  }
  const closeNow = (): void => {
    if (closeTimer) clearTimeout(closeTimer)
    flag.value = false
  }
  return { open, scheduleClose, cancelClose, closeNow }
}
