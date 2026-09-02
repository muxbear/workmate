import { describe, expect, it } from 'vitest'
import {
  extractRemoteImageUrls,
  extractWorkspaceImagePaths
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
