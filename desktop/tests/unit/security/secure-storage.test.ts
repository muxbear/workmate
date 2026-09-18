import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ElectronSafeStorage,
  InMemorySecureStorage,
  type SafeStorageLike
} from '../../../src/main/security/secure-storage'

/** fake safeStorage：记录调用，可配置是否可用 */
function createFakeSafeStorage(): SafeStorageLike & { encryptCalls: number; decryptCalls: number } {
  const state: Record<string, string> = {}
  const fake = {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string): Buffer => {
      fake.encryptCalls++
      const key = 'enc:' + plain
      state[key] = plain
      return Buffer.from(key)
    },
    decryptString: (buffer: Buffer): string => {
      fake.decryptCalls++
      return state[buffer.toString()] ?? ''
    },
    encryptCalls: 0,
    decryptCalls: 0
  }
  return fake
}

describe('InMemorySecureStorage', () => {
  it('SEC-11a: 存入后可取回', () => {
    const s = new InMemorySecureStorage()
    s.set('k1', 'v1')
    expect(s.get('k1')).toBe('v1')
  })

  it('不存在的 key 返回 null', () => {
    const s = new InMemorySecureStorage()
    expect(s.get('nope')).toBeNull()
  })

  it('delete 后返回 null', () => {
    const s = new InMemorySecureStorage()
    s.set('k', 'v')
    s.delete('k')
    expect(s.get('k')).toBeNull()
  })
})

describe('ElectronSafeStorage', () => {
  it('SEC-11b: 加密写入文件，解密还原', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kw-sec-'))
    const fake = createFakeSafeStorage()
    const s = new ElectronSafeStorage(join(dir, 'secrets.bin'), fake)

    s.set('master-key', 'my-secret')
    expect(fake.encryptCalls).toBe(1)
    expect(existsSync(join(dir, 'secrets.bin'))).toBe(true)

    // 重新实例化（模拟重启），从文件解密
    const s2 = new ElectronSafeStorage(join(dir, 'secrets.bin'), fake)
    expect(s2.get('master-key')).toBe('my-secret')
  })

  it('文件损坏时返回 null 不崩溃', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kw-sec-'))
    const fake = createFakeSafeStorage()
    const s = new ElectronSafeStorage(join(dir, 'secrets.bin'), fake)
    s.set('k', 'v')
    // 篡改文件后，用新实例读取（实例有内存缓存，必须重新构造才走文件路径）
    writeFileSync(join(dir, 'secrets.bin'), 'corrupted')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fresh = new ElectronSafeStorage(join(dir, 'secrets.bin'), fake)
    expect(fresh.get('k')).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('解密失败时删除损坏文件，后续可正常写入新密钥', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kw-sec-'))
    const fake = createFakeSafeStorage()
    const s = new ElectronSafeStorage(join(dir, 'secrets.bin'), fake)
    s.set('k', 'v')
    // 篡改文件后，用新实例读取（解密失败）
    writeFileSync(join(dir, 'secrets.bin'), 'corrupted')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fresh = new ElectronSafeStorage(join(dir, 'secrets.bin'), fake)
    expect(fresh.get('k')).toBeNull()
    // 解密失败后旧文件应被删除
    expect(existsSync(join(dir, 'secrets.bin'))).toBe(false)
    // 后续 set() 可正常创建新文件
    fresh.set('new-key', 'new-value')
    expect(existsSync(join(dir, 'secrets.bin'))).toBe(true)
    expect(fresh.get('new-key')).toBe('new-value')
    warnSpy.mockRestore()
  })

  it('persist 写入失败时不抛异常，密钥保留在内存中', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kw-sec-'))
    const fake = createFakeSafeStorage()
    // 使用不存在的目录模拟写入失败
    const s = new ElectronSafeStorage(join(dir, 'nonexistent', 'secrets.bin'), fake)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // set 不应抛出异常
    expect(() => s.set('k', 'v')).not.toThrow()
    // 密钥仍在内存中
    expect(s.get('k')).toBe('v')
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
  it('单条密钥解密失败时保留其余密钥，不隔离整个文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kw-sec-'))
    const file = join(dir, 'secrets.bin')
    const good = Buffer.from('enc:good').toString('base64')
    const bad = Buffer.from('enc:bad').toString('base64')
    writeFileSync(
      file,
      JSON.stringify([
        { k: 'keep', v: good },
        { k: 'lost', v: bad }
      ]),
      'utf-8'
    )
    const fake: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (plain: string) => Buffer.from('enc:' + plain),
      decryptString: (buffer: Buffer) => {
        const text = buffer.toString()
        if (text === 'enc:good') return 'good-value'
        throw new Error('cannot decrypt')
      }
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const storage = new ElectronSafeStorage(file, fake)
    expect(storage.get('keep')).toBe('good-value')
    expect(storage.get('lost')).toBeNull()
    // 文件仍在（未整体隔离），也没有产生损坏备份
    expect(existsSync(file)).toBe(true)
    expect(storage.getLastCorruptBackup()).toBeNull()
    warnSpy.mockRestore()
  })

  it('全部记录解密失败时把文件隔离成 .corrupt 备份而不是直接删除', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kw-sec-'))
    const file = join(dir, 'secrets.bin')
    const bad = Buffer.from('enc:bad').toString('base64')
    writeFileSync(file, JSON.stringify([{ k: 'a', v: bad }]), 'utf-8')
    const fake: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (plain: string) => Buffer.from('enc:' + plain),
      decryptString: () => {
        throw new Error('cannot decrypt')
      }
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const storage = new ElectronSafeStorage(file, fake)
    expect(storage.get('a')).toBeNull()
    const backup = storage.getLastCorruptBackup()
    expect(backup).not.toBeNull()
    expect(existsSync(backup as string)).toBe(true)
    expect(existsSync(file)).toBe(false)
    warnSpy.mockRestore()
  })
})
