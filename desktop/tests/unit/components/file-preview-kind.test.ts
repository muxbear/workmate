import { describe, expect, it } from 'vitest'
import {
  getFileExt,
  needsBytes,
  pickPreviewKind,
  unsupportedHint
} from '../../../src/renderer/src/components/file-preview/previewKind'

describe('文件预览类型判定（知识库与工作空间共用）', () => {
  it('按扩展名分发到对应渲染方式', () => {
    expect(pickPreviewKind('需求说明.md')).toBe('markdown')
    expect(pickPreviewKind('README.MARKDOWN')).toBe('markdown')
    expect(pickPreviewKind('数据.json')).toBe('text')
    expect(pickPreviewKind('访谈.csv')).toBe('text')
    expect(pickPreviewKind('配图.PNG')).toBe('image')
    expect(pickPreviewKind('方案.pdf')).toBe('pdf')
    expect(pickPreviewKind('教案.docx')).toBe('word')
    expect(pickPreviewKind('归档.zip')).toBe('unsupported')
    expect(pickPreviewKind('无扩展名')).toBe('unsupported')
  })

  it('扩展名提取的边界情况', () => {
    expect(getFileExt('a.b.c')).toBe('c')
    expect(getFileExt('.gitignore')).toBe('')
    expect(getFileExt('')).toBe('')
  })

  it('needsBytes 只对图片 / PDF / Word 为真', () => {
    expect(needsBytes('image')).toBe(true)
    expect(needsBytes('pdf')).toBe(true)
    expect(needsBytes('word')).toBe(true)
    expect(needsBytes('markdown')).toBe(false)
    expect(needsBytes('text')).toBe(false)
    expect(needsBytes('unsupported')).toBe(false)
  })

  it('不支持预览时给出带扩展名的提示', () => {
    expect(unsupportedHint('a.bin')).toContain('.bin')
    expect(unsupportedHint('noext')).toContain('该文件类型')
  })
})
