import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canUseDesktopNotification,
  playNotificationSound,
  requestDesktopPermission,
  shouldUseDesktopNotification,
  showDesktopNotification,
} from '@/utils/browserNotify'

/**
 * 浏览器通知与提示音。
 *
 * jsdom 不实现 Notification，所以默认情况下 `canUseDesktopNotification()` 就是 false——
 * 这本身也是一条要钉住的契约（浏览器不支持时不能抛异常）。
 */

const originalNotification = (globalThis as { Notification?: unknown }).Notification

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    configurable: true,
  })
}

function installNotification(
  permission: NotificationPermission,
  grantResult?: NotificationPermission,
) {
  const ctor = vi.fn()
  Object.defineProperty(ctor, 'permission', { value: permission, configurable: true })
  Object.defineProperty(ctor, 'requestPermission', {
    value: vi.fn(async () => grantResult ?? permission),
    configurable: true,
  })
  Object.defineProperty(globalThis, 'Notification', {
    value: ctor,
    writable: true,
    configurable: true,
  })
  return ctor
}

beforeEach(() => {
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
  setVisibility('hidden')
})

afterEach(() => {
  Object.defineProperty(globalThis, 'Notification', {
    value: originalNotification,
    writable: true,
    configurable: true,
  })
})

describe('可用性判定', () => {
  it('浏览器没有 Notification 时为不可用，且不抛异常', () => {
    Object.defineProperty(globalThis, 'Notification', {
      value: undefined,
      writable: true,
      configurable: true,
    })

    expect(canUseDesktopNotification()).toBe(false)
    expect(() => showDesktopNotification('标题', '正文')).not.toThrow()
  })

  it('非安全上下文（HTTP 明文）时为不可用', () => {
    installNotification('granted')
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true })

    expect(canUseDesktopNotification()).toBe(false)
  })
})

describe('权限申请', () => {
  it('不可用环境直接返回 denied，不去调浏览器 API', async () => {
    Object.defineProperty(globalThis, 'Notification', {
      value: undefined,
      writable: true,
      configurable: true,
    })

    await expect(requestDesktopPermission()).resolves.toBe('denied')
  })

  it('可用时透传浏览器的授权结果', async () => {
    installNotification('default', 'granted')

    await expect(requestDesktopPermission()).resolves.toBe('granted')
  })
})

describe('是否该弹系统通知', () => {
  it('已授权且页面不可见 → 该弹', () => {
    installNotification('granted')
    expect(shouldUseDesktopNotification()).toBe(true)
  })

  it('页面可见 → 不弹（前台已有端内提示）', () => {
    installNotification('granted')
    setVisibility('visible')

    expect(shouldUseDesktopNotification()).toBe(false)
  })

  it('未授权 → 不弹', () => {
    installNotification('denied')
    expect(shouldUseDesktopNotification()).toBe(false)
  })
})

describe('弹出系统通知', () => {
  it('满足条件时用标题与正文构造一次通知', () => {
    const ctor = installNotification('granted')

    showDesktopNotification('新公告：周会调整', '改到周四')

    expect(ctor).toHaveBeenCalledTimes(1)
    expect(ctor).toHaveBeenCalledWith('新公告：周会调整', { body: '改到周四' })
  })

  it('页面可见时一次都不构造', () => {
    const ctor = installNotification('granted')
    setVisibility('visible')

    showDesktopNotification('标题', '正文')

    expect(ctor).not.toHaveBeenCalled()
  })

  it('构造函数抛异常时被吞掉，不影响通知链路', () => {
    const ctor = vi.fn(() => {
      throw new Error('系统禁止通知')
    })
    Object.defineProperty(ctor, 'permission', { value: 'granted', configurable: true })
    Object.defineProperty(globalThis, 'Notification', {
      value: ctor,
      writable: true,
      configurable: true,
    })

    expect(() => showDesktopNotification('标题', '正文')).not.toThrow()
  })
})

describe('提示音', () => {
  it('none 不产生任何音频节点', () => {
    const create = vi.spyOn(
      (globalThis as unknown as { AudioContext: new () => AudioContext }).AudioContext.prototype,
      'createOscillator',
    )

    playNotificationSound('none')

    expect(create).not.toHaveBeenCalled()
    create.mockRestore()
  })

  it('清脆与柔和都能播放且不抛异常', () => {
    expect(() => playNotificationSound('crisp')).not.toThrow()
    expect(() => playNotificationSound('soft')).not.toThrow()
  })
})
