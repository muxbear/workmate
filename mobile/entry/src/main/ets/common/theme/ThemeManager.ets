import { common } from '@kit.AbilityKit'
import { ConfigurationConstant } from '@kit.AbilityKit'
import { preferences } from '@kit.ArkData'
import { Constants } from '../constants/Constants'
import { ThemeMode } from '../../store/SettingsStore'

/** 主题管理:应用 colorMode + 偏好持久化 */
export class ThemeManager {
  /** ThemeMode 映射到系统 ColorMode */
  static toColorMode(mode: ThemeMode): ConfigurationConstant.ColorMode {
    switch (mode) {
      case 'light':
        return ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT
      case 'dark':
        return ConfigurationConstant.ColorMode.COLOR_MODE_DARK
      default:
        return ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET
    }
  }

  /** 应用主题到应用级 colorMode(dark 资源随系统生效) */
  static apply(ctx: common.Context, mode: ThemeMode): void {
    const appCtx = ctx.getApplicationContext()
    const target = ThemeManager.toColorMode(mode)
    try {
      appCtx.setColorMode(target)
    } catch (e) {
      console.error(`Failed to apply theme. Cause: ${JSON.stringify(e)}`)
    }
  }

  /** 读取持久化主题(默认跟随系统) */
  static load(ctx: common.Context): ThemeMode {
    try {
      const prefs = preferences.getPreferencesSync(ctx, { name: Constants.PREFS_NAME })
      const saved = prefs.getSync(Constants.KEY_THEME, 'system') as string
      return saved === 'light' || saved === 'dark' ? saved : 'system'
    } catch (e) {
      console.error(`Failed to load theme. Cause: ${JSON.stringify(e)}`)
      return 'system'
    }
  }

  /** 持久化主题选择 */
  static save(ctx: common.Context, mode: ThemeMode): void {
    try {
      const prefs = preferences.getPreferencesSync(ctx, { name: Constants.PREFS_NAME })
      prefs.putSync(Constants.KEY_THEME, mode)
      prefs.flush()
    } catch (e) {
      console.error(`Failed to save theme. Cause: ${JSON.stringify(e)}`)
    }
  }
}
