import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { basename, join } from 'path'
import { BRAND_LOGO_FILE_RE } from './schema'

/**
 * 系统 LOGO 存储服务（「系统设置 → 系统标识」）
 *
 * - 存放位置：~/.ke-work/branding/logo-<时间戳>.<ext>（应用数据目录，与登录态无关）
 * - settings.json 只持久化文件名（见 schema 的 ui.brandLogo）；图片字节不进配置，
 *   避免每次写设置都复制一份 .bak 造成的体积放大。
 * - 类型判定基于魔数，不信任文件名；SVG 额外拦截脚本与事件属性
 *   （渲染层以 <img src> 引用，脚本本就不会执行，此处为纵深防御）。
 * - 写入：临时文件 + rename 原子替换；替换成功后由调用方清理旧文件。
 * - 读取失败（缺失/损坏）不抛错，返回空快照，由 UI 回退到内置默认 LOGO。
 */
export const BRAND_LOGO_MAX_BYTES = 1024 * 1024
/** LOGO 子目录名（对齐 ~/.ke-work 顶层平铺布局，独立子目录便于备份与清理） */
export const BRAND_LOGO_DIR_NAME = 'branding'

/** 单次上传入参（渲染层 file.arrayBuffer() 经 IPC 结构克隆传入） */
export interface BrandLogoUpload {
  /** 原始文件名（仅作提示，类型判定以字节为准） */
  name?: string
  /** 图片字节 */
  bytes: ArrayBuffer | Uint8Array
}

/** 当前 LOGO 快照（返回给渲染层） */
export interface BrandLogoSnapshot {
  /** settings.json 持久化值（文件名）；空串 = 未自定义 */
  fileName: string
  /** 渲染层 <img src> 直接可用；未自定义为空串 */
  dataUrl: string
  /** 是否已自定义（UI 据此决定是否显示「恢复默认」） */
  customized: boolean
}

export type BrandLogoMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml'

const MIME_EXT: Record<BrandLogoMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg'
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 空快照（未自定义 / 文件不可读的统一返回值） */
function emptySnapshot(): BrandLogoSnapshot {
  return { fileName: '', dataUrl: '', customized: false }
}

function toBuffer(bytes: ArrayBuffer | Uint8Array): Buffer {
  return bytes instanceof Uint8Array ? Buffer.from(bytes) : Buffer.from(bytes)
}

function toDataUrl(mime: BrandLogoMime, buf: Buffer): string {
  return 'data:' + mime + ';base64,' + buf.toString('base64')
}

/** 由扩展名反推 MIME（读盘时用于给已存文件定 MIME；失败再回退魔数嗅探） */
function mimeFromFileName(fileName: string): BrandLogoMime | null {
  const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
    case 'svg':
      return 'image/svg+xml'
    default:
      return null
  }
}

/** SVG 判定 + 安全校验：必须含 <svg> 根节点，且不含脚本 / 事件属性 / javascript: */
function sniffSvg(buf: Buffer): BrandLogoMime | null {
  const head = buf.subarray(0, 4096).toString('utf-8').replace(/^\uFEFF/, '')
  if (!/<svg[\s>]/i.test(head)) return null
  const text = buf.toString('utf-8')
  if (/<script[\s>]/i.test(text)) return null
  if (/\son[a-z]+\s*=/i.test(text)) return null
  if (/javascript:/i.test(text)) return null
  return 'image/svg+xml'
}

/** 魔数嗅探：返回识别到的 MIME；未命中返回 null（用于拒绝伪装扩展名的文件） */
function sniffMime(buf: Buffer): BrandLogoMime | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return sniffSvg(buf)
}

export class BrandLogoService {
  private readonly dir: string

  constructor(baseDir: string) {
    this.dir = join(baseDir, BRAND_LOGO_DIR_NAME)
  }

  /** LOGO 目录绝对路径（测试与排查用） */
  getDir(): string {
    return this.dir
  }

  /** 读取当前 LOGO；文件缺失/损坏/非法文件名一律回退空快照，不抛错 */
  load(fileName: string): BrandLogoSnapshot {
    const filePath = this.resolve(fileName)
    if (!filePath || !existsSync(filePath)) return emptySnapshot()
    try {
      const buf = readFileSync(filePath)
      const mime = mimeFromFileName(fileName) ?? sniffMime(buf)
      if (!mime) return emptySnapshot()
      return { fileName, dataUrl: toDataUrl(mime, buf), customized: true }
    } catch (err) {
      console.warn('[brand-logo] load failed:', err)
      return emptySnapshot()
    }
  }

  /** 保存上传的 LOGO：校验 → 原子写入 → 返回快照；非法输入抛错（IPC 转 { success: false }） */
  save(upload: BrandLogoUpload): BrandLogoSnapshot {
    const buf = toBuffer(upload?.bytes ?? new Uint8Array())
    if (!buf.length) throw new Error('LOGO 文件为空')
    if (buf.length > BRAND_LOGO_MAX_BYTES) {
      throw new Error('LOGO 大小不能超过 ' + Math.round(BRAND_LOGO_MAX_BYTES / 1024 / 1024) + 'MB')
    }
    const mime = sniffMime(buf)
    if (!mime) throw new Error('仅支持 PNG / JPG / WEBP / SVG 格式的图片')

    mkdirSync(this.dir, { recursive: true })
    const fileName = 'logo-' + Date.now() + '.' + MIME_EXT[mime]
    const target = join(this.dir, fileName)
    const tmp = target + '.tmp'
    writeFileSync(tmp, buf)
    renameSync(tmp, target)
    return { fileName, dataUrl: toDataUrl(mime, buf), customized: true }
  }

  /** 删除指定 LOGO 文件；文件名非法或文件不存在时静默跳过，删除失败只告警 */
  remove(fileName: string): void {
    const filePath = this.resolve(fileName)
    if (!filePath || !existsSync(filePath)) return
    try {
      unlinkSync(filePath)
    } catch (err) {
      console.warn('[brand-logo] remove failed:', err)
    }
  }

  /** 清理目录内的历史残留（保留 keep 指定的文件；启动时调用，避免多次替换后堆积） */
  pruneExcept(keep: string): void {
    if (!existsSync(this.dir)) return
    try {
      for (const name of readdirSync(this.dir)) {
        if (name === keep) continue
        this.remove(name)
      }
    } catch (err) {
      console.warn('[brand-logo] prune failed:', err)
    }
  }

  /** 文件名 → 绝对路径；非法文件名（含路径分隔/上跳）返回 null，防越权读写 */
  private resolve(fileName: string): string | null {
    if (!fileName || basename(fileName) !== fileName) return null
    if (!BRAND_LOGO_FILE_RE.test(fileName)) return null
    return join(this.dir, fileName)
  }
}
