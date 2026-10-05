import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BinaryManager, type RuntimeId } from '../../../src/main/runtime/BinaryManager'
import type { SettingsStore } from '../../../src/main/settings/SettingsStore'

/**
 * BinaryManager 表征测试（R8-9 前置补测：拆分前先钉住公开面行为）。
 *
 * 只用公开 API + 预置 registry.json/目录来钉：
 * - 注册表读取（缺失/损坏再生）与最新版本语义；
 * - listRuntimes 状态推导（installed/not-installed）与启用开关联动；
 * - getExecutablePath 三重门（总开关 / 分开关 / verified）；
 * - uninstall 的目录清理 + 注册表清空 + 并发/未安装守卫。
 * 不触网（download/install 全流程的测试在拆分引入注入口后补）。
 */

function settingsStub(values: Record<string, unknown>): SettingsStore {
  return {
    get: (key: string) => values[key]
  } as unknown as SettingsStore
}

interface SeedEntry {
  source?: string
  executablePath: string
  installPath: string
  installedAt: number
  verified?: boolean
}

function seedRegistry(
  baseDir: string,
  binaries: Record<string, Record<string, SeedEntry>>
): void {
  const cacheDir = join(baseDir, '.cache')
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(
    join(cacheDir, 'registry.json'),
    JSON.stringify({
      version: 1,
      lastUpdated: 0,
      binaries: Object.fromEntries(
        Object.entries(binaries).map(([dirName, versions]) => [
          dirName,
          Object.fromEntries(
            Object.entries(versions).map(([ver, entry]) => [
              ver,
              {
                source: 'managed',
                verified: true,
                ...entry
              }
            ])
          )
        ])
      )
    }),
    'utf-8'
  )
}

