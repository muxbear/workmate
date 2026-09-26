import { createI18n } from 'vue-i18n'
import en from './en'
import zhCN from './zh-CN'

/**
 * 语言包与当前语言（迭代 6 T6.6）。
 *
 * 此前这里只注册了 `zh-CN` 且把 `locale` 写死，`en-US.ts` 只在设计文档里"预留了
 * 位置"——也就是这个应用**从没做过 i18n**。本批次补上 en 与切换能力。
 *
 * 默认仍取 `zh-CN`：界面上绝大多数模块还是中文，默认切到英文只会让人看到中英混杂。
 */
export type LocaleCode = 'zh-CN' | 'en'

export const LOCALE_STORAGE_KEY = 'ui_locale'

/** 可选语言——切换器据此渲染 */
export const LOCALE_OPTIONS: { value: LocaleCode; label: string }[] = [
  { value: 'zh-CN', label: '中文' },
  { value: 'en', label: 'English' },
]

export function getInitialLocale(): LocaleCode {
  try {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (saved === 'zh-CN' || saved === 'en') return saved
  } catch {
    // 本地存储不可用（隐私模式等）时用默认值
  }
  return 'zh-CN'
}

const i18n = createI18n({
  legacy: false,
  locale: getInitialLocale(),
  fallbackLocale: 'zh-CN',
  messages: { 'zh-CN': zhCN, en },
})

export default i18n
