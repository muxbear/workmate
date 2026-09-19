import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { copyFile, mkdir, writeFile } from 'fs/promises'
import { delimiter, dirname, join } from 'path'
import { promisify } from 'util'
import type { DesktopSkill, SkillInstallProgress, SkillRuntimeKind } from '../../preload/index.d'
import type { AgentManager } from '../agent/AgentManager'
import type { BinaryManager, RuntimeProgress } from '../runtime/BinaryManager'
import { SKILL_RUNTIME_DIR, SkillFileStore } from './SkillFileStore'
import { SkillJsonStore } from './SkillJsonStore'
import { planSkillRuntime } from './SkillRuntimePlanner'

const execFileAsync = promisify(execFile)

/** 单个运行时的环境配置（写入 .runtime/runtime.json） */
export interface SkillRuntimeManifestEntry {
  executablePath: string
  env: Record<string, string>
}

/** 技能私有运行环境清单（~/.ke-work/skills/<dir>/.runtime/runtime.json） */
export interface SkillRuntimeManifest {
  skill: string
  kinds: SkillRuntimeKind[]
  entry: string | null
  runtimes: Partial<Record<SkillRuntimeKind, SkillRuntimeManifestEntry>>
  dependencies: { attempted: boolean; installed: boolean; message?: string }
  updatedAt: number
}

interface SkillInstallServiceDeps {
  store: SkillJsonStore
  fileStore: SkillFileStore
  binaryManager: BinaryManager
  agentManager: AgentManager
}

/** 运行时名称（错误提示用） */
const RUNTIME_LABEL: Record<SkillRuntimeKind, string> = {
  python: 'Python',
  node: 'Node.js'
}

/**
 * 运行技能脚本所需的环境变量：内置运行时目录前置到 PATH，
 * 依赖目录通过 PYTHONPATH / NODE_PATH 注入。
 */
function buildRuntimeEnv(
  kind: SkillRuntimeKind,
  executablePath: string,
  skillDir: string
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: `${dirname(executablePath)}${delimiter}${process.env.PATH ?? ''}`
  }
  if (kind === 'python') {
    env.PYTHONPATH = join(skillDir, SKILL_RUNTIME_DIR, 'python', 'site-packages')
  }
  if (kind === 'node') {
    env.NODE_PATH = join(skillDir, SKILL_RUNTIME_DIR, 'node', 'node_modules')
  }
  return env
}

/**
 * 技能安装服务：把本地技能包挂载到主智能体之上。
 *
 * 安装流程：探测脚本类型 → 准备安全中心内置运行时（缺失时自动安装）→ 安装第三方依赖
 * （Python requirements.txt / Node package.json，失败不阻断但记录）→ 写入
 * `.runtime/runtime.json` → 更新 skills.json 安装状态 → 重建主智能体技能源。
 */
export class SkillInstallService {
  constructor(private readonly deps: SkillInstallServiceDeps) {}

  /** 安装技能到主智能体（含脚本运行时环境准备） */
  async install(
    skillId: string,
    onProgress?: (progress: SkillInstallProgress) => void
  ): Promise<{ skill: DesktopSkill }> {
    const file = await this.deps.store.read()
    const skill = file?.skills.find((item) => item.id === skillId)
    if (!file || !skill) throw new Error('技能不存在，请先重新同步')
    if (!skill.dirName) throw new Error('技能目录缺失，请重新同步')

    const skillDir = this.deps.fileStore.dirFor(skill.dirName)
    if (!existsSync(join(skillDir, 'SKILL.md'))) {
      throw new Error('技能目录不存在，请重新同步')
    }

    try {
      this.report(onProgress, skill, 'detect', 5, '正在检测技能脚本…')
      const plan = planSkillRuntime(skillDir)

      const runtimes: SkillRuntimeManifest['runtimes'] = {}
      for (const [index, kind] of plan.kinds.entries()) {
        const label = RUNTIME_LABEL[kind]
        const percent = 15 + index * 15
        this.report(onProgress, skill, 'runtime', percent, `正在准备 ${label} 运行时…`, {
          runtimeId: kind
        })

        const runtimeInfo = this.deps.binaryManager.listRuntimes().find((item) => item.id === kind)
        if (!runtimeInfo) throw new Error(`未知运行时：${kind}`)
        if (!runtimeInfo.enabled) {
          throw new Error(`${label} 运行时未启用，请前往「设置 → 安全中心 → 内置运行时」开启`)
        }

        if (runtimeInfo.status !== 'installed') {
          const onRuntimeProgress = (progress: RuntimeProgress): void => {
            this.report(onProgress, skill, 'runtime', percent, `正在安装 ${label} 运行时…`, {
              runtimeId: kind,
              runtimeProgress: progress
            })
          }
          this.deps.binaryManager.on('progress', onRuntimeProgress)
          try {
            await this.deps.binaryManager.installRuntime(kind)
          } finally {
            this.deps.binaryManager.off('progress', onRuntimeProgress)
          }
        }

        const executablePath = this.deps.binaryManager.getExecutablePath(kind)
        if (!executablePath) {
          throw new Error(`${label} 运行时不可用，请前往「设置 → 安全中心 → 内置运行时」检查`)
        }
        runtimes[kind] = { executablePath, env: buildRuntimeEnv(kind, executablePath, skillDir) }
      }

      this.report(onProgress, skill, 'deps', 55, '正在检查技能依赖…')
      const manifest: SkillRuntimeManifest = {
        skill: skill.dirName,
        kinds: plan.kinds,
        entry: plan.entry,
        runtimes,
        dependencies: { attempted: false, installed: true },
        updatedAt: Date.now()
      }
      manifest.dependencies = await this.prepareDependencies(skillDir, manifest)

      this.report(onProgress, skill, 'write', 75, '正在写入技能运行环境…')
      await this.writeRuntimeManifest(skillDir, manifest)

      const updated: DesktopSkill = {
        ...skill,
        installed: true,
        installedAt: Date.now(),
        runtime: { kinds: plan.kinds, entry: plan.entry, reasons: plan.reasons }
      }
      const nextSkills = file.skills.map((item) => (item.id === skillId ? updated : item))
      await this.deps.store.write({ ...file, skills: nextSkills })

      this.report(onProgress, skill, 'agent', 88, '正在把技能挂载到主智能体…')
      await this.deps.agentManager.applyInstalledSkills(this.installedDirNames(nextSkills))

      this.report(onProgress, skill, 'done', 100, `${skill.name} 已安装`)
      return { skill: updated }
    } catch (err) {
      this.report(onProgress, skill, 'error', 0, (err as Error).message)
      throw err
    }
  }