describe('BinaryManager（R8-9 表征测试）', () => {
  let baseDir: string
  let settings: Record<string, unknown>

  const make = (): BinaryManager => new BinaryManager(baseDir, settingsStub(settings))

  beforeEach(() => {
    baseDir = join(tmpdir(), `ke-bin-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
    mkdirSync(baseDir, { recursive: true })
    settings = { 'runtime.enabled': true }
  })

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true })
  })

  it('注册表缺失：全新起步，所有运行时 not-installed', () => {
    const info = make().listRuntimes()
    expect(info.map((r) => r.id)).toEqual<RuntimeId[]>(['python', 'node', 'git'])
    expect(info.every((r) => r.status === 'not-installed')).toBe(true)
    expect(info.every((r) => r.enabled === true)).toBe(true)
  })

  it('注册表损坏 JSON：不抛错，按全新起步（可继续写入）', () => {
    const cacheDir = join(baseDir, '.cache')
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(join(cacheDir, 'registry.json'), '{ not json', 'utf-8')
    const info = make().listRuntimes()
    expect(info.every((r) => r.status === 'not-installed')).toBe(true)
  })

  it('已安装（verified）：状态/版本取最新 installedAt 的那条', () => {
    seedRegistry(baseDir, {
      python: {
        '3.12.0': { executablePath: join(baseDir, 'python', 'old.exe'), installPath: 'old', installedAt: 1 },
        '3.13.0': { executablePath: join(baseDir, 'python', 'new.exe'), installPath: 'new', installedAt: 2 }
      }
    })
    const python = make().listRuntimes().find((r) => r.id === 'python')!
    expect(python.status).toBe('installed')
    expect(python.version).toBe('3.13.0')
    expect(python.executablePath).toBe(join(baseDir, 'python', 'new.exe'))
  })

  it('verified=false 的注册表条目不算已安装', () => {
    seedRegistry(baseDir, {
      node: {
        '22.0.0': {
          executablePath: join(baseDir, 'node', 'node.exe'),
          installPath: 'node',
          installedAt: 1,
          verified: false
        }
      }
    })
    const node = make().listRuntimes().find((r) => r.id === 'node')!
    expect(node.status).toBe('not-installed')
    expect(node.executablePath).toBeUndefined()
  })

  it('启用开关：总开关关 → 全部 enabled=false；分开关关 → 仅该运行时 false', () => {
    settings = { 'runtime.enabled': false }
    expect(make().listRuntimes().every((r) => r.enabled === false)).toBe(true)

    settings = { 'runtime.enabled': true, 'runtime.git.enabled': false }
    const info = make().listRuntimes()
    expect(info.find((r) => r.id === 'git')!.enabled).toBe(false)
    expect(info.find((r) => r.id === 'node')!.enabled).toBe(true)
  })

  it('getExecutablePath 三重门：总开关 / 分开关 / verified', () => {
    const exe = join(baseDir, 'node', 'node.exe')
    seedRegistry(baseDir, {
      node: { '22.0.0': { executablePath: exe, installPath: 'node', installedAt: 1 } }
    })
    expect(make().getExecutablePath('node')).toBe(exe)

    settings['runtime.enabled'] = false
    expect(make().getExecutablePath('node')).toBeNull()

    settings = { 'runtime.enabled': true, 'runtime.node.enabled': false }
    expect(make().getExecutablePath('node')).toBeNull()

    seedRegistry(baseDir, {
      node: {
        '22.0.0': { executablePath: exe, installPath: 'node', installedAt: 1, verified: false }
      }
    })
    expect(make().getExecutablePath('node')).toBeNull()
  })

  it('uninstall：删除安装目录 + 清空注册表；未安装时报错', async () => {
    const installPath = join(baseDir, 'python', 'versions', '3.13.0')
    mkdirSync(installPath, { recursive: true })
    writeFileSync(join(installPath, 'python.exe'), 'stub')
    seedRegistry(baseDir, {
      python: {
        '3.13.0': {
          executablePath: join(installPath, 'python.exe'),
          installPath,
          installedAt: 1
        }
      }
    })
    const manager = make()
    await manager.uninstallRuntime('python')
    expect(existsSync(installPath)).toBe(false)
    expect(manager.listRuntimes().find((r) => r.id === 'python')!.status).toBe('not-installed')
    // 注册表文件已落盘：新实例读到的是清空后的状态
    expect(make().getExecutablePath('python')).toBeNull()

    await expect(manager.uninstallRuntime('python')).rejects.toThrow(/未安装/)
  })

  it('init：建目录结构（base/.cache/versions×3），幂等', () => {
    const manager = make()
    manager.init()
    manager.init()
    expect(existsSync(join(baseDir, '.cache'))).toBe(true)
    expect(existsSync(join(baseDir, 'python', 'versions'))).toBe(true)
    expect(existsSync(join(baseDir, 'node', 'versions'))).toBe(true)
    expect(existsSync(join(baseDir, 'PortableGit', 'versions'))).toBe(true)
    expect(manager.getBaseDir()).toBe(baseDir)
    // 注册表文件此时尚未创建（无写入发生）
    expect(existsSync(join(baseDir, '.cache', 'registry.json'))).toBe(false)
  })

  it('注册表写入后可回读（uninstall 路径落盘验证）', async () => {
    const installPath = join(baseDir, 'node', 'versions', '22.0.0')
    mkdirSync(installPath, { recursive: true })
    seedRegistry(baseDir, {
      node: { '22.0.0': { executablePath: join(installPath, 'node.exe'), installPath, installedAt: 1 } }
    })
    const manager = make()
    await manager.uninstallRuntime('node')
    const raw = JSON.parse(readFileSync(join(baseDir, '.cache', 'registry.json'), 'utf-8')) as {
      binaries: Record<string, unknown>
    }
    expect(raw.binaries['node']).toEqual({})
  })
})

/**
 * 安装全流程（R8-9 注入口）：下载/解压/探测全部假实现，覆盖 progress 事件序列、
 * 已安装快路径、失败清理与并发守卫；不触网。
 */
describe('BinaryManager.installRuntime（R8-9 注入口）', () => {
  let baseDir: string
  let settings: Record<string, unknown>
  let downloadedTo: string | null
  let extractorCalls: string[]

  const makeDeps = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    download: async (
      _url: string,
      destPath: string,
      options: { onProgress?: (p: { receivedBytes: number; totalBytes: number }) => void }
    ) => {
      downloadedTo = destPath
      options.onProgress?.({ receivedBytes: 5, totalBytes: 10 })
      writeFileSync(destPath, 'archive-bytes')
      options.onProgress?.({ receivedBytes: 12, totalBytes: 12 })
    },
    extractors: {
      zip: {
        extract: async (_archive: string, dest: string) => {
          extractorCalls.push('zip')
          mkdirSync(dest, { recursive: true })
          writeFileSync(join(dest, 'python.exe'), 'stub-exe')
        }
      },
      '7z-sfx': {
        extract: async () => {
          extractorCalls.push('7z-sfx')
          throw new Error('unexpected extractor')
        }
      }
    },
    detect: async (id: string) => (id === 'python' ? '3.13.0' : null),
    ...overrides
  })

  const make = (deps = makeDeps()): BinaryManager =>
    new BinaryManager(baseDir, settingsStub(settings), deps as never)

  beforeEach(() => {
    baseDir = join(tmpdir(), `ke-bin-flow-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
    mkdirSync(baseDir, { recursive: true })
    settings = { 'runtime.enabled': true }
    downloadedTo = null
    extractorCalls = []
  })

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true })
  })

  it('完整流程：progress 序列齐全 → 注册表落盘 → 临时包清理', async () => {
    const manager = make()
    const phases: string[] = []
    manager.on('progress', (p: { phase: string }) => phases.push(p.phase))
    // 显式传版本：缺省会用 meta.defaultVersion 组装安装路径
    await manager.installRuntime('python', '3.13.0')

    expect(phases).toEqual([
      'downloading',
      'downloading',
      'downloading',
      'extracting',
      'verifying',
      'done'
    ])
    expect(extractorCalls).toEqual(['zip'])
    // finally 清理了临时压缩包
    expect(downloadedTo).not.toBeNull()
    expect(existsSync(downloadedTo!)).toBe(false)
    // 注册表落盘 + 可执行文件路径可用（新实例回读）
    const exePath = join(baseDir, 'python', 'versions', '3.13.0', 'python.exe')
    expect(manager.getExecutablePath('python')).toBe(exePath)
    expect(new BinaryManager(baseDir, settingsStub(settings)).getExecutablePath('python')).toBe(
      exePath
    )
  })

  it('已安装快路径：可执行文件在 + 探测成功 → 不触下载', async () => {
    const installPath = join(baseDir, 'python', 'versions', '3.13.0')
    mkdirSync(installPath, { recursive: true })
    writeFileSync(join(installPath, 'python.exe'), 'stub-exe')
    let downloadCalled = false
    const manager = make(
      makeDeps({
        download: async () => {
          downloadCalled = true
        }
      })
    )
    await manager.installRuntime('python', '3.13.0')
    expect(downloadCalled).toBe(false)
    expect(manager.getExecutablePath('python')).toBe(join(installPath, 'python.exe'))
  })

  it('失败路径：下载报错 → error 进度 + 抛错 + inflight 清理（可重试）', async () => {
    let attempts = 0
    const manager = make(
      makeDeps({
        download: async () => {
          attempts += 1
          throw new Error('下载请求失败：boom')
        }
      })
    )
    const events: Array<{ phase: string }> = []
    manager.on('progress', (p: { phase: string }) => events.push(p))
    await expect(manager.installRuntime('python')).rejects.toThrow(/boom/)
    expect(events.at(-1)?.phase).toBe('error')
    // inflight 已清：重试能再次进入下载
    await expect(manager.installRuntime('python')).rejects.toThrow(/boom/)
    expect(attempts).toBe(2)
  })

  it('并发守卫：安装进行中再次调用被拒；完成后恢复', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const manager = make(
      makeDeps({
        download: async (
          _u: string,
          dest: string,
          o: { onProgress?: (p: { receivedBytes: number; totalBytes: number }) => void }
        ) => {
          await gate
          writeFileSync(dest, 'x')
          o.onProgress?.({ receivedBytes: 1, totalBytes: 1 })
        }
      })
    )
    const first = manager.installRuntime('python')
    await expect(manager.installRuntime('python')).rejects.toThrow(/正在处理中/)
    release()
    await first
    // 完成后 inflight 已清：listRuntimes 不再是 installing
    expect(manager.listRuntimes().find((r) => r.id === 'python')!.status).toBe('installed')
  })
})
