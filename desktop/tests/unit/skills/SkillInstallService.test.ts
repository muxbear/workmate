import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { zipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import type { AgentManager } from '../../../src/main/agent/AgentManager'
import type { BinaryManager } from '../../../src/main/runtime/BinaryManager'
import { SKILL_RUNTIME_DIR, SkillFileStore } from '../../../src/main/skills/SkillFileStore'
import {
  SkillInstallService,
  type SkillRuntimeManifest
} from '../../../src/main/skills/SkillInstallService'
import { SkillJsonStore } from '../../../src/main/skills/SkillJsonStore'
import type { DesktopSkill, SkillInstallProgress } from '../../../src/preload/index.d'

const encoder = new TextEncoder()

function skillMd(name = 'py-skill'): string {
  return `---\nname: ${name}\ndescription: demo\n---\n\n# demo\n`
}

type RuntimeStatus = 'installed' | 'not-installed'

interface PrepareOptions {
  runtimes?: Array<{ id: 'python' | 'node'; status: RuntimeStatus; enabled: boolean }>
  executablePath?: Partial<Record<'python' | 'node', string>>
}

interface InstallHarness {
  dir: string
  store: SkillJsonStore
  fileStore: SkillFileStore
  service: SkillInstallService
  skill: DesktopSkill
  binaryManager: BinaryManager
  agentManager: AgentManager
}

async function prepare(
  files: Record<string, string>,
  options: PrepareOptions = {}
): Promise<InstallHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'kw-skill-install-'))
  const fileStore = new SkillFileStore(dir)
  const zipEntries: Record<string, Uint8Array> = {}
  for (const [rel, content] of Object.entries(files)) zipEntries[rel] = encoder.encode(content)
  const pkg = fileStore.extractPackage(zipSync(zipEntries), 's1')
  await fileStore.writePackage(pkg)

  const store = new SkillJsonStore(dir)
  const skill: DesktopSkill = {
    id: 's1',
    name: '演示技能',
    desc: 'demo',
    category: 'custom',
    icon: 'Zap',
    color: '',
    enabled: true,
    isBuiltin: false,
    source: 'local',
    dirName: pkg.dirName,
    files: await fileStore.listFiles(pkg.dirName),
    runtime: null,
    installed: false,
    installedAt: null
  }
  await store.write({ version: 1, syncedAt: 1, syncedBy: null, skills: [skill] })

  const runtimes = (options.runtimes ?? [{ id: 'python', status: 'installed', enabled: true }]).map(
    (item) => ({
      id: item.id,
      name: item.id === 'python' ? 'Python' : 'Node.js',
      description: '',
      mark: item.id === 'python' ? 'Py' : 'JS',
      color: '#000',
      status: item.status,
      enabled: item.enabled,
      executablePath:
        options.executablePath?.[item.id] ??
        (item.id === 'python' ? '/opt/python/python.exe' : '/opt/node/node.exe'),
      installPath: `/opt/${item.id}`
    })
  )

  const binaryManager = {
    listRuntimes: vi.fn(() => runtimes),
    getExecutablePath: vi.fn(
      (id: 'python' | 'node') => options.executablePath?.[id] ?? `/opt/${id}/${id}.exe`
    ),
    installRuntime: vi.fn(async () => undefined),
    on: vi.fn(),
    off: vi.fn()
  } as unknown as BinaryManager

  const agentManager = {
    applyInstalledSkills: vi.fn(async () => undefined)
  } as unknown as AgentManager

  const service = new SkillInstallService({ store, fileStore, binaryManager, agentManager })
  return { dir, store, fileStore, service, skill, binaryManager, agentManager }
}

function readManifest(dir: string, dirName: string): SkillRuntimeManifest {
  return JSON.parse(
    readFileSync(join(dir, dirName, SKILL_RUNTIME_DIR, 'runtime.json'), 'utf-8')
  ) as SkillRuntimeManifest
}

