import { describe, expect, it } from 'vitest'
import i18n from '@/locales'
import en from '@/locales/en'
import zhCN from '@/locales/zh-CN'

/**
 * i18n 覆盖率与键一致性（迭代 6 T6.6）。
 *
 * 本批次只迁移了**知识库模块的高流量界面**（列表 → 进库 → 看文档这条主路径），
 * 其余模块仍是硬编码中文。这个文件锁住两件事：
 *
 * 1. **en 与 zh-CN 的键集合完全一致**——缺键时 vue-i18n 会静默回退到中文，
 *    界面上只是一段中文夹在英文里，没人会发现问题；这是"真双语"唯一的机器保证。
 * 2. 迁移过的键**在两种语言下都能取到值**，且英文确实不是中文原文。
 */

type Tree = Record<string, unknown>

function flatten(obj: Tree, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') Object.assign(out, flatten(v as Tree, key))
    else out[key] = String(v)
  }
  return out
}

const zhFlat = flatten(zhCN as Tree)
const enFlat = flatten(en as Tree)

describe('语言包', () => {
  it('en 与 zh-CN 的键集合完全一致', () => {
    const zhKeys = Object.keys(zhFlat).sort()
    const enKeys = Object.keys(enFlat).sort()

    const missingInEn = zhKeys.filter((k) => !(k in enFlat))
    const extraInEn = enKeys.filter((k) => !(k in zhFlat))

    expect(
      { missingInEn, extraInEn },
      '缺键会让界面静默回退成中文，且没有任何提示——必须两侧同构',
    ).toEqual({ missingInEn: [], extraInEn: [] })
  })

  it('每个键在两种语言下都有非空值', () => {
    const empty = Object.entries({ ...zhFlat, ...enFlat }).filter(([, v]) => !v.trim())
    expect(empty.map(([k]) => k)).toEqual([])
  })

  it('知识库命名空间已建立，且不是占位空壳', () => {
    const kbKeys = Object.keys(zhFlat).filter((k) => k.startsWith('knowledge.'))
    expect(kbKeys.length).toBeGreaterThan(80)
    expect(Object.keys(enFlat).filter((k) => k.startsWith('knowledge.'))).toHaveLength(
      kbKeys.length,
    )
  })

  it('英文确实翻过，不是照抄中文', () => {
    // 抽查几个高频键：若英文与中文逐字相同，多半是漏翻了
    const samples = [
      'knowledge.list.title',
      'knowledge.docs.upload',
      'knowledge.detail.reindex',
      'knowledge.drawer.back',
      'knowledge.sidebar.accept',
    ]
    for (const key of samples) {
      expect(enFlat[key], `${key} 的英文与中文相同`).not.toBe(zhFlat[key])
      expect(enFlat[key]).toMatch(/[A-Za-z]/)
    }
  })
})

describe('语言切换', () => {
  it('切换 locale 后取到的是另一种语言', () => {
    const original = i18n.global.locale.value
    try {
      i18n.global.locale.value = 'zh-CN'
      expect(i18n.global.t('knowledge.list.title')).toBe('知识库概览')

      i18n.global.locale.value = 'en'
      expect(i18n.global.t('knowledge.list.title')).toBe('Knowledge bases')
    } finally {
      i18n.global.locale.value = original
    }
  })

  it('带参数的文案在两种语言里都能插值', () => {
    const original = i18n.global.locale.value
    try {
      i18n.global.locale.value = 'zh-CN'
      expect(i18n.global.t('knowledge.docs.viewDetail', { name: '报告' })).toContain('报告')

      i18n.global.locale.value = 'en'
      expect(i18n.global.t('knowledge.docs.viewDetail', { name: 'Report' })).toContain('Report')
    } finally {
      i18n.global.locale.value = original
    }
  })
})
