import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

/**
 * 棰勫畾涔夌殑瀛愮洰褰曞垪琛紙浼氳瘽鏁版嵁宸茶縼绉昏嚦 LangGraph checkpointer锛屾棤 conversations 鐩綍锛? * 閰嶇疆/鐘舵€?蹇収鏂囦欢宸插榻?WorkBuddy 椤跺眰骞抽摵锛屾棤 config 瀛愮洰褰曪級
 */
export const SUB_DIRS = ['logs', 'cache', 'workspace', 'binaries'] as const
export type SubDir = (typeof SUB_DIRS)[number]

/**
 * 鏁版嵁鐩綍绠＄悊鍣紙鍗曚緥锛? * 浠?~/.ke-work 涓哄熀纭€鐩綍锛岀鐞嗗簲鐢ㄦ暟鎹殑瀛愮洰褰? */
export class DataDirectory {
  private baseDir: string

  constructor(baseDir: string) {
    this.baseDir = baseDir
  }

  /** 鑾峰彇鍩虹鐩綍璺緞 ~/.ke-work */
  getBaseDir(): string {
    return this.baseDir
  }

  /** 鑾峰彇鎸囧畾瀛愮洰褰曠殑璺緞 ~/.ke-work/<sub> */
  getDir(sub: SubDir): string {
    return join(this.baseDir, sub)
  }

  /**
   * 纭繚鎸囧畾瀛愮洰褰曞瓨鍦紙鎳掑垵濮嬪寲锛?   * @param sub 瀛愮洰褰曞悕绉?   * @returns 瀛愮洰褰曠殑瀹屾暣璺緞
   */
  ensureDir(sub: SubDir): string {
    const dirPath = this.getDir(sub)
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true })
      console.log(`[data-dir] created directory: ${dirPath}`)
    }
    return dirPath
  }

  /** 涓€娆℃€у垱寤烘墍鏈夐瀹氫箟瀛愮洰褰?*/
  ensureAll(): void {
    SUB_DIRS.forEach((sub) => this.ensureDir(sub))
  }
}

let instance: DataDirectory | null = null

/**
 * 鍒濆鍖栨暟鎹洰褰曪紙搴旂敤鍚姩鏃惰皟鐢級
 * 鍒涘缓鍩虹鐩綍鍙婃墍鏈夊瓙鐩綍锛涘熀纭€鐩綍榛樿涓?~/.ke-work锛? * 鍙€氳繃鐜鍙橀噺 KE_WORK_HOME 瑕嗙洊锛堟祴璇曢殧绂?澶氬疄渚嬮儴缃诧級
 * @returns DataDirectory 鍗曚緥瀹炰緥
 */
export function initDataDirectory(): DataDirectory {
  if (instance) return instance

  const baseDir = process.env.KE_WORK_HOME ?? join(homedir(), '.ke-work')

  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true })
    console.log(`[data-dir] created base directory: ${baseDir}`)
  }

  instance = new DataDirectory(baseDir)
  instance.ensureAll()

  console.log(`[data-dir] initialized, base: ${baseDir}`)
  return instance
}

/**
 * 鑾峰彇宸插垵濮嬪寲鐨?DataDirectory 鍗曚緥
 * @returns DataDirectory 瀹炰緥
 * @throws 濡傛灉灏氭湭璋冪敤 initDataDirectory
 */
export function getDataDirectory(): DataDirectory {
  if (!instance) {
    throw new Error('DataDirectory not initialized. Call initDataDirectory() first.')
  }
  return instance
}

/** 鏃у竷灞€ config/ 瀛愮洰褰曚笅鐨勯厤缃枃浠讹紙瀵归綈 WorkBuddy 椤跺眰骞抽摵鍚庤縼鍑猴級 */
const LEGACY_CONFIG_DIR = 'config'
const LEGACY_CONFIG_FILES = ['work-mode.json', 'session.json', 'secrets.bin'] as const

/**
 * 鏃х洰褰曞竷灞€涓€娆℃€ц縼绉伙細灏?config/ 瀛愮洰褰曚笅鐨勯厤缃枃浠跺钩閾哄埌鍩虹鐩綍椤跺眰锛堝榻?WorkBuddy锛夈€? * - 椤跺眰鐩爣宸插瓨鍦ㄦ椂璺宠繃涓嶈鐩栵紙浠ラ《灞備负鍑嗭級
 * - 杩佺Щ澶辫触浠?warn 涓嶉樆鏂惎鍔紙涓嬫鍚姩閲嶈瘯锛? * - 杩佺Щ瀹屾垚鍚?config/ 鐩綍涓虹┖鍒欏垹闄? */
export function migrateLegacyConfigFiles(baseDir: string): void {
  const legacyDir = join(baseDir, LEGACY_CONFIG_DIR)
  if (!existsSync(legacyDir)) return
  let moved = false
  for (const file of LEGACY_CONFIG_FILES) {
    const src = join(legacyDir, file)
    const dst = join(baseDir, file)
    if (!existsSync(src) || existsSync(dst)) continue
    try {
      renameSync(src, dst)
      moved = true
      console.log(`[data-dir] migrated ${LEGACY_CONFIG_DIR}/${file} 鈫?${file}`)
    } catch (err) {
      console.warn(`[data-dir] failed to migrate ${file}:`, err)
    }
  }
  if (moved) {
    try {
      const remaining = readdirSync(legacyDir)
      if (remaining.length === 0) {
        rmdirSync(legacyDir)
        console.log(`[data-dir] removed empty legacy ${LEGACY_CONFIG_DIR}/ directory`)
      }
    } catch (err) {
      console.warn('[data-dir] failed to clean up legacy config dir:', err)
    }
  }
}
