import { isAbsolute } from 'path'

/**
 * 绯荤粺璁剧疆 Schema 鏉冨▉锛圴S Code 榛樿鍊煎悎骞舵ā寮?+ WorkBuddy 宓屽鍔熻兘鍩熷垎缁勶級
 *
 * 瀛樺偍 key 涓哄祵濂楄矾寰勫瓧绗︿覆锛堝 'ui.language'锛夛紝纾佺洏鏂囦欢涓哄祵濂楀璞★紙瀵归綈 WorkBuddy
 * settings.json 鐨?camelCase 鍩熷垎缁勶細sandbox/claw/enabledPlugins 瀹炴祴锛夛紱涓昏繘绋嬩负鍞竴
 * 鏍￠獙鏉冨▉锛堢櫧鍚嶅崟 + 绫诲瀷 + 鏋氫妇/鏍煎紡/鍖洪棿锛夛紝娓叉煋灞備笉鍙俊銆? */

export type ApplyTiming = 'instant' | 'pending'

export type SettingsKey =
  | 'ui.language'
  | 'ui.fontSize'
  | 'ui.theme'
  | 'skills.autoUpdate'
  | 'skills.safeInstall'
  | 'plugins.autoUpdate'
  | 'lockScreen.remoteLock'
  | 'network.proxyMode'
  | 'network.proxyUrl'
  | 'workspace.defaultWorkspaceDir'
  | 'privacy.experienceImprovement'
  | 'notification.clientNotifications'
  | 'notification.sound'
  | 'runtime.enabled'
  | 'runtime.python.enabled'
  | 'runtime.node.enabled'
  | 'runtime.git.enabled'

export interface SettingsSchemaEntry {
  type: 'string' | 'number' | 'boolean'
  default: unknown
  /** 鐢熸晥鏃舵満锛歩nstant=淇濆瓨鍗崇敓鏁堬紱pending=鍔熻兘鏃犺惤鐐逛粎鎸佷箙鍖栵紙UI 鏄惧紡鏍囨敞"鍚庣画鐗堟湰鐢熸晥"锛?*/
  applyTiming: ApplyTiming
  /** 鏋氫妇/鏍煎紡/鍖洪棿鏍￠獙锛堥潪娉曞€煎洖閫€榛樿锛?*/
  validate?: (v: unknown) => boolean
}

const LANGUAGE_OPTIONS = ['zh-CN', 'zh-TW', 'en']
const THEME_OPTIONS = ['light', 'dark']
const PROXY_MODES = ['direct', 'system', 'manual']
const SOUND_OPTIONS = ['none', 'crisp', 'soft']

/** http(s)://host[:port][/path] 鏍煎紡锛堜唬鐞嗗湴鍧€蹇呭～鏍￠獙锛?*/
const PROXY_URL_RE = /^https?:\/\/[^:\s/]+(:\d{1,5})?(\/.*)?$/

export const SETTINGS_SCHEMA: Record<SettingsKey, SettingsSchemaEntry> = {
  'ui.language': {
    type: 'string',
    default: 'zh-CN',
    applyTiming: 'instant',
    validate: (v) => LANGUAGE_OPTIONS.includes(v as string)
  },
  'ui.fontSize': {
    type: 'number',
    default: 17,
    applyTiming: 'instant',
    validate: (v) => Number.isInteger(v) && (v as number) >= 12 && (v as number) <= 24
  },
  'ui.theme': {
    type: 'string',
    default: 'light',
    applyTiming: 'instant',
    validate: (v) => THEME_OPTIONS.includes(v as string)
  },
  'skills.autoUpdate': { type: 'boolean', default: true, applyTiming: 'pending' },
  'skills.safeInstall': { type: 'boolean', default: false, applyTiming: 'pending' },
  'plugins.autoUpdate': { type: 'boolean', default: true, applyTiming: 'pending' },
  'lockScreen.remoteLock': { type: 'boolean', default: false, applyTiming: 'instant' },
  'network.proxyMode': {
    type: 'string',
    default: 'direct',
    applyTiming: 'instant',
    validate: (v) => PROXY_MODES.includes(v as string)
  },
  'network.proxyUrl': {
    type: 'string',
    default: '',
    applyTiming: 'instant',
    validate: (v) => typeof v === 'string' && (v === '' || PROXY_URL_RE.test(v))
  },
  'workspace.defaultWorkspaceDir': {
    type: 'string',
    default: '',
    applyTiming: 'instant',
    validate: (v) => typeof v === 'string' && (v === '' || isAbsolute(v))
  },
  'privacy.experienceImprovement': { type: 'boolean', default: true, applyTiming: 'pending' },
  'notification.clientNotifications': { type: 'boolean', default: true, applyTiming: 'pending' },
  'notification.sound': {
    type: 'string',
    default: 'none',
    applyTiming: 'pending',
    validate: (v) => SOUND_OPTIONS.includes(v as string)
  },
  'runtime.enabled': { type: 'boolean', default: true, applyTiming: 'instant' },
  'runtime.python.enabled': { type: 'boolean', default: true, applyTiming: 'instant' },
  'runtime.node.enabled': { type: 'boolean', default: true, applyTiming: 'instant' },
  'runtime.git.enabled': { type: 'boolean', default: true, applyTiming: 'instant' }
}

