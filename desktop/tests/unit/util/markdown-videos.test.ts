import { describe, expect, it } from 'vitest'
import {
  extractWorkspaceVideoPaths,
  normalizeWorkspaceVideoPath,
  replaceWorkspaceVideoSrc
} from '../../../src/renderer/src/util/markdown-videos'

function video(relPath: string): string {
  const q = String.fromCharCode(34)
  return '<video controls src=' + q + relPath + q + '></video>'
}

describe('extractWorkspaceVideoPaths（工作区相对视频提取）', () => {
  it('提取 <video src> 相对路径并归一化查询参数', () => {
    const html = video('同名目录/成片-1.mp4') + ' ' + video('./视频目录/成片-2.mp4?x=1')
    expect(extractWorkspaceVideoPaths(html)).toEqual(['同名目录/成片-1.mp4', '视频目录/成片-2.mp4'])
  })

  it('忽略 http(s) 远程地址、绝对路径与 data URI', () => {
    const html =
      video('https://x.com/a.mp4') +
      ' ' +
      video('/abs/a.mp4') +
      ' ' +
      video('data:video/mp4;base64,xx')
    expect(extractWorkspaceVideoPaths(html)).toEqual([])
  })
})

describe('normalizeWorkspaceVideoPath', () => {
  it('去掉前导 ./ 与锚点/查询参数', () => {
    expect(normalizeWorkspaceVideoPath('./同名目录/成片-1.mp4?v=1#t=2')).toBe('同名目录/成片-1.mp4')
  })
})

describe('replaceWorkspaceVideoSrc（渲染后 HTML src 替换）', () => {
  it('把已解析的相对路径替换为 blob 地址', () => {
    const q = String.fromCharCode(34)
    const html = video('同名目录/成片-1.mp4')
    const out = replaceWorkspaceVideoSrc(html, {
      '同名目录/成片-1.mp4': 'blob:ke-work/abc'
    })
    expect(out).toContain('src=' + q + 'blob:ke-work/abc' + q)
  })

  it('未解析的地址保持原样', () => {
    const html = video('同名目录/成片-9.mp4')
    expect(replaceWorkspaceVideoSrc(html, {})).toBe(html)
  })

  it('支持 <video> 内嵌 <source src> 的写法（模型常用写法）', () => {
    const q = String.fromCharCode(34)
    const html =
      '<video controls width=' +
      q +
      '640' +
      q +
      ' preload=' +
      q +
      'metadata' +
      q +
      '>' +
      '<source src=' +
      q +
      '视频标题/成片-1.mp4' +
      q +
      ' type=' +
      q +
      'video/mp4' +
      q +
      '>你的浏览器不支持 HTML5 视频播放。' +
      '</video>'

    expect(extractWorkspaceVideoPaths(html)).toEqual(['视频标题/成片-1.mp4'])
    const out = replaceWorkspaceVideoSrc(html, { '视频标题/成片-1.mp4': 'blob:ke-work/src' })
    expect(out).toContain('src=' + q + 'blob:ke-work/src' + q)
    expect(out).not.toContain('src=' + q + '视频标题/成片-1.mp4' + q)
  })

  it('同时覆盖 video 自身 src 与内嵌 source 两种写法', () => {
    const q = String.fromCharCode(34)
    const mixed =
      video('甲/成片-1.mp4') +
      '<video controls><source src=' +
      q +
      '乙/成片-2.mp4' +
      q +
      ' type=' +
      q +
      'video/mp4' +
      q +
      '></video>'
    const map = { '甲/成片-1.mp4': 'blob:a', '乙/成片-2.mp4': 'blob:b' }
    const out = replaceWorkspaceVideoSrc(mixed, map)
    expect(out).toContain('blob:a')
    expect(out).toContain('blob:b')
  })
})
