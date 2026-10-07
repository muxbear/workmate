import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { resolveAppIconPath } from '../../../src/main/services/appIcon'

/**
 * 应用图标路径解析单测。
 *
 * 钉住的是 2026-10-07 实机故障（✕ 关闭弹「托盘不可用：Failed to load image from path」）的
 * 防回归：图标路径必须按固定候选解析、不依赖打包器 `?asset` 产物，且 asarUnpack 实体文件优先。
 */

/** 用「只存在给定集合」的假 exists 模拟三种部署布局 */
function existsOnly(...paths: string[]): (path: string) => boolean {
  const set = new Set(paths)
  return (path) => set.has(path)
}

describe('resolveAppIconPath', () => {
  const devDirname = resolve('D:/proj/desktop/out/main')

  it('开发态：命中 out/main 上两级的仓库 resources', () => {
    const expected = resolve('D:/proj/desktop/resources/icon.png')
    expect(resolveAppIconPath({ dirname: devDirname, exists: existsOnly(expected) })).toBe(expected)
  })

  it('打包态：优先 app.asar.unpacked 实体文件，而不是 app.asar 内逻辑路径', () => {
    const appDirname = resolve('C:/app/resources/app.asar/out/main')
    const unpacked = resolve('C:/app/resources/app.asar.unpacked/resources/icon.png')
    const inAsar = resolve('C:/app/resources/app.asar/resources/icon.png')
    // 两个都存在时选 unpacked 实体文件（asar 内路径对 nativeImage 未必可读）
    expect(
      resolveAppIconPath({ dirname: appDirname, exists: existsOnly(unpacked, inAsar) })
    ).toBe(unpacked)
    // 只有逻辑路径存在（未配置 asarUnpack）时也能兜住
    expect(resolveAppIconPath({ dirname: appDirname, exists: existsOnly(inAsar) })).toBe(inAsar)
  })

  it('兜底：extraResources 分发到 resourcesPath 时也能命中', () => {
    const extra = resolve('C:/app/resources/icon.png')
    expect(
      resolveAppIconPath({
        dirname: resolve('C:/app/resources/app.asar/out/main'),
        resourcesPath: resolve('C:/app/resources'),
        exists: existsOnly(extra)
      })
    ).toBe(extra)
  })

  it('全都不存在：返回打包态候选路径（交由 Tray 报缺失路径走退化提示）', () => {
    const expected = resolve('C:/app/resources/app.asar/resources/icon.png')
    expect(
      resolveAppIconPath({
        dirname: resolve('C:/app/resources/app.asar/out/main'),
        resourcesPath: resolve('C:/app/resources'),
        exists: () => false
      })
    ).toBe(expected)
  })

  it('路径大小写不影响解析（构建 cwd 大小写不同也能命中同一文件）', () => {
    const canonical = resolve('D:/proj/desktop/resources/icon.png')
    // 文件系统大小写不敏感：以小写 cwd 构建时，existsSync 对任一写法都返回 true
    expect(
      resolveAppIconPath({
        dirname: resolve('d:/PROJ/desktop/out/main'),
        exists: (path) => path.toLowerCase() === canonical.toLowerCase()
      })
    ).toBe(resolve('d:/PROJ/desktop/resources/icon.png'))
  })
})
