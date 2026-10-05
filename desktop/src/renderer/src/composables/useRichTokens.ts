import type { MessagePart } from '../../../shared/contracts'
import type { SkillItem } from '@store/catalog'

/**
 * 富输入 token 工具（R6：自 PromptInput 外提并合并两套 token 插入）。
 *
 * 输入框是 contenteditable，技能 / 文件以 token 元素承载：
 * - `.skill-token`：`data-skill-id` + `data-name`，序列化为 `/技能名` 文本段；
 * - `.file-token`：`data-path` + title（绝对路径），序列化为 `{type:'file',path}` 部件。
 *
 * 提取前 `insertSkillTokenAtCaret` 与 `insertFileTokenAtCaret` 的光标定位、
 * 插入、选区恢复、文本同步四处逐字重复，现合并为 `insertTokenAtCaret` 一处。
 *
 * **DOM 结构即契约**：类名 / data 属性 / 子元素结构被 serializeInput、
 * 组件样式与 e2e 选择器（.skill-token/.file-token）共同依赖，改动需同步三处。
 */

/** 相邻文本段合并（减少 parts 数量；文件段自然分隔） */
export function pushTextPart(parts: MessagePart[], text: string): void {
  const last = parts[parts.length - 1]
  if (last && last.type === 'text') last.text += text
  else parts.push({ type: 'text', text })
}

/** 序列化输入框 DOM → 保序消息部件：文本节点原样；技能 token → /技能名；文件 token → {type:'file',path} */
export function serializeInput(el: HTMLElement): MessagePart[] {
  const parts: MessagePart[] = []
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent ?? ''
      if (t) pushTextPart(parts, t)
    } else if (node instanceof HTMLElement && node.classList.contains('skill-token')) {
      pushTextPart(parts, '/' + (node.dataset.name ?? node.textContent ?? ''))
    } else if (node instanceof HTMLElement && node.classList.contains('file-token')) {
      const path = node.dataset.path
      if (path) parts.push({ type: 'file', path })
    } else if (node.nodeName === 'BR') {
      pushTextPart(parts, '\n')
    } else if (node instanceof HTMLElement) {
      const t = node.textContent ?? ''
      if (t) pushTextPart(parts, t)
    }
  }
  return parts
}

/** 技能 token（图标 + 名称 + 删除叉；图标底色随技能色） */
export function createSkillToken(skill: SkillItem): HTMLElement {
  const token = document.createElement('span')
  token.className = 'skill-token'
  token.dataset.skillId = String(skill.id)
  token.dataset.name = skill.name
  token.contentEditable = 'false'
  const icon = document.createElement('span')
  icon.className = 'skill-token-icon'
  icon.style.background = skill.color
  const flash = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  flash.setAttribute('width', '9')
  flash.setAttribute('height', '9')
  flash.setAttribute('viewBox', '0 0 24 24')
  flash.setAttribute('fill', 'none')
  flash.setAttribute('stroke', 'white')
  flash.setAttribute('stroke-width', '3')
  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon')
  poly.setAttribute('points', '13 2 3 14 12 14 11 22 21 10 12 10 13 2')
  flash.appendChild(poly)
  const del = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  del.classList.add('skill-token-del')
  del.setAttribute('width', '10')
  del.setAttribute('height', '10')
  del.setAttribute('viewBox', '0 0 24 24')
  del.setAttribute('fill', 'none')
  del.setAttribute('stroke', 'white')
  del.setAttribute('stroke-width', '2.5')
  del.setAttribute('stroke-linecap', 'round')
  const l1 = document.createElementNS('http://www.w3.org/2000/svg', 'line')
  l1.setAttribute('x1', '18')
  l1.setAttribute('y1', '6')
  l1.setAttribute('x2', '6')
  l1.setAttribute('y2', '18')
  const l2 = document.createElementNS('http://www.w3.org/2000/svg', 'line')
  l2.setAttribute('x1', '6')
  l2.setAttribute('y1', '6')
  l2.setAttribute('x2', '18')
  l2.setAttribute('y2', '18')
  del.appendChild(l1)
  del.appendChild(l2)
  icon.appendChild(flash)
  icon.appendChild(del)
  const name = document.createElement('span')
  name.className = 'skill-token-name'
  name.textContent = skill.name
  token.appendChild(icon)
  token.appendChild(name)
  return token
}

