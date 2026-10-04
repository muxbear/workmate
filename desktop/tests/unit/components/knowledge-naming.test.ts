import { describe, expect, it } from 'vitest'
import {
  KB_DESC_MAX,
  KB_NAME_MAX,
  validateKbDesc,
  validateKbName,
  validateName
} from '../../../src/renderer/src/components/knowledge/knowledgeNaming'

describe('knowledgeNaming（知识库命名校验单一来源）', () => {
  it('名称：空值 / 长度 / 斜杠（正反斜杠都拒绝，修复三份弹窗的行为漂移）', () => {
    expect(validateKbName('')).toBe('知识库名称不能为空')
    expect(validateKbName('   ')).toBe('知识库名称不能为空')
    expect(validateKbName('a'.repeat(KB_NAME_MAX + 1))).toBe(`名称不能超过 ${KB_NAME_MAX} 个字符`)
    expect(validateKbName('产品/资料')).toBe('名称不能包含斜杠')
    expect(validateKbName('产品\\资料')).toBe('名称不能包含斜杠')
    expect(validateKbName('  产品资料库  ')).toBeNull()
    expect(validateKbName('a'.repeat(KB_NAME_MAX))).toBeNull()
  })

  it('描述：仅长度约束', () => {
    expect(validateKbDesc('a'.repeat(KB_DESC_MAX + 1))).toBe(`描述不能超过 ${KB_DESC_MAX} 个字符`)
    expect(validateKbDesc('正常描述')).toBeNull()
    expect(validateKbDesc('')).toBeNull()
  })

  it('validateName 通用口径：可定制空值文案与上限（Rename 弹窗复用）', () => {
    expect(validateName('', { emptyMessage: '名称不能为空' })).toBe('名称不能为空')
    expect(validateName('a'.repeat(21), { max: 20 })).toBe('名称不能超过 20 个字符')
    expect(validateName('文件名.txt', { max: 60 })).toBeNull()
  })
})
