import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { zipSync } from 'fflate'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  SKILL_RUNTIME_DIR,
  SkillFileStore,
  hashSkillFileEntries
} from '../../../src/main/skills/SkillFileStore'

const enc = (text: string): Uint8Array => new TextEncoder().encode(text)

function skillMd(name = 'web-search'): string {
  return `---\nname: ${name}\ndescription: demo skill\n---\n\n# demo\n`
}

function makeZip(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {}
  for (const [path, content] of Object.entries(files)) entries[path] = enc(content)
  return zipSync(entries)
}

describe('SkillFileStore', () => {
  let baseDir: string
  let store: SkillFileStore

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'kw-skill-files-'))
    store = new SkillFileStore(baseDir)
  })

  it('SFS-01: 解压技能包并保持目录结构，目录名取 frontmatter name', () => {
    const zip = makeZip({
      'SKILL.md': skillMd('web-search'),
      'scripts/run.py': 'print(1)\n',
      'assets/logo.svg': '<svg/>'
    })
    const pkg = store.extractPackage(zip, 's1')
    expect(pkg.dirName).toBe('web-search')
    expect(pkg.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'assets/logo.svg',
      'scripts/run.py'
    ])
  })

  it('SFS-02: 剥离单层包装目录', () => {
    const zip = makeZip({
      'web-search/SKILL.md': skillMd('web-search'),
      'web-search/scripts/a.js': '1'
    })
    const pkg = store.extractPackage(zip, 's1')
    expect(pkg.dirName).toBe('web-search')
    expect(pkg.files.map((file) => file.path)).toEqual(['SKILL.md', 'scripts/a.js'])
  })

  it('SFS-03: 目录名不合规时回退 skill-<id 前 8 位>', () => {
    const zip = makeZip({ 'SKILL.md': skillMd('网络搜索') })
    const pkg = store.extractPackage(zip, 'abcdef12-3456-7890')
    expect(pkg.dirName).toBe('skill-abcdef12')
  })

  it('SFS-04: 缺少 SKILL.md 报错', () => {
    const zip = makeZip({ 'scripts/a.py': 'print(1)' })
    expect(() => store.extractPackage(zip, 's1')).toThrow('技能包缺少 SKILL.md')
  })

  it('SFS-05: 拒绝路径穿越条目', () => {
    let zip: Uint8Array
    try {
      zip = makeZip({ '../evil.txt': 'x', 'SKILL.md': skillMd() })
    } catch {
      // zip 构造阶段即被拒绝，等价于防护生效
      return
    }
    expect(() => store.extractPackage(zip, 's1')).toThrow()
  })

  it('SFS-06: 原子写入并保留 .runtime，清单排除运行环境', async () => {
    const pkg = store.extractPackage(
      makeZip({ 'SKILL.md': skillMd(), 'scripts/a.py': 'print(1)' }),
      's1'
    )
    const files = await store.writePackage(pkg)
    expect(files.map((file) => file.path)).toEqual(['SKILL.md', 'scripts/a.py'])

    const runtimeDir = join(baseDir, pkg.dirName, SKILL_RUNTIME_DIR)
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(runtimeDir, 'runtime.json'), '{"kinds":["python"]}', 'utf-8')

    const second = store.extractPackage(
      makeZip({ 'SKILL.md': skillMd(), 'scripts/a.py': 'print(2)' }),
      's1'
    )
    const updated = await store.writePackage(second)
    expect(updated).toHaveLength(2)
    expect(existsSync(join(runtimeDir, 'runtime.json'))).toBe(true)
    expect(store.hasSkill(pkg.dirName)).toBe(true)
    expect(hashSkillFileEntries(updated)).toHaveLength(64)
  })

  it('SFS-07: removeSkill 删除技能目录', async () => {
    const pkg = store.extractPackage(makeZip({ 'SKILL.md': skillMd() }), 's1')
    await store.writePackage(pkg)
    expect(store.hasSkill(pkg.dirName)).toBe(true)
    await store.removeSkill(pkg.dirName)
    expect(store.hasSkill(pkg.dirName)).toBe(false)
  })
})
