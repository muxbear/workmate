import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  ALL_CAPABILITIES,
  ASSET_TOOL_NAME,
  EXPERT_PLATFORMS,
  PROMPT_VARIABLES,
  hasCapability
} from '../../../src/main/experts/expertContract'

interface ExpertContract {
  version: number
  platforms: string[]
  capabilities: string[]
  promptVariables: string[]
  assetTool: string
}

/** 读取仓库根目录下的契约文件（desktop 的上一级） */
function readContract(): ExpertContract {
  const path = join(process.cwd(), '..', 'packages', 'expert-contract', 'contract.json')
  return JSON.parse(readFileSync(path, 'utf8')) as ExpertContract
}

describe('专家能力契约（TS 镜像 ↔ contract.json）', () => {
  it('能力 / 平台 / 提示词变量 / 素材工具名与契约文件一致', () => {
    const contract = readContract()
    expect(contract.version).toBe(1)
    expect([...ALL_CAPABILITIES]).toEqual(contract.capabilities)
    expect([...EXPERT_PLATFORMS]).toEqual(contract.platforms)
    expect([...PROMPT_VARIABLES]).toEqual(contract.promptVariables)
    expect(ASSET_TOOL_NAME).toBe(contract.assetTool)
  })

  it('hasCapability 兼容缺失字段', () => {
    expect(hasCapability(['document.assemble'], 'document.assemble')).toBe(true)
    expect(hasCapability(undefined, 'document.assemble')).toBe(false)
  })
})
