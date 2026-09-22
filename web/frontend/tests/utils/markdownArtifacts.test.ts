import { describe, expect, it } from 'vitest'
import {
  buildImageSrcMap,
  normalizeImagePath,
  resolveArtifactImage,
  resolveImagePath,
  resolveImageSrc,
} from '@/utils/markdownArtifacts'

const BACKSLASH = String.fromCharCode(92)

describe('markdownArtifacts（文章配图相对路径 → 产物地址）', () => {
  it('归一化路径：解码百分号编码、统一斜杠、去掉查询串与锚点', () => {
    expect(normalizeImagePath('%E6%96%87%E7%AB%A0/figure-1.png?v=1')).toBe(
      '文章/figure-1.png',
    )
    expect(normalizeImagePath('文章' + BACKSLASH + 'figure-1.png')).toBe('文章/figure-1.png')
    expect(normalizeImagePath('文章/figure-1.png#top')).toBe('文章/figure-1.png')
  })

  it('相对路径按文档所在目录解析；超出虚拟根时返回空串', () => {
    expect(resolveImagePath('/artifacts/t1/turn-1/文章.md', '文章/figure-1.png')).toBe(
      '/artifacts/t1/turn-1/文章/figure-1.png',
    )
    expect(resolveImagePath('/artifacts/t1/turn-1/a/b.md', '../img/x.png')).toBe(
      '/artifacts/t1/turn-1/img/x.png',
    )
    // 相对文档路径继续向上回退会被裁剪到虚拟根内（命中与否由产物清单兜底）
    expect(resolveImagePath('/artifacts/t1/turn-1/文章.md', '../../escape.png')).toBe(
      '/artifacts/escape.png',
    )
    // 没有可弹出的层级时返回空串，交由调用方保留原值
    expect(resolveImagePath('文章.md', '../../escape.png')).toBe('')
    expect(resolveImagePath('/artifacts/t1/turn-1/文章.md', 'https://x/a.png')).toBe('')
  })

  it('命中产物时替换为产物下载地址', () => {
    const src = resolveImageSrc('文章/figure-1.png', {
      threadId: 't1',
      basePath: '/artifacts/t1/turn-1/文章.md',
      artifactPaths: ['/artifacts/t1/turn-1/文章/figure-1.png'],
    })
    expect(src).toContain('/chat/artifacts/t1/download')
    expect(src).toContain(encodeURIComponent('/artifacts/t1/turn-1/文章/figure-1.png'))
    expect(src).toContain('disposition=inline')
  })

  it('未命中产物保留原值；协议地址与缺省会话原样返回', () => {
    expect(
      resolveImageSrc('文章/missing.png', {
        threadId: 't1',
        basePath: '/artifacts/t1/turn-1/文章.md',
        artifactPaths: ['/artifacts/t1/turn-1/文章/figure-1.png'],
      }),
    ).toBe('文章/missing.png')

    expect(resolveImageSrc('https://cdn.example.com/a.png', { threadId: 't1' })).toBe(
      'https://cdn.example.com/a.png',
    )
    expect(resolveImageSrc('文章/figure-1.png', {})).toBe('文章/figure-1.png')
  })

  it('未提供产物清单时按解析结果兜底替换（预览先到、产物后到的场景）', () => {
    const src = resolveImageSrc('文章/figure-1.png', {
      threadId: 't1',
      basePath: '/artifacts/t1/turn-1/文章.md',
    })
    expect(src).toContain('/chat/artifacts/t1/download')
  })

  it('显式 apiBaseUrl 时按该基址拼接产物地址（与移动端 ArkTS 实现同规则）', () => {
    const src = resolveImageSrc('文章/figure-1.png', {
      threadId: 't1',
      basePath: '/artifacts/t1/turn-1/文章.md',
      apiBaseUrl: 'https://api.example.com/api',
    })
    expect(src).toBe(
      'https://api.example.com/api/chat/artifacts/t1/download?disposition=inline&path=' +
        encodeURIComponent('/artifacts/t1/turn-1/文章/figure-1.png'),
    )
  })

  it('buildImageSrcMap 只返回需要替换的项', () => {
    const map = buildImageSrcMap('![](文章/figure-1.png) ![](https://x/a.png)', {
      threadId: 't1',
      basePath: '/artifacts/t1/turn-1/文章.md',
      artifactPaths: ['/artifacts/t1/turn-1/文章/figure-1.png'],
    })
    expect(Object.keys(map)).toEqual(['文章/figure-1.png'])
    expect(map['文章/figure-1.png']).toContain('/chat/artifacts/t1/download')
  })
})
describe('resolveArtifactImage（配图 → 产物会话 + 虚拟路径）', () => {
  const context = {
    threadId: 't1',
    basePath: '/artifacts/t1/turn-1/文章.md',
    artifactPaths: ['/artifacts/t1/turn-1/文章/figure-1.png'],
  }

  it('命中产物清单时返回会话与产物路径（供带鉴权拉取字节使用）', () => {
    expect(resolveArtifactImage('文章/figure-1.png', context)).toEqual({
      threadId: 't1',
      path: '/artifacts/t1/turn-1/文章/figure-1.png',
    })
  })

  it('未命中产物清单 / 协议地址 / 缺省会话时返回 null', () => {
    expect(resolveArtifactImage('文章/missing.png', context)).toBeNull()
    expect(resolveArtifactImage('https://cdn.example.com/a.png', context)).toBeNull()
    expect(resolveArtifactImage('文章/figure-1.png', {})).toBeNull()
  })

  it('未提供产物清单时按解析结果兜底（预览先到、产物后到的场景）', () => {
    expect(
      resolveArtifactImage('文章/figure-1.png', {
        threadId: 't1',
        basePath: '/artifacts/t1/turn-1/文章.md',
      }),
    ).toEqual({ threadId: 't1', path: '/artifacts/t1/turn-1/文章/figure-1.png' })
  })
})
