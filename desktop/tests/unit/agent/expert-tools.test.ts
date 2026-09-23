import { describe, expect, it } from 'vitest'
import { buildExpertTools } from '../../../src/main/agent/tools/DesktopToolRegistry'

describe('buildExpertTools（能力声明驱动）', () => {
  it('按能力声明启用本地工具', () => {
    const names = buildExpertTools([], undefined, null, [
      'document.assemble',
      'image.generate'
    ]).map((tool) => tool.name)

    expect(names).toContain('download_asset')
    expect(names).toContain('image_generate')
  })

  it('无能力声明时回退到工具名匹配（兼容存量专家）', () => {
    const names = buildExpertTools(['download_asset'], undefined, null).map((tool) => tool.name)
    expect(names).toEqual(['download_asset'])
  })

  it('未知能力不产生任何工具', () => {
    expect(buildExpertTools([], undefined, null, ['unknown.capability'])).toHaveLength(0)
  })

  it('视频创作专家（video.generate + document.assemble）能拿到素材工具', () => {
    // 视频成片与配图共用 download_asset；缺了它，视频专家只能自己执行 shell 命令下载
    const names = buildExpertTools([], undefined, null, [
      'video.generate',
      'document.assemble'
    ]).map((tool) => tool.name)

    expect(names).toEqual(['download_asset'])
  })

  it('仅声明 video.generate 时不产生本地工具（视频生成走 MCP）', () => {
    expect(buildExpertTools([], undefined, null, ['video.generate'])).toHaveLength(0)
  })
})
