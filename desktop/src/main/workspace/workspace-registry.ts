import { existsSync, mkdirSync } from 'fs'
import { cp, mkdir, readdir, rename, rmdir, rm } from 'fs/promises'
import { homedir } from 'os'
import { isAbsolute, join, parse, relative, resolve, sep } from 'path'
import type { WorkspaceRepository } from './WorkspaceRepository'
import type { WorkspaceRow } from './types'

/**
 * 工作空间注册表（R8-7：自 WorkspaceService 拆分，纯搬移）：默认空间的确保/迁移、
 * 工作空间 CRUD、外部目录登记与解析、名称校验。目录创建/校验集中在主进程。
 * WorkspaceService 保留同名方法作为委托门面（签名/行为不变）。
 */

/** 默认工作空间：未选择任何空间时的兜底目录（记录机器级共享，user_id 恒为 NULL） */
const DEFAULT_WS_NAME = '默认工作空间'

/** 工作空间名称规则（Windows 目录名约束的超集，跨平台一致） */
const NAME_MAX_LEN = 50
/** 非法字符：路径分隔符与 Windows 保留字符 */
const INVALID_CHARS = /[\\/:*?"<>|]/
/** 首尾点/空格（Windows 目录规则：目录名不能以点或空格结尾） */
const EDGE_DOTS_SPACES = /^[.\s]|[.\s]$/
/** Windows 保留设备名（大小写不敏感） */
const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

/** 工作空间外部依赖（可注入以便纯 node 单测） */
export interface WorkspacePathMove {
  workspaceId: string
  from: string
  to: string
}

export interface WorkspaceServiceDeps {
  /** 打开系统目录选择窗口，返回所选目录绝对路径；取消返回 null */
  selectDir?: () => Promise<string | null>
  /** 在系统资源管理器中打开目录 */
  openPath?: (p: string) => Promise<void>
  onWorkspaceMigrated?: (moves: WorkspacePathMove[]) => void
}

export class WorkspaceRegistryService {
  private defaultWorkspaceDir: string

  constructor(
    private readonly repo: WorkspaceRepository,
    defaultWorkspaceDir: string = join(homedir(), 'KeWork'),
    private readonly deps: WorkspaceServiceDeps = {}
  ) {
    this.defaultWorkspaceDir = defaultWorkspaceDir
  }

  /** 当前生效的默认工作空间目录（= 系统设置“默认工作空间存储路径”配置值） */
  getDefaultWorkspaceDir(): string {
    return this.defaultWorkspaceDir
  }

  /**
   * 修改默认工作空间目录（系统设置“默认工作空间存储路径”更改后调用）。
   * 迁移旧目录全部内容到新目录，并同步 workspaces 记录与 onWorkspaceMigrated 回调。
   */
  async changeDefaultWorkspaceDir(nextDir: string): Promise<WorkspacePathMove[]> {
    if (typeof nextDir !== 'string' || !nextDir.trim() || !isAbsolute(nextDir)) {
      throw new Error('默认工作空间路径必须为绝对路径')
    }
    await this.ensureDefaultWorkspace()
    const fromDir = resolve(this.defaultWorkspaceDir)
    const toDir = resolve(nextDir.trim())
    if (fromDir === toDir) return []
    return this.relocateDefaultWorkspace(fromDir, toDir)
  }
  /**
   * 当前用户的工作空间（含机器级共享的默认空间；记录/目录缺失时自动创建/重建）
   */
  async list(userId: string): Promise<WorkspaceRow[]> {
    await this.ensureDefaultWorkspace()
    // CQS：认领无主记录从 listForUser 中移出，由服务显式执行（行为不变）
    this.repo.adoptOrphanWorkspaces(userId)
    return this.repo.listForUser(userId)
  }

  /**
   * 确保默认工作空间存在：
   * - 目录即系统设置「默认工作空间存储路径」配置值本身（不再创建 DefaultWorkspace 子目录）；
   * - 记录缺失 → 创建目录并入库（机器级唯一，user_id 为 NULL）；
   * - 记录指向其他目录（历史基址语义或改动过存储路径）→ 迁移目录内容并更新记录（id 不变，绑定不失效）。
   */
  async ensureDefaultWorkspace(): Promise<WorkspaceRow> {
    const dir = this.defaultWorkspaceDir
    if (!isAbsolute(dir)) throw new Error('默认工作空间路径必须为绝对路径')
    const existing = this.repo.findByPath(dir)
    if (existing) {
      if (existing.source !== 'default') {
        throw new Error('默认工作空间路径已被其他工作空间占用')
      }
      // 记录存在但目录被删除/移动时自动重建，避免记录在、目录丢导致的解析失败
      await mkdir(dir, { recursive: true })
      this.repo.removeOtherDefaults(existing.id)
      return existing
    }
    const otherDefault = this.repo.findDefaultSource()
    if (otherDefault) {
      console.log('[workspace] migrate default workspace: ' + otherDefault.path + ' -> ' + dir)
      await this.relocateDefaultWorkspace(otherDefault.path, dir)
      return { ...otherDefault, path: dir }
    }
    await mkdir(dir, { recursive: true })
    console.log('[workspace] created default workspace directory: ' + dir)
    return this.repo.create({ name: DEFAULT_WS_NAME, path: dir, source: 'default', userId: null })
  }

  /**
   * 迁移默认工作空间目录：把 fromDir 下全部内容移动到 toDir，
   * 并同步更新 workspaces 中位于 fromDir 内（含默认空间本身）的记录路径。
   * 目录缺失时仅更新记录；目标目录已含同名条目时拒绝迁移，避免误覆盖。
   */
  private async relocateDefaultWorkspace(
    fromDir: string,
    toDir: string
  ): Promise<WorkspacePathMove[]> {
    const from = resolve(fromDir)
    const to = resolve(toDir)
    this.assertSafeMigrationPath(from, '当前默认工作空间')
    this.assertSafeMigrationPath(to, '新默认工作空间')
    if (from === to) return []
    if (to.startsWith(from + sep)) {
      throw new Error('新目录不能位于当前默认工作空间目录内部')
    }
    const targetOccupied = this.repo.findByPath(to)
    const defaultRow = this.repo.findDefaultSource()
    if (
      targetOccupied &&
      targetOccupied.source !== 'default' &&
      (!defaultRow || targetOccupied.id !== defaultRow.id)
    ) {
      throw new Error('目标目录已被其他工作空间占用')
    }
    const affected = this.repo
      .listAll()
      .filter((row) => row.path === from || row.path.startsWith(from + sep))
    await mkdir(to, { recursive: true })
    if (existsSync(from)) {
      await this.moveDirectoryContents(from, to)
      // 内容已搬空：尽力移除空壳源目录（rmdir 仅在目录为空时成功，非空/被占用则保留）
      await rmdir(from).catch(() => undefined)
    }
    const moves: WorkspacePathMove[] = affected.map((row) => {
      const next = row.path === from ? to : join(to, relative(from, row.path))
      this.repo.updatePath(row.id, next)
      return { workspaceId: row.id, from: row.path, to: next }
    })
    const currentDefault = this.repo.findDefaultSource()
    if (currentDefault) this.repo.removeOtherDefaults(currentDefault.id)
    this.defaultWorkspaceDir = to
    console.log('[workspace] default workspace moved to: ' + to)
    this.deps.onWorkspaceMigrated?.(moves)
    return moves
  }

  /** 逐项把 src 子项迁移到 dst；跨盘/占用时降级为复制后删除 */
  private async moveDirectoryContents(src: string, dst: string): Promise<void> {
    const existing = new Set(await readdir(dst))
    const entries = await readdir(src, { withFileTypes: true })
    const overlap = entries.filter((entry) => existing.has(entry.name))
    if (overlap.length > 0) {
      throw new Error('目标目录已存在同名文件或目录：' + overlap[0].name)
    }
    for (const entry of entries) {
      const from = join(src, entry.name)
      const to = join(dst, entry.name)
      try {
        await rename(from, to)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EACCES') throw err
        await cp(from, to, { recursive: true, force: true })
        await rm(from, { recursive: true, force: true })
      }
    }
    try {
      await rm(src, { recursive: false, force: true })
    } catch {
      // 目录仍被占用或非空时保留原目录，不影响迁移结果
    }
  }

  /** 安全校验：默认工作空间不允许是磁盘根目录或用户主目录 */
  private assertSafeMigrationPath(dir: string, label: string): void {
    const root = parse(dir).root
    if (dir === root || dir === homedir()) {
      throw new Error(label + '不能设置为磁盘根目录或用户主目录')
    }
  }
  /**
   * 新建工作空间：校验名字 → 在默认工作空间目录下创建同名子目录 → 入库
   * @throws 名字非法 / 目录已存在时抛错（渲染层展示 message）
   */
  createWorkspace(name: string, userId: string): WorkspaceRow {
    const safe = this.sanitizeName(name)
    const dir = join(this.defaultWorkspaceDir, safe)
    if (existsSync(dir)) {
      throw new Error(`工作空间已存在：${safe}`)
    }
    mkdirSync(dir, { recursive: true })
    console.log(`[workspace] created directory: ${dir}`)
    return this.repo.create({ name: safe, path: dir, source: 'created', userId })
  }

  /**
   * 打开本地文件夹：系统目录选择 → 入库（source: external）
   * 重复选择的目录：默认空间直接复用；无主记录先接管；他人记录拒绝
   * 用户取消返回 null
   */
  async selectExternalDir(userId: string): Promise<WorkspaceRow | null> {
    if (!this.deps.selectDir) throw new Error('目录选择功能不可用')
    const dir = await this.deps.selectDir()
    if (!dir) return null
    const existing = this.repo.findByPath(dir)
    if (existing) {
      if (existing.source === 'default') return existing
      if (existing.userId === null) {
        this.repo.adoptByPath(dir, userId)
        return { ...existing, userId }
      }
      if (existing.userId !== userId) {
        throw new Error('该目录已被其他用户登记为工作空间')
      }
      return existing
    }
    const name = this.basename(dir)
    return this.repo.create({ name, path: dir, source: 'external', userId })
  }

  /**
   * 校验工作空间可删除（不存在 / 默认空间抛错；不落库，供 workspace:delete 级联删除前守卫）
   */
  assertDeletable(id: string, userId: string): void {
    const ws = this.repo.getById(id, userId)
    if (!ws) throw new Error('工作空间不存在')
    if (ws.source === 'default') throw new Error('默认工作空间不可删除')
  }

  /**
   * 从列表中删除工作空间（仅删记录，不删除磁盘文件夹——避免误删用户数据；默认空间不可删）
   * 业务表绑定的会话由 workspace:delete handler 级联删除；仅 metadata 绑定的旧会话随记录删除后归默认空间
   */
  deleteWorkspace(id: string, userId: string): void {
    this.assertDeletable(id, userId)
    if (this.repo.delete(id, userId) === 0) throw new Error('工作空间不存在')
    console.log(`[workspace] deleted workspace record: ${id}`)
  }

  /** 在系统资源管理器中打开工作空间目录（只接受表内本人 id） */
  async openWorkspace(id: string, userId: string): Promise<void> {
    const ws = this.repo.getById(id, userId)
    if (!ws) throw new Error('工作空间不存在')
    const target = ws.path
    if (!existsSync(target)) throw new Error('工作空间目录不存在')
    if (!this.deps.openPath) throw new Error('打开目录功能不可用')
    await this.deps.openPath(target)
  }

  /**
   * 解析工作空间为 Agent 运行参数：id 存在且目录在磁盘上 → { id, name, dir }
   * 目录被删除等异常场景返回 null（调用方回退默认目录）
   */
  resolveWorkspace(id: string, userId: string): { id: string; name: string; dir: string } | null {
    const ws = this.repo.getById(id, userId)
    if (!ws || !existsSync(ws.path)) return null
    return { id: ws.id, name: ws.name, dir: ws.path }
  }

  /**
   * 校验并规范化工作空间名
   * @throws 非法名字时抛错
   */
  sanitizeName(input: string): string {
    const name = input.trim()
    if (!name) throw new Error('工作空间名称不能为空')
    if (name.length > NAME_MAX_LEN) throw new Error(`名称长度不能超过 ${NAME_MAX_LEN} 个字符`)
    if (INVALID_CHARS.test(name)) {
      throw new Error('名称不能包含 / \\ : * ? " < > | 字符')
    }
    if (name === '.' || name === '..') throw new Error('名称不能为 . 或 ..')
    if (EDGE_DOTS_SPACES.test(name)) throw new Error('名称不能以 . 或空格开头/结尾')
    if (RESERVED_NAMES.test(name)) throw new Error('名称不能为系统保留名')
    return name
  }

  /** 取路径最后一段作为展示名（外部目录） */
  private basename(dir: string): string {
    const parts = dir.split(/[\\/]/).filter(Boolean)
    return parts[parts.length - 1] ?? dir
  }
}
