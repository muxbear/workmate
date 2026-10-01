import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  fetchSystemSettings,
  resetSystemLogo,
  updateSystemSettings,
  uploadSystemLogo,
} from '@/services/settingsApi'
import type { SystemSettings } from '@/types/settings'

/** 后端未配置时的兜底系统名称，与 `index.html` 的静态标题一致 */
export const DEFAULT_SYSTEM_NAME = 'Ke-Work'

/**
 * 全局品牌状态：系统名称与 LOGO。
 *
 * 在 `main.ts` 里随 Pinia 一起启动加载（**不是** `MainLayout.onMounted`）：
 * 登录页 `BrandPanel` 渲染在 `MainLayout` 之外，那条路径根本不会执行
 * `MainLayout` 的生命周期；而 `GET /settings/system` 是公开接口，
 * 未登录也能取，所以启动时无条件拉一次就够了。
 *
 * 系统名称是全局的而非按用户的，登出无需复位——没有会被下一个用户看到的隐私。
 */
export const useBrandStore = defineStore('brand', () => {
  const systemName = ref(DEFAULT_SYSTEM_NAME)
  /** 后端返回的根相对地址；null = 未自定义，组件回退内置 LOGO */
  const logoUrl = ref<string | null>(null)
  /** 是否已尝试加载（成功或失败都置位），页面据此决定是否回填草稿 */
  const loaded = ref(false)
  /** 每次 LOGO 变更自增：同一 URL 换了图，浏览器会吃缓存，用 ?v= 破掉 */
  const logoRevision = ref(0)

  const hasCustomLogo = computed(() => !!logoUrl.value)

  const logoDisplaySrc = computed(() => {
    const url = logoUrl.value
    if (!url) return null
    if (logoRevision.value === 0) return url
    return url + (url.includes('?') ? '&' : '?') + 'v=' + logoRevision.value
  })

  /** 同步浏览器标签标题。桌面版会拼 '桌面' 后缀，那是桌面构建专有的，Web 不拼。 */
  function applyDocumentTitle() {
    if (typeof document === 'undefined') return
    document.title = systemName.value.trim() || DEFAULT_SYSTEM_NAME
  }

  function apply(payload: SystemSettings) {
    systemName.value = (payload?.systemName ?? '').trim() || DEFAULT_SYSTEM_NAME
    logoUrl.value = payload?.logoUrl ?? null
    loaded.value = true
    applyDocumentTitle()
  }

  /**
   * 拉取系统标识。
   *
   * **绝不抛**：后端不可达时保持默认值与内置 LOGO 即可，不该拖慢首屏、
   * 也不该在登录页弹错误提示。
   */
  async function load(): Promise<void> {
    try {
      apply(await fetchSystemSettings())
    } catch {
      loaded.value = true
      applyDocumentTitle()
    }
  }

  async function saveSystemName(name: string): Promise<void> {
    apply(await updateSystemSettings({ systemName: name }))
  }

  async function uploadLogo(file: File): Promise<void> {
    apply(await uploadSystemLogo(file))
    logoRevision.value++
  }

  async function resetLogo(): Promise<void> {
    apply(await resetSystemLogo())
    logoRevision.value++
  }

  // 不等网络：先把标题写成默认名，避免首帧标题与后端配的不一致
  applyDocumentTitle()

  return {
    systemName,
    logoUrl,
    logoDisplaySrc,
    logoRevision,
    hasCustomLogo,
    loaded,
    load,
    saveSystemName,
    uploadLogo,
    resetLogo,
  }
})
