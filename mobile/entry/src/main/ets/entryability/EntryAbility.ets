import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit'
import { window } from '@kit.ArkUI'
import { ThemeManager } from '../common/theme/ThemeManager'
import { settingsStore } from '../store/SettingsStore'

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    try {
      // 恢复上次主题选择并应用(默认跟随系统)
      settingsStore.setTheme(ThemeManager.load(this.context))
      ThemeManager.apply(this.context, settingsStore.theme)
    } catch (e) {
      console.error(`Failed to apply theme. Cause: ${JSON.stringify(e)}`)
    }

    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        console.error(`Failed to load the content. Cause: ${JSON.stringify(err)}`)
        return
      }
      console.info('Succeeded in loading the content.')
    })
  }

  onWindowStageDestroy(): void {
  }

  onForeground(): void {
  }

  onBackground(): void {
  }
}