/** 构造文件 token（图标 + 文件名；title 原生提示绝对路径） */
export function createFileToken(filePath: string): HTMLElement {
  const token = document.createElement('span')
  token.className = 'file-token'
  token.dataset.path = filePath
  token.title = filePath // 悬停显示绝对路径（原生 tooltip）
  token.contentEditable = 'false'
  const icon = document.createElement('span')
  icon.className = 'file-token-icon'
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '10')
  svg.setAttribute('height', '10')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute(
    'd',
    'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'
  )
  svg.appendChild(path)
  const del = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  del.classList.add('file-token-del')
  del.setAttribute('width', '10')
  del.setAttribute('height', '10')
  del.setAttribute('viewBox', '0 0 24 24')
  del.setAttribute('fill', 'none')
  del.setAttribute('stroke', 'currentColor')
  del.setAttribute('stroke-width', '2.5')
  del.setAttribute('stroke-linecap', 'round')
  const l1 = document.createElementNS('http://www.w3.org/2000/svg', 'line')
  l1.setAttribute('x1', '18')
  l1.setAttribute('y1', '6')
  l1.setAttribute('x2', '6')
  l1.setAttribute('y2', '18')
  const l2 = document.createElementNS('http://www.w3.org/2000/svg', 'line')
  l2.setAttribute('x1', '6')
  l2.setAttribute('y1', '6')
  l2.setAttribute('x2', '18')
  l2.setAttribute('y2', '18')
  del.appendChild(l1)
  del.appendChild(l2)
  icon.appendChild(svg)
  icon.appendChild(del)
  const name = document.createElement('span')
  name.className = 'file-token-name'
  name.textContent = filePath.split(/[\\/]/).pop() || filePath
  token.appendChild(icon)
  token.appendChild(name)
  return token
}

export interface RichTokensDeps {
  /** token 插入 / 移除后同步纯文本快照（组件把 el.innerText 写回 v-model 与字数） */
  syncText: (text: string) => void
}

/** 光标处插入辅助（合并点的光标逻辑）：无有效光标时取容器末尾 */
function insertTokenAtCaretInternal(el: HTMLElement, node: HTMLElement, deps: RichTokensDeps): void {
  const sel = window.getSelection()
  let range: Range
  if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
    range = sel.getRangeAt(0)
    range.collapse(false)
  } else {
    range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
  }
  range.insertNode(node)
  range.setStartAfter(node)
  range.collapse(true)
  sel?.removeAllRanges()
  sel?.addRange(range)
  deps.syncText(el.innerText)
}

export function useRichTokens(deps: RichTokensDeps): {
  /** 在光标处插入技能 token（图标 + 名称），光标移到 token 后 */
  insertSkillTokenAtCaret: (el: HTMLElement, skill: SkillItem) => void
  /** 在光标处插入文件 token（图标 + 文件名），光标移到 token 后 */
  insertFileTokenAtCaret: (el: HTMLElement, filePath: string) => void
  /** 从 DOM 移除第一个指定技能的 token */
  removeSkillTokenFromDom: (el: HTMLElement, id: string) => void
} {
  const insertSkillTokenAtCaret = (el: HTMLElement, skill: SkillItem): void => {
    insertTokenAtCaretInternal(el, createSkillToken(skill), deps)
  }

  const insertFileTokenAtCaret = (el: HTMLElement, filePath: string): void => {
    insertTokenAtCaretInternal(el, createFileToken(filePath), deps)
  }

  const removeSkillTokenFromDom = (el: HTMLElement, id: string): void => {
    for (const node of Array.from(el.children)) {
      if (node instanceof HTMLElement && node.classList.contains('skill-token')) {
        if (node.dataset.skillId === id) {
          node.remove()
          break
        }
      }
    }
    deps.syncText(el.innerText)
  }

  return { insertSkillTokenAtCaret, insertFileTokenAtCaret, removeSkillTokenFromDom }
}
