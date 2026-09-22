import { createHash } from 'crypto'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'fs'
import { dirname, resolve, sep } from 'path'
import { sniffImageMime } from '../../images/RemoteImageService'

/** 素材下载超时（毫秒）与单文件大小上限（20MB） */
const DOWNLOAD_TIMEOUT_MS = 60_000
const MAX_ASSET_BYTES = 20 * 1024 * 1024

/** 最小可注入的 fetch 形态（默认使用全局 fetch，测试可注入假实现） */
export type AssetFetchLike = (
  url: string,
  init?: { signal?: AbortSignal }
) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
}>

export interface DownloadAssetParams {
  url: string
  /** 相对工作区（交付目录）的保存路径，如 文章标题/figure-1.png */
  relPath: string
  /** 工作区绝对路径（由 agent:send 注入 configurable.workspace_dir） */
  workspaceDir: string
  fetchImpl?: AssetFetchLike
}

export interface DownloadedAsset {
  relPath: string
  absPath: string
  size: number
  mime: string
}

/**
 * 校验并归一化交付目录内的相对路径。
 * @throws 路径为空或包含 .. 穿越时抛错
 */
export function normalizeAssetRelPath(raw: string): string {
  const value = String(raw ?? '')
    .replace(/\\/g, '/')
    .trim()
  const parts = value.split('/').filter((part) => part && part !== '.')
  if (!parts.length || parts.some((part) => part === '..')) {
    throw new Error('非法的素材保存路径')
  }
  return parts.join('/')
}

/**
 * 下载远程图片并写入工作区（桌面版 download_asset 工具的实现）。
 *
 * 与 Web 端同名工具保持一致语义：只支持 http(s)、校验类型与大小、
 * 自动创建目录、原子写盘；失败时抛错由调用方转成结构化错误。
 */
export async function downloadAssetToWorkspace(
  params: DownloadAssetParams
): Promise<DownloadedAsset> {
  const url = String(params.url ?? '').trim()
  if (!/^https?:\/\//i.test(url)) throw new Error('仅支持 http(s) 图片地址')

  const workspaceDir = String(params.workspaceDir ?? '').trim()
  if (!workspaceDir) throw new Error('缺少工作区目录，无法保存素材')

  const relPath = normalizeAssetRelPath(params.relPath)
  const root = resolve(workspaceDir)
  const target = resolve(root, relPath)
  if (target !== root && !target.startsWith(root + sep)) throw new Error('路径越界')

  const fetchImpl =
    params.fetchImpl ?? (globalThis as { fetch: AssetFetchLike }).fetch
  if (typeof fetchImpl !== 'function') throw new Error('当前环境不支持下载素材')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  let buffer: Buffer
  let declaredMime = ''
  try {
    const response = await fetchImpl(url, { signal: controller.signal })
    if (!response.ok) throw new Error('图片下载失败（HTTP ' + response.status + '）')
    declaredMime = (response.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase()
    const declaredLength = Number(response.headers.get('content-length') ?? '0')
    if (declaredLength > MAX_ASSET_BYTES) throw new Error('图片超过大小上限')
    buffer = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('图片下载超时')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }

  if (!buffer.length) throw new Error('图片内容为空')
  if (buffer.length > MAX_ASSET_BYTES) throw new Error('图片超过大小上限')

  const mime = sniffImageMime(buffer) ?? (declaredMime.startsWith('image/') ? declaredMime : '')
  if (!mime) throw new Error('非图片内容：' + (declaredMime || 'unknown'))

  mkdirSync(dirname(target), { recursive: true })
  const tmpPath = target + '.' + createHash('sha1').update(String(Date.now())).digest('hex').slice(0, 8) + '.tmp'
  writeFileSync(tmpPath, buffer)
  renameSync(tmpPath, target)

  return { relPath, absPath: target, size: buffer.length, mime }
}

/** 判断素材文件是否已存在（重复下载时可短路） */
export function assetExists(workspaceDir: string, relPath: string): boolean {
  try {
    return existsSync(resolve(resolve(workspaceDir), normalizeAssetRelPath(relPath)))
  } catch {
    return false
  }
}
