import { homedir } from 'os'
import { join } from 'path'
import type { IWorkspaceStore } from './IWorkspaceStore'
import type { WorkspaceRow } from './types'
import { WordConversionService } from './WordConversionService'
import { ZipPackager, type WorkspaceZipExport } from './zip-packager'
import {
  WorkspaceRegistryService,
  type WorkspacePathMove,
  type WorkspaceServiceDeps
} from './workspace-registry'
import {
  WorkspaceFileService,
  type WorkspaceFileBinary,
  type WorkspaceFileContent,
  type WorkspaceFileEntry,
  type WorkspaceImageBytes,
  type WorkspaceMediaBytes
} from './workspace-files'

/** 再导出（定义随 R8-7 拆分迁至各自模块；保持既有 import 面不变） */
export type {
  WorkspaceFileEntry,
  WorkspaceFileContent,
  WorkspaceImageBytes,
  WorkspaceMediaBytes,
  WorkspaceFileBinary
} from './workspace-files'
export type { WorkspacePathMove, WorkspaceServiceDeps } from './workspace-registry'
export type { WorkspaceZipExport } from './zip-packager'

/**
 * 工作空间业务服务（R8-7：按域拆为注册表 / 文件 / 打包三模块，本类保留为对外门面）。
 *
 * 构造签名与全部公开方法不变（IPC 与调用方零改动）；实现在
 * WorkspaceRegistryService / WorkspaceFileService / ZipPackager。
 */
export class WorkspaceService {
  private readonly registry: WorkspaceRegistryService
  private readonly files: WorkspaceFileService
  /** 打包导出（异步压缩 + 条目/体积上限，见 ZipPackager） */
  private readonly zipPackager = new ZipPackager()

  constructor(
    repo: IWorkspaceStore,
    defaultWorkspaceDir: string = join(homedir(), 'KeWork'),
    deps: WorkspaceServiceDeps = {},
    wordConversionService: WordConversionService = new WordConversionService()
  ) {
    this.registry = new WorkspaceRegistryService(repo, defaultWorkspaceDir, deps)
    this.files = new WorkspaceFileService(
      (id, userId) => this.registry.resolveWorkspace(id, userId),
      wordConversionService
    )
  }

  /** 当前生效的默认工作空间目录（= 系统设置“默认工作空间存储路径”配置值） */
  getDefaultWorkspaceDir(): string {
    return this.registry.getDefaultWorkspaceDir()
  }

  /** 修改默认工作空间目录（系统设置变更后调用；迁移与记录同步见注册表实现） */
  async changeDefaultWorkspaceDir(nextDir: string): Promise<WorkspacePathMove[]> {
    return this.registry.changeDefaultWorkspaceDir(nextDir)
  }

  /** 当前用户的工作空间（含机器级共享的默认空间；记录/目录缺失时自动创建/重建） */
  async list(userId: string): Promise<WorkspaceRow[]> {
    return this.registry.list(userId)
  }

  /** 确保默认工作空间存在（目录 + 记录 + 历史迁移；见注册表实现） */
  async ensureDefaultWorkspace(): Promise<WorkspaceRow> {
    return this.registry.ensureDefaultWorkspace()
  }

  /** 新建工作空间：校验名字 → 在默认工作空间目录下创建同名子目录 → 入库 */
  createWorkspace(name: string, userId: string): WorkspaceRow {
    return this.registry.createWorkspace(name, userId)
  }

  /** 打开本地文件夹（系统目录选择 → 登记；重复选择复用/接管，取消返回 null） */
  async selectExternalDir(userId: string): Promise<WorkspaceRow | null> {
    return this.registry.selectExternalDir(userId)
  }

  /** 校验工作空间可删除（不存在 / 默认空间抛错；不落库，供级联删除前守卫） */
  assertDeletable(id: string, userId: string): void {
    this.registry.assertDeletable(id, userId)
  }

  /** 从列表中删除工作空间（仅删记录，不删除磁盘文件夹；默认空间不可删） */
  deleteWorkspace(id: string, userId: string): void {
    this.registry.deleteWorkspace(id, userId)
  }

