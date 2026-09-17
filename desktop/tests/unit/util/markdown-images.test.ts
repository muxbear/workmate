import { describe, expect, it } from 'vitest'
import {
  decodeImagePath,
  extractRemoteImageUrls,
  extractWorkspaceImagePaths,
  normalizeWorkspaceImagePath,
  resolveMarkdownRelativePath
} from '../../../src/renderer/src/util/markdown-images'

describe('extractRemoteImageUrls（Markdown/HTML 远程图片提取）', () => {
  it('提取 Markdown 图片外链并去重保序', () => {
    const md =
      '![a](https://x.com/1.png) 正文 ![b](https://x.com/2.png?x=1&y=%E6%98%A5) ![c](https://x.com/1.png)'
    expect(extractRemoteImageUrls(md)).toEqual([
      'https://x.com/1.png',
      'https://x.com/2.png?x=1&y=%E6%98%A5'
    ])
  })

  it('忽略 data/blob/相对路径等非 http(s) 图片', () => {
    const md = '![d](data:image/png;base64,xx) ![e](blob:https://x/1) ![f](/local/a.png)'
    expect(extractRemoteImageUrls(md)).toEqual([])
  })

  it('提取 HTML img 外链（html 内容类型兜底）', () => {
    const html =
      '<p>hi</p><img src="https://x.com/a.png" alt="a"><img src="data:image/png;base64,y" />'
    expect(extractRemoteImageUrls(html)).toEqual(['https://x.com/a.png'])
  })
})

describe('extractWorkspaceImagePaths（工作区相对图片提取）', () => {
  it('提取相对路径并归一化 ./ 与查询参数', () => {
    const md =
      '![a](images/figure-1.png) 正文 ![b](./images/figure-2.png?x=1) ![c](data:image/png;base64,xx)'
    expect(extractWorkspaceImagePaths(md)).toEqual([
      'images/figure-1.png',
      'images/figure-2.png'
    ])
  })

  it('忽略 http(s) 远程图片与绝对路径引用', () => {
    const md = '![x](https://x.com/a.png) ![y](/abs/a.png) ![z](blob:https://x/1)'
    expect(extractWorkspaceImagePaths(md)).toEqual([])
  })
})

describe('decodeImagePath / resolveMarkdownRelativePath（Markdown 相对图片路径解析）', () => {
  it('解码百分号编码的中文与空格路径', () => {
    expect(decodeImagePath('images/%E5%9B%BE%201.png')).toBe('images/图 1.png')
    // 非法编码原样返回，避免解析异常影响整篇渲染
    expect(decodeImagePath('images/100%.png')).toBe('images/100%.png')
  })

  it('反斜杠路径按正斜杠归一（兼容 Windows 写法）', () => {
    const bs = String.fromCharCode(92)
    const raw = '.' + bs + 'DeepAgents-1.x.assets' + bs + 'x.png'
    expect(normalizeWorkspaceImagePath(raw)).toBe('DeepAgents-1.x.assets/x.png')
  })

  it('以 Markdown 文件所在目录为基准解析相对路径', () => {
    expect(resolveMarkdownRelativePath('a.md', './DeepAgents-1.x.assets/x.png')).toBe(
      'DeepAgents-1.x.assets/x.png'
    )
    expect(resolveMarkdownRelativePath('docs/guide/a.md', '../img/x.png')).toBe('docs/img/x.png')
    expect(resolveMarkdownRelativePath('docs/a.md', 'assets/x.png')).toBe('docs/assets/x.png')
  })

  it('绝对路径、协议地址与越界路径返回空串', () => {
    expect(resolveMarkdownRelativePath('a.md', '/abs/x.png')).toBe('')
    expect(resolveMarkdownRelativePath('a.md', 'https://x.com/a.png')).toBe('')
    expect(resolveMarkdownRelativePath('docs/a.md', '../../x.png')).toBe('')
  })
})
