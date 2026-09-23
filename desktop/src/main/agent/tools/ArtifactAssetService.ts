import { createHash } from 'crypto'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'fs'
import { dirname, resolve, sep } from 'path'
import { sniffImageMime } from '../../images/RemoteImageService'

/** 素材下载超时与单文件大小上限（图片 20MB / 视频 200MB，与工作区媒体白名单对齐） */
const DOWNLOAD_TIMEOUT_MS = 60_000
const VIDEO_DOWNLOAD_TIMEOUT_MS = 300_000
const MAX_ASSET_BYTES = 20 * 1024 * 1024
const MAX_VIDEO_BYTES = 200 * 1024 * 1024

/** 视频扩展名（用于按目标路径预判耗时，决定下载超时档位） */
const VIDEO_EXT_RE = /\.(mp4|m4v|webm|mov|mkv|avi|flv)$/i

/** 视频容器魔数 → MIME（与 Web 端 core/storage/asset_fetcher.py 同规则） */
export function sniffVideoMime(buf: Buffer): string | null {
  if (buf.length < 12) return null
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1')
    return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4'
  }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return 'video/webm'
  }
  if (
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'AVI '
  ) {
    return 'video/x-msvideo'
  }
  if (buf.subarray(0, 4).toString('latin1') === 'FLV\x01') return 'video/x-flv'
  return null
}

/** 按魔数识别素材（图片或视频）MIME；无法识别时返回 null */
export function sniffMediaMime(buf: Buffer): string | null {
  return sniffImageMime(buf) ?? sniffVideoMime(buf)
}

/** 判断是否为视频 MIME */
export function isVideoMime(mime: string): boolean {
  return mime.startsWith('video/')
}

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
  /** 相对工作区（交付目录）的保存路径，如 文章标题/figure-1.png、视频标题/成片-1.mp4 */
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
  /** 保存路径别名（与 Web 端 download_asset 返回结构对齐，供提示词统一引用） */
  path: string
  /** MIME 别名（同上） */
  mime_type: string
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
 * 下载远程素材（图片 / 视频）并写入工作区（桌面版 download_asset 工具的实现）。
 *
 * 与 Web 端同名工具保持一致语义：只支持 http(s)、按魔数校验类型、按类型限制
 * 大小与超时、自动创建目录、原子写盘；失败时抛错由调用方转成结构化错误。
 *
 * 视频（「视频创作专家」成片）与图片共用本通道，专家提示词因此不需要任何
 * shell 命令（curl / PowerShell），也就与操作系统和 agent 后端种类解耦。
 */
export async function downloadAssetToWorkspace(
  params: DownloadAssetParams
): Promise<DownloadedAsset> {
  const url = String(params.url ?? '').trim()
  if (!/^https?:\/\//i.test(url)) throw new Error('仅支持 http(s) 素材地址')

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
  // 视频体积大、下载慢，按较长超时兜住；图片（按目标扩展名预判）仍按原超时约束
  const timeoutMs = VIDEO_EXT_RE.test(relPath) ? VIDEO_DOWNLOAD_TIMEOUT_MS : DOWNLOAD_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let buffer: Buffer
  let declaredMime = ''
  try {
    const response = await fetchImpl(url, { signal: controller.signal })
    if (!response.ok) throw new Error('素材下载失败（HTTP ' + response.status + '）')
    declaredMime = (response.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase()
    const declaredLength = Number(response.headers.get('content-length') ?? '0')
    if (declaredLength > MAX_VIDEO_BYTES) throw new Error('素材超过大小上限')
    buffer = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('素材下载超时')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }

  if (!buffer.length) throw new Error('素材内容为空')
  if (buffer.length > MAX_VIDEO_BYTES) throw new Error('素材超过大小上限')

  const mime =
    sniffMediaMime(buffer) ??
    (declaredMime.startsWith('image/') || declaredMime.startsWith('video/')
      ? declaredMime
      : '')
  if (!mime) throw new Error('不支持的素材类型：' + (declaredMime || 'unknown'))
  // 图片仍按图片上限校验，不因视频上限放宽而失效
  if (!isVideoMime(mime) && buffer.length > MAX_ASSET_BYTES) {
    throw new Error('图片超过大小上限')
  }

  mkdirSync(dirname(target), { recursive: true })
  const tmpPath = target + '.' + createHash('sha1').update(String(Date.now())).digest('hex').slice(0, 8) + '.tmp'
  writeFileSync(tmpPath, buffer)
  renameSync(tmpPath, target)

  return {
    relPath,
    absPath: target,
    size: buffer.length,
    mime,
    path: relPath,
    mime_type: mime
  }
}

/** 判断素材文件是否已存在（重复下载时可短路） */
export function assetExists(workspaceDir: string, relPath: string): boolean {
  try {
    return existsSync(resolve(resolve(workspaceDir), normalizeAssetRelPath(relPath)))
  } catch {
    return false
  }
}
