import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { describe, expect, it } from 'vitest'
import { planSkillRuntime } from '../../../src/main/skills/SkillRuntimePlanner'

function makeSkillDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'kw-skill-plan-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf-8')
  }
  return dir
}

describe('planSkillRuntime', () => {
  it('SRP-01: scripts/ 下的 Python 脚本 → python 运行时', () => {
    const dir = makeSkillDir({
      'SKILL.md': '---\nname: demo\ndescription: demo\n---\n',
      'scripts/run.py': 'print(1)'
    })
    const plan = planSkillRuntime(dir)
    expect(plan.kinds).toEqual(['python'])
    expect(plan.entry).toBe('scripts/run.py')
  })

  it('SRP-02: frontmatter module → node 运行时并作为入口', () => {
    const dir = makeSkillDir({
      'SKILL.md': '---\nname: demo\ndescription: demo\nmodule: ./scripts/index.mjs\n---\n',
      'scripts/index.mjs': 'export default 1'
    })
    const plan = planSkillRuntime(dir)
    expect(plan.kinds).toEqual(['node'])
    expect(plan.entry).toBe('scripts/index.mjs')
  })

  it('SRP-03: 声明 + 依赖文件同时命中两类运行时，顺序固定 python → node', () => {
    const dir = makeSkillDir({
      'SKILL.md': '---\nname: demo\ndescription: demo\nmetadata:\n  runtime: python\n---\n',
      'scripts/index.js': 'console.log(1)',
      'package.json': '{}'
    })
    const plan = planSkillRuntime(dir)
    expect(plan.kinds).toEqual(['python', 'node'])
    expect(plan.reasons.length).toBeGreaterThan(0)
  })

  it('SRP-04: 无脚本技能 → 无运行时需求', () => {
    const dir = makeSkillDir({
      'SKILL.md': '---\nname: demo\ndescription: demo\n---\n\n仅文档技能\n'
    })
    const plan = planSkillRuntime(dir)
    expect(plan.kinds).toEqual([])
    expect(plan.entry).toBeNull()
  })

  it('SRP-05: SKILL.md 正文引用 Python 脚本（弱信号兜底）', () => {
    const dir = makeSkillDir({
      'SKILL.md': '---\nname: demo\ndescription: demo\n---\n\n运行：python scripts/tool.py --help\n'
    })
    const plan = planSkillRuntime(dir)
    expect(plan.kinds).toEqual(['python'])
  })
})
