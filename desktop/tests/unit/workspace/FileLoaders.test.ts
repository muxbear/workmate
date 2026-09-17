import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadFileText, MAX_BINARY_BYTES, MAX_TEXT_CHARS } from '../../../src/main/workspace/FileLoaders'
import { makeDocx, makePdf, makePptx, makePptxRaw, makeXlsx } from './file-fixtures'

/** 同 workspace-service.test.ts：先转 ASCII 名再删，绕开 Windows 中文名删除问题 */
function cleanupTree(dir: string): void {
  if (!existsSync(dir)) return
  for (const child of readdirSync(dir)) {
    const p = join(dir, child)
    try {
      const ascii = join(dir, `tmp-${child.codePointAt(0)}`)
      renameSync(p, ascii)
    } catch {
      // 已是 ASCII 名或删除失败，交给 rmSync 兜底
    }
  }
  rmSync(dir, { recursive: true, force: true })
}

describe('FileLoaders.loadFileText', () => {
  let dir: string

  beforeEach(() => {
    dir = join(tmpdir(), `ke-work-loaders-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
    mkdirSync(dir, { recursive: true })
  })

  afterEach(() => cleanupTree(dir))

  it('txt/md/json/xml/html 按 UTF-8 文本读取（含中文）', async () => {
    const path = join(dir, 'a.md')
    writeFileSync(path, '# 标题\n你好，ke-work', 'utf-8')
    const result = await loadFileText(path, 'md')
    expect(result.content).toContain('你好，ke-work')
    expect(result.truncated).toBe(false)
  })

  it('docx 提取正文文本', async () => {
    const path = join(dir, 'a.docx')
    writeFileSync(path, makeDocx('来自 docx 的正文'))
    const result = await loadFileText(path, 'docx')
    expect(result.content).toContain('来自 docx 的正文')
    expect(result.truncated).toBe(false)
  })

  it('xlsx 逐 sheet 提取为文本', async () => {
    const path = join(dir, 'a.xlsx')
    writeFileSync(path, makeXlsx())
    const result = await loadFileText(path, 'xlsx')
    expect(result.content).toContain('成绩')
    expect(result.content).toContain('张三')
    expect(result.content).toContain('90')
  })

  it('pptx 提取 slide 文本', async () => {
    const path = join(dir, 'a.pptx')
    writeFileSync(path, makePptx('来自 pptx 的幻灯片'))
    const result = await loadFileText(path, 'pptx')
    expect(result.content).toContain('来自 pptx 的幻灯片')
    expect(result.truncated).toBe(false)
  })

  it('pptx 文本 XML 实体反转义', async () => {
    const path = join(dir, 'b.pptx')
    writeFileSync(path, makePptx('A &amp; B &lt;C&gt;'))
    const result = await loadFileText(path, 'pptx')
    expect(result.content).toContain('A & B <C>')
  })

  it('pptx 含制表位段落的文本不泄漏 XML 标签', async () => {
    const path = join(dir, 'tab.pptx')
    writeFileSync(
      path,
      makePptxRaw(
        `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree><p:sp><p:txBody>
<a:p><a:pPr><a:tabLst><a:tab pos="914400"/></a:tabLst></a:pPr><a:r><a:t>名字</a:t></a:r></a:p>
</p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`
      )
    )
    const result = await loadFileText(path, 'pptx')
    expect(result.content).toContain('名字')
    expect(result.content).not.toContain('<')
    expect(result.content).not.toContain('pPr')
  })

  it('pdf 提取文本', async () => {
    const path = join(dir, 'a.pdf')
    writeFileSync(path, makePdf('Hello PDF'))
    const result = await loadFileText(path, 'pdf')
    expect(result.content).toContain('Hello PDF')
  })

  it('ppt 旧格式返回不支持', async () => {
    const path = join(dir, 'a.ppt')
    writeFileSync(path, Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))
    await expect(loadFileText(path, 'ppt')).rejects.toThrow(/暂不支持/)
  })

  it('>20MB 二进制文档报文件过大', async () => {
    const path = join(dir, 'big.docx')
    writeFileSync(path, Buffer.alloc(MAX_BINARY_BYTES + 1, 1))
    await expect(loadFileText(path, 'docx')).rejects.toThrow(/文件过大/)
  })

  it('>20MB xlsx 报文件过大', async () => {
    const path = join(dir, 'big.xlsx')
    writeFileSync(path, Buffer.alloc(MAX_BINARY_BYTES + 1, 1))
    await expect(loadFileText(path, 'xlsx')).rejects.toThrow(/文件过大/)
  })

  it('>20MB pdf 报文件过大', async () => {
    const path = join(dir, 'big.pdf')
    writeFileSync(path, Buffer.alloc(MAX_BINARY_BYTES + 1, 1))
    await expect(loadFileText(path, 'pdf')).rejects.toThrow(/文件过大/)
  })

  it('docx 提取文本超过 200KB 截断并置 truncated', async () => {
    const path = join(dir, 'long.docx')
    writeFileSync(path, makeDocx('x'.repeat(MAX_TEXT_CHARS + 1024)))
    const result = await loadFileText(path, 'docx')
    expect(result.truncated).toBe(true)
    expect(result.content.length).toBeLessThanOrEqual(MAX_TEXT_CHARS)
  })

  it('未知扩展名含 NUL 拒绝（二进制嗅探兜底）', async () => {
    const path = join(dir, 'img.bin')
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x00, 0x0a, 0x01]))
    await expect(loadFileText(path, 'bin')).rejects.toThrow(/二进制/)
  })

  it('纯文本分页续读：按游标拼接可读完整篇且不产生乱码', async () => {
    const path = join(dir, 'big.md')
    const text = '汉字'.repeat(3000)
    writeFileSync(path, text, 'utf-8')
    const first = await loadFileText(path, 'md', { maxChars: 1000 })
    expect(first.truncated).toBe(true)
    expect(first.cursor).toBeGreaterThan(0)
    let content = first.content
    let cursor = first.cursor
    let guard = 0
    while (cursor !== undefined && guard < 200) {
      guard += 1
      const page = await loadFileText(path, 'md', { cursor, maxChars: 1000 })
      content += page.content
      cursor = page.cursor
      if (!page.truncated) break
    }
    expect(content).toBe(text)
    expect(content).not.toContain(String.fromCharCode(0xfffd))
  })

  it('docx 分页续读：cursor 为字符偏移，拼接后为完整文本', async () => {
    const path = join(dir, 'paged.docx')
    const body = 'x'.repeat(MAX_TEXT_CHARS + 512)
    writeFileSync(path, makeDocx(body))
    const first = await loadFileText(path, 'docx', { maxChars: 1024 })
    expect(first.truncated).toBe(true)
    expect(first.cursor).toBe(1024)
    expect(first.totalChars).toBeGreaterThanOrEqual(body.length)
    const rest = await loadFileText(path, 'docx', { cursor: first.cursor, maxChars: 1024 * 1024 })
    expect(rest.truncated).toBe(false)
    // docx 抽取可能附带尾部换行，这里按抽取总长度校验拼接结果完整
    const all = first.content + rest.content
    expect(all.length).toBe(first.totalChars)
    expect(all.startsWith(body)).toBe(true)
  })

})
