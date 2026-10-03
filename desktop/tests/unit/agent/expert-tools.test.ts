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

  it('仅声明 web.search 时不产生本地工具（联网检索走 MCP 服务）', () => {
    // 「互联网信息检索专家」只声明 web.search：三端统一走「联网搜索」MCP 服务，
    // 该服务自带多源回退；桌面端没有、也不需要本地检索实现。
    expect(buildExpertTools([], undefined, null, ['web.search'])).toHaveLength(0)
  })
})

describe('buildExpertTools × 本地知识库（knowledge.search）', () => {
  const knowledge = {
    retrievalProvider: () => null,
    listBases: () => []
  }

  it('声明 knowledge.search 且提供依赖：注册 kb_search 与 list_knowledge_bases', () => {
    const names = buildExpertTools([], undefined, null, ['knowledge.search'], { knowledge }).map(
      (tool) => tool.name
    )
    expect(names).toContain('kb_search')
    expect(names).toContain('list_knowledge_bases')
  })

  it('未提供依赖时不注册（不制造「看起来有、点进去报错」的假能力）', () => {
    const names = buildExpertTools([], undefined, null, ['knowledge.search']).map(
      (tool) => tool.name
    )
    expect(names).toEqual([])
  })

  it('存量专家按工具名匹配也能拿到（兼容 toolNames 写法）', () => {
    const names = buildExpertTools(['kb_search'], undefined, null, [], { knowledge }).map(
      (tool) => tool.name
    )
    expect(names).toContain('kb_search')
  })
})
