import { describe, expect, it } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import CloseConfirmDialog from '../../../src/renderer/src/components/CloseConfirmDialog.vue'

/**
 * 关闭确认弹窗（主窗口首次点 ✕ 时的询问框）SSR 渲染验证。
 *
 * 钉住：两个行为选项 + 取消按钮文案、托盘语义提示，以及 z-index 2000 的叠层约定
 * （必须盖过设置浮层 50/60、下拉菜单 100/101、重命名遮罩 200、滑块验证 1000）。
 * 显隐由父级 v-if 控制（App.vue 卸载即移除 DOM，不依赖隐藏窗口下被暂停的过渡渲染），
 * 组件本身始终以 visible=true 渲染外壳。
 */

async function render(): Promise<string> {
  const app = createSSRApp(CloseConfirmDialog as never, {})
  return renderToString(app)
}

describe('CloseConfirmDialog', () => {
  it('标题/正文/两个行为选项/取消经壳渲染', async () => {
    const html = await render()
    expect(html).toContain('ms-mask')
    expect(html).toContain('ms-card')
    expect(html).toContain('关闭窗口')
    expect(html).toContain('点击关闭按钮时，您希望：')
    expect(html).toContain('最小化到托盘')
    expect(html).toContain('直接关闭窗口')
    expect(html).toContain('取消')
    // 提示后续可修改（首次询问后不再弹出的安抚文案）
    expect(html).toContain('之后不再询问')
    // 托盘语义提示（任务栏右下角图标）
    expect(html).toContain('任务栏右下角')
    // 关闭 X 由壳统一提供
    expect(html).toContain('aria-label="关闭"')
  })

  it('叠层：遮罩 z-index 2000（压过设置浮层/菜单/重命名遮罩）', async () => {
    const html = await render()
    expect(html).toMatch(/z-index:\s*2000/)
  })
})