describe('SkillInstallService', () => {
  it('SIS-01: 安装含 Python 脚本的技能 → 写 .runtime/runtime.json 并挂载主智能体', async () => {
    const harness = await prepare({
      'SKILL.md': skillMd(),
      'scripts/run.py': 'print(1)'
    })
    const phases: SkillInstallProgress['phase'][] = []
    const result = await harness.service.install('s1', (progress) => phases.push(progress.phase))

    expect(result.skill.installed).toBe(true)
    expect(phases).toEqual(['detect', 'runtime', 'deps', 'write', 'agent', 'done'])
    expect(harness.binaryManager.installRuntime).not.toHaveBeenCalled()

    const manifest = readManifest(harness.dir, 'py-skill')
    expect(manifest.kinds).toEqual(['python'])
    expect(manifest.entry).toBe('scripts/run.py')
    expect(manifest.runtimes.python?.executablePath).toBe('/opt/python/python.exe')
    expect(manifest.runtimes.python?.env.PYTHONPATH).toContain('site-packages')

    const stored = await harness.store.read()
    expect(stored?.skills[0]?.installed).toBe(true)
    expect(harness.agentManager.applyInstalledSkills).toHaveBeenCalledWith(['py-skill'])
  })

  it('SIS-02: 运行时未安装时自动安装', async () => {
    const harness = await prepare(
      { 'SKILL.md': skillMd(), 'scripts/run.py': 'print(1)' },
      { runtimes: [{ id: 'python', status: 'not-installed', enabled: true }] }
    )
    const result = await harness.service.install('s1')
    expect(result.skill.installed).toBe(true)
    expect(harness.binaryManager.installRuntime).toHaveBeenCalledWith('python')
  })

  it('SIS-03: 运行时被禁用时安装失败且不改变安装状态', async () => {
    const harness = await prepare(
      { 'SKILL.md': skillMd(), 'scripts/run.py': 'print(1)' },
      { runtimes: [{ id: 'python', status: 'installed', enabled: false }] }
    )
    await expect(harness.service.install('s1')).rejects.toThrow('未启用')
    const stored = await harness.store.read()
    expect(stored?.skills[0]?.installed).toBe(false)
    expect(harness.agentManager.applyInstalledSkills).not.toHaveBeenCalled()
  })

  it('SIS-04: 卸载技能后主智能体技能源为空，本地包保留', async () => {
    const harness = await prepare({ 'SKILL.md': skillMd(), 'scripts/run.py': 'print(1)' })
    await harness.service.install('s1')
    const result = await harness.service.uninstall('s1')

    expect(result.skill.installed).toBe(false)
    expect(harness.agentManager.applyInstalledSkills).toHaveBeenLastCalledWith([])
    expect(harness.fileStore.hasSkill('py-skill')).toBe(true)
  })

  it('SIS-05: Node 依赖安装失败不阻断技能挂载，结果写入 runtime.json', async () => {
    const harness = await prepare(
      {
        'SKILL.md': skillMd('js-skill'),
        'scripts/index.mjs': 'export default 1',
        'package.json': '{"name":"demo"}'
      },
      { runtimes: [{ id: 'node', status: 'installed', enabled: true }] }
    )
    const result = await harness.service.install('s1')
    expect(result.skill.installed).toBe(true)

    const manifest = readManifest(harness.dir, 'js-skill')
    expect(manifest.kinds).toEqual(['node'])
    expect(manifest.dependencies.attempted).toBe(true)
    expect(manifest.dependencies.installed).toBe(false)
  })

  it('SIS-06: 无脚本技能直接挂载（无需运行时）', async () => {
    const harness = await prepare({ 'SKILL.md': skillMd('doc-only') }, { runtimes: [] })
    const result = await harness.service.install('s1')
    expect(result.skill.installed).toBe(true)

    const manifest = readManifest(harness.dir, 'doc-only')
    expect(manifest.kinds).toEqual([])
    expect(manifest.runtimes).toEqual({})
  })

  it('SIS-07: 删除技能只作用于本地副本（移除本地包、索引与主智能体装配）', async () => {
    const harness = await prepare({ 'SKILL.md': skillMd(), 'scripts/run.py': 'print(1)' })
    await harness.service.install('s1')

    const result = await harness.service.delete('s1')

    expect(result.skill.id).toBe('s1')
    expect(harness.fileStore.hasSkill('py-skill')).toBe(false)
    expect(harness.agentManager.applyInstalledSkills).toHaveBeenLastCalledWith([])
    const stored = await harness.store.read()
    expect(stored?.skills).toHaveLength(0)
  })
})
