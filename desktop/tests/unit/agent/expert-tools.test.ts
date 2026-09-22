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
})
