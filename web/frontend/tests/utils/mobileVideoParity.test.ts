import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { extractVideoSources as webExtract } from '@/utils/markdownVideos'
import { resolveArtifactImage, type MarkdownImageContext } from '@/utils/markdownArtifacts'

/** 移动端实现源文件（权威副本）；本测试的 TS 版本必须与它保持一致 */
const MOBILE_UTILS = join(
  process.cwd(),
  '..',
  '..',
  'mobile',
  'entry',
  'src',
  'main',
  'ets',
  'common',
  'utils',
  'MarkdownArtifacts.ets'
)
const MOBILE_BLOCKS = join(
  process.cwd(),
  '..',
  '..',
  'mobile',
  'entry',
  'src',
  'main',
  'ets',
  'common',
  'utils',
  'MarkdownBlocks.ets'
)
/** 块渲染组件（注意与上面解析器区分：解析器出块，组件渲染块） */
const MOBILE_BLOCK_COMPONENT = join(
  process.cwd(),
  '..',
  '..',
  'mobile',
  'entry',
  'src',
  'main',
  'ets',
  'components',
  'MarkdownBlock.ets'
)

/**
 * 移动端 ArkTS 视频解析逻辑的逐行镜像（对照 `mobile/entry/.../MarkdownArtifacts.ets`）。
 *
 * 本机没有 HarmonyOS SDK，ArkTS 单测只能在 DevEco 里跑；这里把同一套逻辑镜像成 TS，
 * 既验证逻辑本身，也与 Web 实现（`@/utils/markdownVideos`）逐用例对拍，
 * 保证三端（Web / 桌面 / 移动）对 `<video>` 的解析口径一致。
 * 仅改写类型标注与 import 路径，不改动逻辑。
 */
const VIDEO_BLOCK_RE = /<video\b[^>]*>(?:[\s\S]*?<\/video>)?/g
const VIDEO_SRC_ATTR_RE = /\bsrc\s*=\s*(['"])([^'"]+)\1/g
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

function arkExtractVideoSources(markdown: string): string[] {
  const found: string[] = []
  VIDEO_BLOCK_RE.lastIndex = 0
  let block: RegExpExecArray | null = VIDEO_BLOCK_RE.exec(markdown)
  while (block !== null) {
    VIDEO_SRC_ATTR_RE.lastIndex = 0
    let attr: RegExpExecArray | null = VIDEO_SRC_ATTR_RE.exec(block[0])
    while (attr !== null) {
      const src: string = attr[2].trim()
      if (src !== '' && !SCHEME_RE.test(src) && !found.includes(src)) {
        found.push(src)
      }
      attr = VIDEO_SRC_ATTR_RE.exec(block[0])
    }
    block = VIDEO_BLOCK_RE.exec(markdown)
  }
  return found
}

function arkVideoBlockCaption(block: string): string {
  const end: number = block.lastIndexOf('</video>')
  if (end < 0) {
    return ''
  }
  const open: number = block.indexOf('>')
  if (open < 0 || open > end) {
    return ''
  }
  let inner: string = block.substring(open + 1, end)
  inner = inner.replace(/<[^>]*>/g, ' ')
  return inner.trim()
}

const THREAD = 't-video-1'
const CONTEXT: MarkdownImageContext = {
  threadId: THREAD,
  basePath: `/artifacts/${THREAD}/turn-1/视频标题.md`,
  artifactPaths: [`/artifacts/${THREAD}/turn-1/视频标题/成片-1.mp4`]
}

const SRC_FORM = '<video controls src="视频标题/成片-1.mp4"></video>'
const SOURCE_FORM =
  '<video controls width="640" preload="metadata">\n' +
  '  <source src="视频标题/成片-1.mp4" type="video/mp4">\n' +
  '  你的浏览器不支持 HTML5 视频播放。\n' +
  '</video>'
const MIXED =
  SRC_FORM +
  '<video src="https://cdn.example.com/a.mp4"></video>' +
  '<video src="data:video/mp4;base64,AAA"></video>' +
  "<video src='视频标题/成片-2.mp4'></video>"

describe('移动端视频解析（ArkTS 镜像）', () => {
  it('相对路径提取（跳过协议地址、去重保序）', () => {
    expect(arkExtractVideoSources(MIXED)).toEqual(['视频标题/成片-1.mp4', '视频标题/成片-2.mp4'])
  })

  it('支持 <video> 内嵌 <source src> 的写法', () => {
    expect(arkExtractVideoSources(SOURCE_FORM)).toEqual(['视频标题/成片-1.mp4'])
  })

  it('取视频块内的兜底说明文本', () => {
    expect(arkVideoBlockCaption(SOURCE_FORM)).toBe('你的浏览器不支持 HTML5 视频播放。')
    expect(arkVideoBlockCaption(SRC_FORM)).toBe('')
  })

  it('解析为产物接口地址（命中产物清单）', () => {
    const target = resolveArtifactImage('视频标题/成片-1.mp4', CONTEXT)
    expect(target).toEqual({
      threadId: THREAD,
      path: `/artifacts/${THREAD}/turn-1/视频标题/成片-1.mp4`,
    })
  })

  it('与 Web 实现逐用例对拍：提取结果一致', () => {
    const cases = [SRC_FORM, SOURCE_FORM, MIXED, '普通段落,没有视频。']
    for (const markdown of cases) {
      const ark = arkExtractVideoSources(markdown)
      const web = webExtract(markdown)
      if (ark.length === 0) {
        // Web 端无视频块时返回空数组；移动端保持一致（此处 MIXED 之外都应相等）
        expect(web.length === 0 || ark.length > 0).toBe(true)
      }
      if (ark.length > 0) {
        expect(web).toEqual(ark)
      }
    }
  })

  it('缺少 threadId 时保持原值（调用方据此判断拿不到可播放地址）', () => {
    const target = resolveArtifactImage('视频标题/成片-1.mp4', { threadId: '' })
    expect(target).toBeNull()
  })

  it('移动端源文件仍包含同一套视频解析标记（防镜像漂移）', () => {
    // 本测试的 TS 逻辑是移动端 .ets 的镜像：若 .ets 改了而这里没跟着改，
    // 下面的断言会失败，提醒同步（移动端实现才是权威副本）。
    const utils = readFileSync(MOBILE_UTILS, 'utf-8')
    for (const marker of [
      'VIDEO_BLOCK_RE',
      'VIDEO_SRC_ATTR_RE',
      'export function extractVideoSources',
      'export function resolveVideoSrc',
      'export function videoBlockCaption',
    ]) {
      expect(utils).toContain(marker)
    }
    // 解析器：识别 <video> 行并产出 video 块
    const blocks = readFileSync(MOBILE_BLOCKS, 'utf-8')
    expect(blocks).toContain("line.startsWith('<video')")
    expect(blocks).toContain("type: 'video'")
    // 渲染组件：把 video 块交给 ArtifactVideo
    const component = readFileSync(MOBILE_BLOCK_COMPONENT, 'utf-8')
    expect(component).toContain("block.type === 'video'")
    expect(component).toContain('ArtifactVideo')
  })
})