/** settings.json 椤跺眰缁撴瀯鐗堟湰锛堝榻?WorkBuddy workspace-state.json 鐨?version 瀛楁锛?*/
export const SETTINGS_VERSION = 1

/** 鐧藉悕鍗曞畧鍗?*/
export function isSettingsKey(k: string): k is SettingsKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS_SCHEMA, k)
}

/** 鍗曞€煎畬鏁存牎楠岋紙鐧藉悕鍗?+ 绫诲瀷 + 鏋氫妇/鏍煎紡/鍖洪棿锛夛紱闈炴硶杩斿洖 false */
export function isValidSettingsValue(key: SettingsKey, value: unknown): boolean {
  const entry = SETTINGS_SCHEMA[key]
  if (!entry) return false
  if (!isValidValue(entry, value)) return false
  if (entry.validate && !entry.validate(value)) return false
  return true
}

/** 鍏ㄩ粯璁ゅ€硷紙鎵佸钩 key 鏄犲皠锛?*/
export function defaultSettings(): Record<SettingsKey, unknown> {
  const out = {} as Record<SettingsKey, unknown>
  for (const [key, entry] of Object.entries(SETTINGS_SCHEMA)) {
    out[key as SettingsKey] = entry.default
  }
  return out
}

function isValidValue(entry: SettingsSchemaEntry, value: unknown): boolean {
  switch (entry.type) {
    case 'boolean':
      return typeof value === 'boolean'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'string':
      return typeof value === 'string'
  }
}

/** 宓屽瀵硅薄鎷嶅钩锛歿"ui":{"language":"zh-CN"}} 鈫?{"ui.language":"zh-CN"} */
export function flattenSettings(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flattenSettings(value as Record<string, unknown>, path))
    } else {
      out[path] = value
    }
  }
  return out
}

/** 鎵佸钩 key 鏄犲皠杩樺師涓哄祵濂楀璞★紙persist 鍐欑洏鐢紝瀵归綈 WorkBuddy 宓屽鍩熸牸寮忥級 */
export function unflattenSettings(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split('.')
    let node = out
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]
      if (typeof node[part] !== 'object' || node[part] === null) {
        node[part] = {}
      }
      node = node[part] as Record<string, unknown>
    }
    node[parts[parts.length - 1]] = value
  }
  return out
}

/**
 * 榛樿鍊煎悎骞讹紙VS Code 妯″紡锛夛細榛樿鍊?鈭?鏂囦欢鍐呭€硷紝閫愬瓧娈电被鍨?鏋氫妇鏍￠獙锛岄潪娉曞€煎洖閫€榛樿銆? * 杈撳叆涓虹鐩樺祵濂楀璞★紙鍚?version 绛夐潪璁剧疆瀛楁浼氳 flatten 鍚庡拷鐣ワ級銆? */
export function normalizeSettings(raw: Record<string, unknown>): Record<SettingsKey, unknown> {
  const flat = flattenSettings(raw)
  const out = defaultSettings()
  for (const [key, entry] of Object.entries(SETTINGS_SCHEMA)) {
    if (!(key in flat)) continue
    const value = flat[key]
    if (!isValidValue(entry, value)) continue
    if (entry.validate && !entry.validate(value)) continue
    ;(out as Record<string, unknown>)[key] = value
  }
  return out
}
