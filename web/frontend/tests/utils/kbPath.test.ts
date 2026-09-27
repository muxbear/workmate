import { describe, expect, it } from 'vitest'
import { crumbsOf, folderForFile, joinFolder, parentFolder } from '@/utils/kbPath'

/**
 * 知识库目录路径工具。
 *
 * 这组函数只有一条容易写错、且错了**看不出来**的约定：**根目录是空串，不是"没有目录"**。
 * 任何一处把 `''` 当成"未设置"（`|| undefined`、`if (!folder)`），根视图就会悄悄变成
 * 全库视图。所以下面每条都从"根目录"这一侧写。
 */

describe('kbPath · 拼接与上下级', () => {
  it('joinFolder 任一侧为空则取另一侧', () => {
    expect(joinFolder('', 'a')).toBe('a')
    expect(joinFolder('a', '')).toBe('a')
    expect(joinFolder('', '')).toBe('')
    expect(joinFolder('a/b', 'c/d')).toBe('a/b/c/d')
  })

  it('joinFolder 顺手归一化反斜杠与退化片段', () => {
    expect(joinFolder('a\\b', './c')).toBe('a/b/c')
    expect(joinFolder('a', '../b')).toBe('a/b')
  })

  it('parentFolder 逐级向上，根目录的上一级仍是根', () => {
    expect(parentFolder('a/b/c')).toBe('a/b')
    expect(parentFolder('a')).toBe('')
    expect(parentFolder('')).toBe('')
    expect(parentFolder('/a/')).toBe('')
  })
})

describe('kbPath · 面包屑', () => {
  it('逐级累加路径，每段都能点回去', () => {
    expect(crumbsOf('a/b/c')).toEqual([
      { name: 'a', path: 'a' },
      { name: 'b', path: 'a/b' },
      { name: 'c', path: 'a/b/c' },
    ])
  })

  it('根目录没有面包屑段', () => {
    expect(crumbsOf('')).toEqual([])
    expect(crumbsOf('/')).toEqual([])
  })
})

describe('kbPath · 上传落点', () => {
  it('单文件落在当前浏览的目录', () => {
    // 浏览器只在"选择文件夹"时给 webkitRelativePath，普通选择是 undefined
    expect(folderForFile('资料', undefined)).toBe('资料')
    expect(folderForFile('', undefined)).toBe('')
    // 拖拽上传同样没有相对路径 → 拍平到当前目录
    expect(folderForFile('a/b', '')).toBe('a/b')
  })

  it('整目录上传保留内部结构，并挂在当前目录下', () => {
    expect(folderForFile('', '资料/2024/报告.pdf')).toBe('资料/2024')
    expect(folderForFile('a', '资料/报告.pdf')).toBe('a/资料')
    // 目录名本身就是最深一层时，文件直接落在它下面
    expect(folderForFile('', '资料/报告.pdf')).toBe('资料')
  })

  it('选中文件夹里的**顶层文件**仍带一层目录名（与 Windows 行为一致）', () => {
    expect(folderForFile('', '资料/报告.pdf')).toBe('资料')
  })

  it('相对路径没有目录成分时退回基础目录', () => {
    expect(folderForFile('a', '报告.pdf')).toBe('a')
  })
})
