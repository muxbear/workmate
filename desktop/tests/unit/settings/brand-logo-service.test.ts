import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  BRAND_LOGO_MAX_BYTES,
  BrandLogoService
} from '../../../src/main/settings/BrandLogoService'

/** 最小 PNG（仅魔数，BrandLogoService 不解析图像内容） */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d])
])
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" /></svg>',
  'utf-8'
)

let baseDir: string
let service: BrandLogoService

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'ke-logo-'))
  service = new BrandLogoService(baseDir)
})

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true })
})

describe('BrandLogoService（系统 LOGO 存取）', () => {
  it('未自定义时返回空快照（文件缺失/文件名非法都不抛错）', () => {
    const empty = { fileName: '', dataUrl: '', customized: false }
    expect(service.load('')).toEqual(empty)
    expect(service.load('logo-1.png')).toEqual(empty)
    expect(service.load('../../settings.json')).toEqual(empty)
  })

  it('PNG：按魔数识别 → 落盘 branding/logo-<时间戳>.png → 生成 data URL', () => {
    const snap = service.save({ name: 'a.png', bytes: PNG })
    expect(snap.fileName.startsWith('logo-')).toBe(true)
    expect(snap.fileName.endsWith('.png')).toBe(true)
    expect(snap.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(existsSync(join(service.getDir(), snap.fileName))).toBe(true)
    // 读回与写入一致（供 UI 刷新与重启后回填）
    expect(service.load(snap.fileName)).toEqual(snap)
  })

  it('SVG：合法文档落盘 .svg；含脚本或事件属性被拒绝', () => {
    const snap = service.save({ name: 'logo.svg', bytes: SVG })
    expect(snap.fileName.endsWith('.svg')).toBe(true)
    expect(snap.dataUrl.startsWith('data:image/svg+xml;base64,')).toBe(true)

    const withScript = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    )
    expect(() => service.save({ bytes: withScript })).toThrow()
    const withHandler = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'
    )
    expect(() => service.save({ bytes: withHandler })).toThrow()
  })

  it('伪装扩展名（内容不是图片）被拒，且不创建目录', () => {
    expect(() => service.save({ name: 'a.png', bytes: Buffer.from('not an image') })).toThrow()
    expect(existsSync(service.getDir())).toBe(false)
  })

  it('空文件与超过 1MB 的图片被拒', () => {
    expect(() => service.save({ bytes: new Uint8Array() })).toThrow()
    const tooBig = Buffer.alloc(BRAND_LOGO_MAX_BYTES + 1)
    PNG.copy(tooBig)
    expect(() => service.save({ bytes: tooBig })).toThrow()
  })

  it('remove：只删除 branding 目录内的合法文件名（防路径穿越）', () => {
    const snap = service.save({ bytes: PNG })
    const outside = join(baseDir, 'logo-9999999999999.png')
    writeFileSync(outside, PNG)

    service.remove('../../settings.json')
    service.remove('C:\\Windows\\system.ini')
    service.remove('logo-9999999999999.png')

    expect(existsSync(outside)).toBe(true) // 目录外同名文件不受影响
    expect(existsSync(join(service.getDir(), snap.fileName))).toBe(true)
    service.remove(snap.fileName)
    expect(existsSync(join(service.getDir(), snap.fileName))).toBe(false)
  })

  it('pruneExcept：启动清理历史残留，保留 keep 指定的文件', () => {
    mkdirSync(service.getDir(), { recursive: true })
    writeFileSync(join(service.getDir(), 'logo-1.png'), PNG)
    writeFileSync(join(service.getDir(), 'logo-2.png'), PNG)
    service.pruneExcept('logo-2.png')
    expect(existsSync(join(service.getDir(), 'logo-1.png'))).toBe(false)
    expect(existsSync(join(service.getDir(), 'logo-2.png'))).toBe(true)
  })
})