  /** 重命名工作空间（仅改展示名，不动磁盘目录；默认空间不可改） */
  renameWorkspace(id: string, userId: string, name: string): WorkspaceRow {
    return this.registry.renameWorkspace(id, userId, name)
  }

  /** 拖拽排序（传入非默认空间全量 id，返回排序后的全量列表；见注册表实现） */
  async reorderWorkspaces(userId: string, orderedIds: string[]): Promise<WorkspaceRow[]> {
    return this.registry.reorderWorkspaces(userId, orderedIds)
  }

  /** 在系统资源管理器中打开工作空间目录（只接受表内本人 id） */
  async openWorkspace(id: string, userId: string): Promise<void> {
    return this.registry.openWorkspace(id, userId)
  }

  /** 解析工作空间为 Agent 运行参数（目录被删除等异常返回 null，调用方回退默认目录） */
  resolveWorkspace(id: string, userId: string): { id: string; name: string; dir: string } | null {
    return this.registry.resolveWorkspace(id, userId)
  }

  /** 列出工作空间下相对路径目录的条目（顶层传 ''） */
  listFiles(id: string, userId: string, relPath = ''): WorkspaceFileEntry[] {
    return this.files.listFiles(id, userId, relPath)
  }

  /** 读取工作空间下文件文本内容（按扩展名分发文本加载器；cursor 续读） */
  async readFile(
    id: string,
    userId: string,
    relPath: string,
    cursor?: number
  ): Promise<WorkspaceFileContent> {
    return this.files.readFile(id, userId, relPath, cursor)
  }

  /** 解析工作空间内文件路径并校验存在性与 containment。 */
  resolveFilePath(id: string, userId: string, relPath: string): string {
    return this.files.resolveFilePath(id, userId, relPath)
  }

  /** 读取工作空间内 Word/PDF 文件的原始字节（doc 先转换；pdf 按预览上限） */
  async readFileBytes(id: string, userId: string, relPath: string): Promise<WorkspaceFileBinary> {
    return this.files.readFileBytes(id, userId, relPath)
  }

  /** 读取工作空间内图片原始字节（路径校验与图片格式白名单由主进程执行） */
  async readImageBytes(id: string, userId: string, relPath: string): Promise<WorkspaceImageBytes> {
    return this.files.readImageBytes(id, userId, relPath)
  }

  /** 读取工作空间内视频原始字节（路径校验与格式白名单由主进程执行） */
  async readMediaBytes(id: string, userId: string, relPath: string): Promise<WorkspaceMediaBytes> {
    return this.files.readMediaBytes(id, userId, relPath)
  }

  /** 保存工作空间内 Word 文件字节（docx 直写；doc 经转换，失败不覆盖原文件） */
  async writeFile(
    id: string,
    userId: string,
    relPath: string,
    bytes: Uint8Array | ArrayBuffer
  ): Promise<void> {
    return this.files.writeFile(id, userId, relPath, bytes)
  }

  /** 校验并规范化工作空间名 */
  sanitizeName(input: string): string {
    return this.registry.sanitizeName(input)
  }




  /**
   * 打包导出为 zip（写入工作空间根目录，返回相对/绝对路径）。
   *
   * 典型用法：把「文章 + 同名配图目录」或整个交付目录打包下载。
   * @throws 工作空间不存在 / 路径越界 / 没有可打包内容时抛错
   */
  async exportZip(
    id: string,
    userId: string,
    relPaths: string[],
    zipName?: string,
    destAbsPath?: string
  ): Promise<WorkspaceZipExport> {
    const ws = this.resolveWorkspace(id, userId)
    if (!ws) throw new Error('工作空间不存在或目录已移除')
    return this.zipPackager.exportZip({ rootDir: ws.dir, relPaths, zipName, destAbsPath })
  }

  /** 生成建议的 zip 文件名（含 .zip 后缀）：另存为默认名与工作空间内导出名共用 */
  suggestZipName(relPaths: string[], zipName?: string): string {
    return this.zipPackager.suggestZipName(relPaths, zipName)
  }



}

