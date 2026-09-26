import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 无障碍回归防线（迭代 6 T6.6）。
 *
 * **为什么是测试而不是 ESLint**：`package.json` 里声明了 `"lint": "eslint ."`，但
 * ESLint **根本没装**（`node_modules` 里没有、也没有任何配置文件）——那个脚本今天
 * 就跑不起来。装齐 ESLint + vue + a11y 插件是独立工程，本轮用一条测试顶住回归。
 *
 * 覆盖两件实测出来的事：图标按钮**没有可访问名字**（此前 154 个里 1 个有 aria-label、
 * 98 个只有 title、55 个两者皆无），以及可点非按钮元素**键盘到不了**（全站 98 个里
 * 只有 1 个可键盘操作）。
 */

const SRC = join(process.cwd(), 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.vue')) out.push(p)
  }
  return out
}

/**
 * 找出所有 `<button …>` 开标签的边界。
 *
 * 关键：属性值里可能出现 `>`（如 `:disabled="count > 0"`），必须跳过引号内的字符，
 * 否则会把标签截断——按错误边界插入属性会改坏模板（此前一次脚本化改动用
 * `<button\b([^>]*)>` 就改坏了 59 个文件、6 个测试文件直接挂掉）。
 */
function findButtonTags(src: string): { attrsStart: number; attrsEnd: number; bodyStart: number }[] {
  const out: { attrsStart: number; attrsEnd: number; bodyStart: number }[] = []
  const re = /<button\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length
    let quote: string | null = null
    while (i < src.length) {
      const c = src[i]
      if (quote) {
        if (c === quote) quote = null
      } else if (c === '"' || c === "'") quote = c
      else if (c === '>') break
      i++
    }
    if (i >= src.length) break
    out.push({ attrsStart: m.index + m[0].length, attrsEnd: i, bodyStart: i + 1 })
  }
  return out
}

/** 内容只有自闭合组件标签（即"纯图标"）才算图标按钮 */
const ICON_ONLY = /^\s*(<[A-Z][A-Za-z0-9]*\b[^>]*\/>\s*)+$/

interface Violation {
  file: string
  line: number
  detail: string
}

function scanIconButtons(scope: string): Violation[] {
  const bad: Violation[] = []
  for (const file of walk(scope)) {
    const src = readFileSync(file, 'utf8')
    for (const t of findButtonTags(src)) {
      const attrs = src.slice(t.attrsStart, t.attrsEnd)
      const close = src.indexOf('</button>', t.bodyStart)
      if (close < 0) continue
      const inner = src.slice(t.bodyStart, close)
      if (!ICON_ONLY.test(inner)) continue
      if (/\baria-label\s*=/.test(attrs)) continue
      bad.push({
        file: file.slice(SRC.length + 1),
        line: src.slice(0, t.attrsStart).split('\n').length,
        detail: '纯图标按钮没有 aria-label',
      })
    }
  }
  return bad
}

function format(bad: Violation[]): string {
  return bad.map((b) => `  ${b.file}:${b.line} ${b.detail}`).join('\n')
}

describe('无障碍', () => {
  it('图标按钮都有可访问名字', () => {
    const bad = scanIconButtons(SRC)
    expect(
      bad,
      `以下图标按钮没有 aria-label——读屏软件只会念出"按钮"，用户不知道它做什么：\n${format(bad)}`,
    ).toEqual([])
  })

  it('知识库模块的可点非按钮元素键盘可达', () => {
    const kbDir = join(SRC, 'components/knowledgeBase')
    const bad: Violation[] = []
    for (const file of walk(kbDir)) {
      const src = readFileSync(file, 'utf8')
      // 只看"有实际动作"的点击：.self 是遮罩关闭、`: @click.stop` 不带值的是阻止冒泡
      const re = /<((?:div|span|td|li|tr)\b)([^>]*?)>/gs
      let m: RegExpExecArray | null
      while ((m = re.exec(src))) {
        const tag = m[1]
        const attrs = m[2]
        if (!/@click(\.\w+)*(?=\s*=)/.test(attrs)) continue
        if (/@click\.self/.test(attrs)) continue
        // 有 @click 但没有任何赋值（纯阻止冒泡）的跳过
        if (/@click(\.\w+)*\s*(?=>)/.test(attrs)) continue
        if (/tabindex/.test(attrs)) continue
        bad.push({
          file: file.slice(SRC.length + 1),
          line: src.slice(0, m.index).split('\n').length,
          detail: `<${tag}> 可点击但没有 tabindex，键盘用户到不了`,
        })
      }
    }
    expect(bad, `以下元素鼠标能点、键盘到不了：\n${format(bad)}`).toEqual([])
  })

  it('sr-only 工具类存在且不把内容移出无障碍树', () => {
    const css = readFileSync(join(SRC, 'assets/styles/main.css'), 'utf8')
    expect(css).toContain('.sr-only')
    // display:none / visibility:hidden 会让读屏软件也看不到，等于没写
    const rule = css.slice(css.indexOf('.sr-only'))
    expect(rule.slice(0, 300)).not.toMatch(/display:\s*none|visibility:\s*hidden/)
  })
})
