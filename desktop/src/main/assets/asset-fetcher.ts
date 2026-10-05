import { mkdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * 素材下载 - 校验 - 原子落盘共享管线（R8-6：收编 RemoteImageService 与
 * ArtifactAssetService 两份同构实现，消除各自维护超时/上限/错误文案/原子写的漂移）。
 *
 * 语义逐字保持：
 * - 超时经 AbortController；AbortError 归一为「<noun>下载超时」；
 * - 顺序固定：ok 检查 → content-type 解析（可即时校验）→ content-length 预检 →
 *   读体 → 空体检查 → 体积复检（与两个原实现的可观察行为一致——空体/超限
 *   抛普通 Error，不受 AbortError 归一影响）；
 * - 错误文案按 noun（图片 / 素材）拼装，两域原文案不变；
 * - 落盘一律 mkdir -p → 写 tmp → rename（原子替换）；tmp 命名策略由调用方注入
 *   （图片域为 .sha256.timestamp.tmp，素材域为 <target>.sha1-8.tmp，各自保持原样）。
 */

/** 最小可注入的 fetch 形态（生产传 electron net.fetch；测试注入假实现） */
export type AssetFetchLike = (
  url: string,
  init?: { signal?: AbortSignal }
) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
}>

export interface FetchAssetOptions {
  url: string
  /** 下载超时（毫秒） */
  timeoutMs: number
  /** 内容上限（同时用于 content-length 预检与读体后复检） */
  maxBytes: number
  /** 错误文案主语（「图片」/「素材」） */
  noun: string
  fetchImpl: AssetFetchLike
  /** content-type 解析后的即时校验（如「非图片内容」拦截；抛错即中止下载） */
  onDeclaredMime?: (declaredMime: string) => void
}

export interface FetchedAsset {
  buffer: Buffer
  /** content-type 首段（小写、去参数）；缺失为空串 */
  declaredMime: string
}

/** 下载并做大小/超时校验（不做类型语义校验——那属各域职责） */
export async function fetchAsset(options: FetchAssetOptions): Promise<FetchedAsset> {
  const { url, noun, maxBytes } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    const response = await options.fetchImpl(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`${noun}下载失败（HTTP ${response.status}）`)
    const declaredMime = (response.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase()
    options.onDeclaredMime?.(declaredMime)
    const declaredLength = Number(response.headers.get('content-length') ?? '0')
    if (declaredLength > maxBytes) throw new Error(`${noun}超过大小上限`)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (!buffer.length) throw new Error(`${noun}内容为空`)
    if (buffer.length > maxBytes) throw new Error(`${noun}超过大小上限`)
    return { buffer, declaredMime }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`${noun}下载超时`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 原子落盘：mkdir -p → 写 tmp → rename。
 * @param tmpPathFor 由最终路径生成临时文件路径（各域保留原有命名策略）
 */
export function writeAssetAtomic(
  dir: string,
  fileName: string,
  buffer: Buffer,
  tmpPathFor: (finalPath: string) => string
): void {
  mkdirSync(dir, { recursive: true })
  const finalPath = join(dir, fileName)
  const tmpPath = tmpPathFor(finalPath)
  writeFileSync(tmpPath, buffer)
  renameSync(tmpPath, finalPath)
}
