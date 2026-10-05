import { describe, expect, it } from 'vitest'
import { isExcludedRelPath } from '../../../src/renderer/src/components/knowledge/uploadFilter'

/**
 * 上传前的路径过滤（从文件夹纳入队列时跳过常见非文档目录）。
 *
 * 覆盖：任一段命中即整棵子树跳过、`\` 与 `/` 两种分隔、深层嵌套的
 * node_modules 同样命中、普通文档路径不受影响。
 */
describe('isExcludedRelPath', () => {
  it('顶层排除目录及其子树命中', () => {
    expect(isExcludedRelPath('node_modules/lodash/index.js')).toBe(true)
    expect(isExcludedRelPath('.git/config')).toBe(true)
    expect(isExcludedRelPath('.DS_Store')).toBe(true)
  })

  it('深层任意路径段命中即跳过', () => {
    expect(isExcludedRelPath('docs/node_modules/pkg/readme.md')).toBe(true)
    expect(isExcludedRelPath('project/.venv/lib/python3.12/site.py')).toBe(true)
    expect(isExcludedRelPath('a/b/.idea/workspace.xml')).toBe(true)
  })

  it('反斜杠分隔同样按段匹配', () => {
    expect(isExcludedRelPath('docs\\node_modules\\pkg\\readme.md')).toBe(true)
  })

  it('普通文档路径不受影响', () => {
    expect(isExcludedRelPath('docs/guide/intro.md')).toBe(false)
    expect(isExcludedRelPath('说明.txt')).toBe(false)
    expect(isExcludedRelPath('git-notes.md')).toBe(false)
    expect(isExcludedRelPath('node_modules.md')).toBe(false)
  })
})
