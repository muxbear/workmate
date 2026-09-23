import { describe, expect, it } from 'vitest'
import {
  DOC_EXTENSIONS,
  artifactPreviewKind,
  extractDocArtifactsFromText,
  isDocExt
} from '../../../src/main/agent/doc-artifacts'

describe('doc-artifacts（消息产物识别）', () => {
  it('视频扩展名纳入白名单并映射为 video 预览类型', () => {
    // 成片必须和文档一样成为"消息产物"，否则对话里没有任何播放入口（方案 D-4）
    for (const ext of ['mp4', 'webm', 'mov']) {
      expect(DOC_EXTENSIONS.has(ext)).toBe(true)
      expect(isDocExt(ext)).toBe(true)
      expect(artifactPreviewKind(ext)).toBe('video')
    }
    expect(artifactPreviewKind('md')).toBe('text')
    expect(artifactPreviewKind('docx')).toBe('word')
    expect(artifactPreviewKind('pdf')).toBe('pdf')
  })

  it('从回复文本中识别成片相对路径', () => {
    const text = [
      '短视频',
      '路径：/橘猫窗台打哈欠-3/成片-1.mp4',
      '说明文档 路径：橘猫窗台打哈欠.md'
    ].join('\n')

    const artifacts = extractDocArtifactsFromText(text, 'E:\\temp\\Ke-Work')
    const paths = artifacts.map((item) => item.relPath)
    expect(paths).toContain('橘猫窗台打哈欠-3/成片-1.mp4')
    expect(paths).toContain('橘猫窗台打哈欠.md')
    expect(artifacts.find((item) => item.ext === 'mp4')?.name).toBe('成片-1.mp4')
  })

  it('临时下载地址不会被误登记为产物', () => {
    // 视频签名链接以 https 开头，若误登记会在产物区出现打不开的条目
    const text =
      '临时下载地址：https://dashscope-a717.oss-accelerate.aliyuncs.com/1d/ac/20260923/x.mp4?Expires=1&Signature=abc\n' +
      '或 //cdn.example.com/y.mp4'
    expect(extractDocArtifactsFromText(text, 'E:\\temp\\Ke-Work')).toEqual([])
  })

  it('绝对路径仅在落在工作区内时转为相对路径', () => {
    const inside = extractDocArtifactsFromText('E:\\temp\\Ke-Work\\标题\\成片-1.mp4', 'E:\\temp\\Ke-Work')
    expect(inside.map((item) => item.relPath)).toEqual(['标题/成片-1.mp4'])

    const outside = extractDocArtifactsFromText('D:\\other\\成片-1.mp4', 'E:\\temp\\Ke-Work')
    expect(outside).toEqual([])
  })

  it('拒绝 .. 穿越路径', () => {
    expect(extractDocArtifactsFromText('../escape/成片-1.mp4', 'E:\\temp\\Ke-Work')).toEqual([])
  })
})
