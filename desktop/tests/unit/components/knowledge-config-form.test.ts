import { describe, expect, it } from 'vitest'
import { createSSRApp, computed, defineComponent, h, reactive } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createPinia } from 'pinia'
import KnowledgeConfigForm from '../../../src/renderer/src/components/knowledge/KnowledgeConfigForm.vue'
import {
  createDraft,
  KNOWLEDGE_FIELD_LIST
} from '../../../src/renderer/src/components/knowledge/knowledgeFields'
import { defaultSettings } from '../../../src/main/settings/schema'
import type { KnowledgeOverrideKey, KnowledgeOverrides } from '../../../src/preload/index.d'

/**
 * 共享表单的运行时渲染验证（SSR，无需 jsdom）
 *
 * 重点验证「全局模式 ↔ 按库模式」两套行为：跟随开关是否出现、跟随项是否禁用、
 * 布局开关（存放目录卡片）是否生效。
 */

const SETTINGS = defaultSettings() as Record<string, unknown>

/** 全局 17 项（短 key 形态） */
function globalValues(): KnowledgeOverrides {
  const out: KnowledgeOverrides = {}
  for (const [key, value] of Object.entries(SETTINGS)) {
    if (key.startsWith('knowledge.') && key !== 'knowledge.directory') {
      out[key.slice('knowledge.'.length) as KnowledgeOverrideKey] = value
    }
  }
  return out
}

/** 仅指定项自定义，其余跟随全局 */
function customOnly(...keys: KnowledgeOverrideKey[]): Record<KnowledgeOverrideKey, boolean> {
  const out = {} as Record<KnowledgeOverrideKey, boolean>
  for (const key of Object.keys(globalValues()) as KnowledgeOverrideKey[]) {
    out[key] = keys.includes(key)
  }
  return out
}

async function render(props: Record<string, unknown>): Promise<string> {
  const app = createSSRApp(KnowledgeConfigForm, props)
  app.use(createPinia())
  return renderToString(app)
}

/** 被禁用元素个数（Vue SSR 渲染为裸 `disabled`；类名 s-toggle--disabled 不会被误计） */
function disabledCount(html: string): number {
  return (html.match(/ disabled/g) ?? []).length
}

describe('KnowledgeConfigForm（全局模式：知识库设置页）', () => {
  it('渲染 4 张配置卡片，不含存放目录卡片与跟随开关', async () => {
    const html = await render({ draft: createDraft(globalValues()) })
    expect(html).toContain('文件上传')
    expect(html).toContain('RAG 索引')
    expect(html).toContain('混合检索与重排')
    expect(html).toContain('知识图谱抽取')
    expect(html).not.toContain('kb-card--soft') // 存放目录卡片
    expect(html).not.toContain('选择目录')
    expect(html).not.toContain('跟随全局')
    expect(html).not.toContain('kb-label--row')
  })

  it('渲染全部带标签的字段（14 项；布尔项是卡片头开关，无独立标签）', async () => {
    const html = await render({ draft: createDraft(globalValues()) })
    const labelled = KNOWLEDGE_FIELD_LIST.filter((field) => field.kind !== 'boolean')
    expect(labelled).toHaveLength(14)
    for (const field of labelled) {
      expect(html).toContain(field.label)
    }
  })

  it('传入目录时渲染存放目录卡片（仅设置页）', async () => {
    const html = await render({ draft: createDraft(globalValues()), directory: 'C:\\KeWork\\kb' })
    expect(html).toContain('kb-card--soft')
    expect(html).toContain('选择目录')
  })

  it('布尔项按草稿值渲染开关状态', async () => {
    // 默认：稀疏检索 / 启用重排 开，知识图谱抽取 关（全局模式无跟随开关）
    const html = await render({ draft: createDraft(globalValues()) })
    expect((html.match(/role="switch"/g) ?? []).length).toBe(3)
    expect((html.match(/aria-checked="true"/g) ?? []).length).toBe(2)
    expect((html.match(/aria-checked="false"/g) ?? []).length).toBe(1)
  })

  it('业务联动禁用：未启用图谱时抽取模型禁用（全局模式仅此 1 处禁用）', async () => {
    const html = await render({ draft: createDraft(globalValues()) })
    // graphEnabled 默认 false → 抽取模型禁用；sparseRetrieval/rerankEnabled 默认 true
    expect(disabledCount(html)).toBe(1)
    expect(html).toContain('value="GLM-5"')
  })

  it('未启用稀疏检索时 BM25 两项一起禁用', async () => {
    const values = { ...globalValues(), sparseRetrieval: false }
    const html = await render({ draft: createDraft(values) })
    expect(disabledCount(html)).toBe(3) // BM25 k1 / BM25 b / 图谱抽取模型
  })
})

describe('KnowledgeConfigForm（按库模式：跟随全局 / 自定义）', () => {
  it('全部跟随时 17 项都出现跟随开关且控件全部禁用', async () => {
    const html = await render({
      draft: createDraft(globalValues()),
      custom: {} as Record<KnowledgeOverrideKey, boolean>
    })
    expect((html.match(/跟随全局/g) ?? []).length).toBe(17)
    expect(html).not.toContain('>自定义<')
    // 14 个字段控件 + 3 个布尔开关，全部禁用
    expect(disabledCount(html)).toBe(17)
  })

  it('单项自定义后该项解除禁用并显示「自定义」', async () => {
    const html = await render({
      draft: createDraft(globalValues()),
      custom: customOnly('chunkSize')
    })
    expect((html.match(/自定义/g) ?? []).length).toBe(1)
    expect((html.match(/跟随全局/g) ?? []).length).toBe(16)
    expect(disabledCount(html)).toBe(16)
  })

  it('自定义项的跟随开关为开态，其余 16 项为关态', async () => {
    const html = await render({
      draft: createDraft(globalValues()),
      custom: customOnly('chunkSize')
    })
    // 全部 17 个跟随开关均为 sm 尺寸；其中恰好 1 个（chunkSize）处于开态
    expect((html.match(/class="s-toggle s-toggle--on s-toggle--sm"/g) ?? []).length).toBe(1)
    expect((html.match(/class="s-toggle s-toggle--sm"/g) ?? []).length).toBe(16)
  })
})

/**
 * 技术前提守护：KnowledgeConfigForm 用「ref 映射 + 模板 v-model」绑定 17 个字段。
 * 模板里读到的是 `$setup.models.<key>`，普通对象**不会**解包 ref —— 值会变成 computed 对象
 * （输入框显示 [object Object]，写回也不触发 setter），必须用 reactive 包裹。
 */
describe('ref 映射的模板解包（KnowledgeConfigForm 的字段绑定方式）', () => {
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  function makeProbe(wrap: (raw: object) => object) {
    return defineComponent({
      setup() {
        const raw = {
          chunkSize: computed({
            get: () => 800,
            set: () => undefined
          })
        }
        const models = wrap(raw) as { chunkSize: number }
        return () => h('span', `值=${models.chunkSize}`)
      }
    })
  }

  it('reactive 包裹后模板读到的是值本身', async () => {
    const app = createSSRApp(makeProbe((raw) => reactive(raw)))
    expect(await renderToString(app)).toContain('值=800')
  })

  it('普通对象则会读到 ref 对象（故不可直接裸用）', async () => {
    const app = createSSRApp(makeProbe((raw) => raw))
    expect(await renderToString(app)).toContain('值=[object Object]')
  })
})