  /** 从主智能体移除技能（保留本地技能包与 .runtime） */
  async uninstall(skillId: string): Promise<{ skill: DesktopSkill }> {
    const file = await this.deps.store.read()
    const skill = file?.skills.find((item) => item.id === skillId)
    if (!file || !skill) throw new Error('技能不存在，请先重新同步')

    const updated: DesktopSkill = { ...skill, installed: false, installedAt: null }
    const nextSkills = file.skills.map((item) => (item.id === skillId ? updated : item))
    await this.deps.store.write({ ...file, skills: nextSkills })
    await this.deps.agentManager.applyInstalledSkills(this.installedDirNames(nextSkills))
    return { skill: updated }
  }

  /** 已安装且磁盘存在的技能目录名（主智能体技能源） */
  async listInstalled(): Promise<string[]> {
    const file = await this.deps.store.read()
    return this.installedDirNames(file?.skills ?? [])
  }

  /** 技能 id（或目录名）→ 本地目录名（自动化任务按 id 引用技能时使用） */
  async resolveDirNames(ids: string[]): Promise<string[]> {
    const file = await this.deps.store.read()
    const skills = file?.skills ?? []
    const out: string[] = []
    for (const id of ids) {
      const skill = skills.find((item) => item.id === id || item.dirName === id)
      if (skill?.dirName && this.deps.fileStore.hasSkill(skill.dirName)) {
        out.push(skill.dirName)
      }
    }
    return out
  }

  /** 应用启动后恢复已安装技能到主智能体（skills.json 为事实源） */
  async restoreInstalled(): Promise<void> {
    const dirs = await this.listInstalled()
    if (dirs.length > 0) {
      await this.deps.agentManager.applyInstalledSkills(dirs)
    }
  }

  private installedDirNames(skills: DesktopSkill[]): string[] {
    return skills
      .filter((skill) => skill.installed === true && this.deps.fileStore.hasSkill(skill.dirName))
      .map((skill) => skill.dirName!)
  }

  /**
   * 安装技能第三方依赖（尽力而为，不阻断技能挂载）：
   * - Node：复制 package.json 到 .runtime/node 后 `npm install`；
   * - Python：`pip install --target .runtime/python/site-packages -r requirements.txt`。
   */
  private async prepareDependencies(
    skillDir: string,
    manifest: SkillRuntimeManifest
  ): Promise<SkillRuntimeManifest['dependencies']> {
    const nodeRuntime = manifest.runtimes.node
    if (nodeRuntime && existsSync(join(skillDir, 'package.json'))) {
      const target = join(skillDir, SKILL_RUNTIME_DIR, 'node')
      await mkdir(target, { recursive: true })
      await copyFile(join(skillDir, 'package.json'), join(target, 'package.json'))
      const npmPath =
        process.platform === 'win32'
          ? join(dirname(nodeRuntime.executablePath), 'npm.cmd')
          : join(dirname(nodeRuntime.executablePath), 'npm')
      if (!existsSync(npmPath)) {
        return { attempted: true, installed: false, message: '未找到 npm 可执行文件' }
      }
      try {
        await execFileAsync(npmPath, ['install', '--no-audit', '--no-fund', '--prefix', target], {
          timeout: 300_000,
          windowsHide: true
        })
        return { attempted: true, installed: true }
      } catch (err) {
        return { attempted: true, installed: false, message: (err as Error).message }
      }
    }

    const pythonRuntime = manifest.runtimes.python
    if (pythonRuntime && existsSync(join(skillDir, 'requirements.txt'))) {
      const target = join(skillDir, SKILL_RUNTIME_DIR, 'python', 'site-packages')
      await mkdir(target, { recursive: true })
      try {
        await execFileAsync(
          pythonRuntime.executablePath,
          ['-m', 'pip', 'install', '--target', target, '-r', join(skillDir, 'requirements.txt')],
          { timeout: 300_000, windowsHide: true }
        )
        return { attempted: true, installed: true }
      } catch (err) {
        return { attempted: true, installed: false, message: (err as Error).message }
      }
    }

    return { attempted: false, installed: true }
  }

  private async writeRuntimeManifest(
    skillDir: string,
    manifest: SkillRuntimeManifest
  ): Promise<void> {
    const dir = join(skillDir, SKILL_RUNTIME_DIR)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'runtime.json'), JSON.stringify(manifest, null, 2), 'utf-8')
  }

  private report(
    onProgress: ((progress: SkillInstallProgress) => void) | undefined,
    skill: DesktopSkill,
    phase: SkillInstallProgress['phase'],
    percent: number,
    message: string,
    extra?: Partial<SkillInstallProgress>
  ): void {
    onProgress?.({ skillId: skill.id, skillName: skill.name, phase, percent, message, ...extra })
  }
}
