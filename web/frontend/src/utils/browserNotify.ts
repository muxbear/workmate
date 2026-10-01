/**
 * 浏览器系统通知与提示音。
 *
 * 通知只在**页面不可见**时弹：前台已经有端内的 `ElNotification`，
 * 这正是桌面版那句「运营消息优先端内送达，位于后台时自动转桌面通知」的语义。
 *
 * 提示音用 Web Audio 现场合成，不带音频资源文件。桌面版其实也没有音频素材
 * （`desktop/src/main/index.ts` 只把 `notification.sound` 映射成 `silent: !sound`，
 * 清脆与柔和用的都是系统默认音），所以这里是对桌面版的刻意改进：
 * 让那个下拉的选项真正听得出区别。
 */

import type { NotificationSound } from '@/types/settings'

/** 浏览器通知是否可用。HTTP 明文下 `Notification` 不存在或被禁用。 */
export function canUseDesktopNotification(): boolean {
  return (
    typeof window !== 'undefined' && typeof Notification !== 'undefined' && window.isSecureContext
  )
}

/**
 * 申请通知权限。
 *
 * 必须在**用户手势**里调用（Safari 强制要求），开关的 `@change` 就是手势。
 */
export async function requestDesktopPermission(): Promise<NotificationPermission> {
  if (!canUseDesktopNotification()) return 'denied'
  try {
    return await Notification.requestPermission()
  } catch {
    return 'denied'
  }
}

/** 当前是否该弹系统通知：可用 + 已授权 + 页面不可见，三者缺一不可。 */
export function shouldUseDesktopNotification(): boolean {
  return (
    canUseDesktopNotification() &&
    Notification.permission === 'granted' &&
    typeof document !== 'undefined' &&
    document.visibilityState === 'hidden'
  )
}

/** 弹一条系统通知；不满足条件时静默跳过。 */
export function showDesktopNotification(title: string, body: string): void {
  if (!shouldUseDesktopNotification()) return
  try {
    new Notification(title, { body })
  } catch {
    // 某些环境下构造即抛（系统禁用通知、权限被中途撤销），静默忽略
  }
}

let audioContext: AudioContext | null = null

/** 惰性创建 AudioContext：不在模块加载时创建，避免无谓占用音频设备。 */
function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  if (!audioContext) {
    try {
      audioContext = new Ctor()
    } catch {
      return null
    }
  }
  return audioContext
}

/**
 * 播放提示音。
 *
 * 清脆 = 高频方波 + 快速衰减；柔和 = 低频正弦 + 慢起音并过低通。
 * 页面从未有过用户手势时 AudioContext 处于 suspended，此时静音是正确行为。
 */
export function playNotificationSound(kind: NotificationSound): void {
  if (kind === 'none') return
  const ctx = getAudioContext()
  if (!ctx) return

  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => {
      // 没有手势时 resume 会失败，静音即可
    })
  }

  const now = ctx.currentTime
  const spec =
    kind === 'crisp'
      ? { type: 'square' as OscillatorType, freq: 880, attack: 0.005, duration: 0.12, gain: 0.12 }
      : { type: 'sine' as OscillatorType, freq: 520, attack: 0.06, duration: 0.35, gain: 0.18 }

  const osc = ctx.createOscillator()
  const amp = ctx.createGain()

  osc.type = spec.type
  osc.frequency.setValueAtTime(spec.freq, now)

  // 线性起音 + 指数衰减。指数曲线不能碰到 0，两端都用极小值代替。
  amp.gain.setValueAtTime(0.0001, now)
  amp.gain.linearRampToValueAtTime(spec.gain, now + spec.attack)
  amp.gain.exponentialRampToValueAtTime(0.0001, now + spec.duration)

  if (kind === 'soft') {
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(1200, now)
    osc.connect(filter)
    filter.connect(amp)
  } else {
    osc.connect(amp)
  }
  amp.connect(ctx.destination)

  osc.start(now)
  osc.stop(now + spec.duration + 0.02)
}
