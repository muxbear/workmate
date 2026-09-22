/**
 * 专家能力契约（TS 侧镜像）。
 *
 * 与 Python 侧 `web/backend/src/agent/experts/capabilities.py`、仓库契约文件
 * `packages/expert-contract/contract.json` 三处保持一致；
 * `tests/unit/experts/expert-contract.test.ts` 做一致性校验，契约漂移会直接失败。
 */

/** 能力标识 */
export const CAPABILITY_IMAGE_GENERATE = 'image.generate'
export const CAPABILITY_DOCUMENT_ASSEMBLE = 'document.assemble'
export const CAPABILITY_WEB_SEARCH = 'web.search'
export const CAPABILITY_VIDEO_GENERATE = 'video.generate'

/** 全部能力（顺序即展示顺序） */
export const ALL_CAPABILITIES = [
  CAPABILITY_IMAGE_GENERATE,
  CAPABILITY_DOCUMENT_ASSEMBLE,
  CAPABILITY_WEB_SEARCH,
  CAPABILITY_VIDEO_GENERATE
] as const

/** 支持的平台（新增移动端时在此追加） */
export const EXPERT_PLATFORMS = ['desktop', 'web', 'mobile'] as const

/** 专家提示词中的平台化变量（由服务端渲染替换） */
export const PROMPT_VARIABLES = ['delivery_dir', 'asset_tool', 'platform_notes'] as const

/** 素材保存工具名（各端同名实现） */
export const ASSET_TOOL_NAME = 'download_asset'

export type ExpertCapability = (typeof ALL_CAPABILITIES)[number]
export type ExpertPlatform = (typeof EXPERT_PLATFORMS)[number]

/** 判断专家是否声明了某能力（兼容老数据缺失该字段） */
export function hasCapability(
  capabilities: readonly string[] | undefined,
  capability: string
): boolean {
  return (capabilities ?? []).includes(capability)
}
