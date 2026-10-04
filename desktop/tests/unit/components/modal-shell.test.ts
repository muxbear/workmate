import { describe, expect, it } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createPinia } from 'pinia'
import ConfirmDialog from '../../../src/renderer/src/components/ConfirmDialog.vue'
import KnowledgeCreateModal from '../../../src/renderer/src/components/knowledge/KnowledgeCreateModal.vue'
import KnowledgeRenameModal from '../../../src/renderer/src/components/knowledge/KnowledgeRenameModal.vue'

/**
 * ModalShell 迁移后的首屏渲染验证（SSR，无需 jsdom）。
 *
 * 壳迁移（2026-10 重构）把 11 个模态的 mask/card/header/关闭 X/footer/过渡收敛到
 * ModalShell：这里钉住"壳 + 槽内容"的组合输出，防止后续再迁移/调整时丢内容。
 */

async function render(component: unknown, props: Record<string, unknown>): Promise<string> {
  const app = createSSRApp(component as never, props)
  app.use(createPinia())
  return renderToString(app)
}

describe('ModalShell（壳 + 槽组合）', () => {
  it('ConfirmDialog：标题/正文/按钮经壳渲染，含关闭按钮与卡片类名', async () => {
    const html = await render(ConfirmDialog, { title: '退出确认', message: '确定要退出吗？' })
    expect(html).toContain('ms-mask')
    expect(html).toContain('ms-card')
    expect(html).toContain('退出确认')
    expect(html).toContain('确定要退出吗？')
    expect(html).toContain('取消')
    expect(html).toContain('确认')
    // 关闭 X 由壳统一提供
    expect(html).toContain('aria-label="关闭"')
  })

  it('CreateModal：打开时渲染头部/正文/底部三段槽内容', async () => {
    const html = await render(KnowledgeCreateModal, { open: true, kind: 'local' })
    expect(html).toContain('ms-card')
    expect(html).toContain('新建知识库')
    expect(html).toContain('本地知识库')
    expect(html).toContain('产品资料库') // 名称输入框占位
    expect(html).toContain('创建')
    expect(html).toContain('取消')
  })

  it('CreateModal：关闭态不渲染壳（v-if 由 visible 驱动）', async () => {
    const html = await render(KnowledgeCreateModal, { open: false, kind: 'local' })
    expect(html).not.toContain('ms-mask')
    expect(html).not.toContain('新建知识库')
  })

  it('RenameModal：渲染标题/提示/当前值与按钮（Escape 由壳处理）', async () => {
    const html = await render(KnowledgeRenameModal, {
      open: true,
      title: '重命名文件',
      current: '旧名称.md',
      hint: '文件树以「/」分层，名称不能包含斜杠'
    })
    expect(html).toContain('ms-card')
    expect(html).toContain('重命名文件')
    expect(html).toContain('旧名称.md')
    expect(html).toContain('保存')
    expect(html).toContain('取消')
  })
})
