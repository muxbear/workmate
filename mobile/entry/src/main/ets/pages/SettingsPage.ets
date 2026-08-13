import { sessionStore } from '../store/SessionStore'
import { settingsStore, ThemeMode } from '../store/SettingsStore'
import { ThemeManager } from '../common/theme/ThemeManager'
import { formatNumber, progressPercent } from '../common/utils/Formatter'

interface ThemeOption {
  label: string
  mode: ThemeMode
}

const THEME_OPTIONS: ThemeOption[] = [
  { label: '系统', mode: 'system' },
  { label: '浅色', mode: 'light' },
  { label: '深色', mode: 'dark' },
]

/** 设置页:用户卡/积分卡/记忆库分享/显示设置/帮助 */
@Component
export struct SettingsPage {
  pathStack: NavPathStack = new NavPathStack()
  @State pointsLoaded: boolean = false

  aboutToAppear(): void {
    sessionStore.refreshPoints().then(() => {
      this.pointsLoaded = true
    }).catch(() => {
      this.pointsLoaded = true
    })
  }

  /** 主题切换:更新 Store + 应用 colorMode + 持久化 */
  selectTheme(mode: ThemeMode): void {
    settingsStore.setTheme(mode)
    const ctx = this.getUIContext().getHostContext()
    if (ctx) {
      ThemeManager.apply(ctx, mode)
      ThemeManager.save(ctx, mode)
    }
  }

  @Builder
  ThemeSegment() {
    Row({ space: 4 }) {
      ForEach(THEME_OPTIONS, (opt: ThemeOption) => {
        Text(opt.label)
          .fontSize(14)
          .fontWeight(settingsStore.theme === opt.mode ? FontWeight.Medium : FontWeight.Normal)
          .fontColor(settingsStore.theme === opt.mode ? $r('app.color.card') : $r('app.color.text_secondary'))
          .textAlign(TextAlign.Center)
          .height(36)
          .layoutWeight(1)
          .backgroundColor(settingsStore.theme === opt.mode ? $r('app.color.primary') : Color.Transparent)
          .borderRadius(10)
          .onClick(() => this.selectTheme(opt.mode))
      }, (opt: ThemeOption) => opt.label)
    }
    .padding(4)
    .borderRadius(14)
    .backgroundColor($r('app.color.card_sub'))
    .width(180)
  }

  @Builder
  NavRow(label: string, value?: string) {
    Row({ space: 8 }) {
      Text(label)
        .fontSize(16)
        .fontColor($r('app.color.text_primary'))
        .layoutWeight(1)
      if (value) {
        Text(value).fontSize(14).fontColor($r('app.color.text_tertiary'))
      }
      Text('›').fontSize(16).fontColor($r('app.color.text_tertiary'))
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 16, bottom: 16 })
  }

  @Builder
  DividerRow() {
    Divider().color($r('app.color.divider')).margin({ left: 16, right: 16 })
  }

  build() {
    NavDestination() {
      Column() {
        // 顶栏
        Row() {
          Button('‹')
            .type(ButtonType.Circle)
            .width(36)
            .height(36)
            .fontSize(16)
            .fontColor($r('app.color.text_primary'))
            .backgroundColor(Color.Transparent)
            .onClick(() => this.pathStack.pop())
          Text('设置')
            .fontSize(16)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.text_primary'))
            .layoutWeight(1)
            .textAlign(TextAlign.Center)
          Blank().width(36)
        }
        .width('100%')
        .padding({ left: 20, right: 20, top: 40, bottom: 16 })

        Scroll() {
          Column({ space: 12 }) {
            // 用户卡
            Column() {
              Row({ space: 12 }) {
                Stack() {
                  Text(sessionStore.profile?.nickname.slice(0, 1) ?? '').fontSize(20).fontWeight(FontWeight.Bold).fontColor($r('app.color.accent'))
                }
                .width(48)
                .height(48)
                .borderRadius(24)
                .backgroundColor($r('app.color.card_sub'))
                .clip(true)

                Column({ space: 4 }) {
                  Text(sessionStore.profile?.nickname ?? '')
                    .fontSize(16)
                    .fontWeight(FontWeight.Bold)
                    .fontColor($r('app.color.text_primary'))
                  Text(sessionStore.profile?.level ?? '')
                    .fontSize(12)
                    .padding({ left: 8, right: 8, top: 2, bottom: 2 })
                    .borderRadius(10)
                    .backgroundColor($r('app.color.accent_soft'))
                    .fontColor($r('app.color.accent'))
                }
                .alignItems(HorizontalAlign.Start)
                .layoutWeight(1)
                Text('›').fontSize(16).fontColor($r('app.color.text_tertiary'))
              }
              .width('100%')
              .padding(16)
              .onClick(() => this.pathStack.pushPathByName('accountSettings', null))

              this.DividerRow()

              Row() {
                Text('账号信息已同步至云端')
                  .fontSize(14)
                  .fontColor($r('app.color.text_secondary'))
                  .layoutWeight(1)
                Text('✓ 已同步').fontSize(14).fontColor($r('app.color.accent'))
              }
              .width('100%')
              .padding({ left: 16, right: 16, top: 12, bottom: 12 })
            }
            .width('100%')
            .borderRadius(16)
            .backgroundColor($r('app.color.card'))

            // 积分卡
            Column() {
              Row() {
                Row({ space: 8 }) {
                  Text('我的积分').fontSize(16).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'))
                  Text('↻').fontSize(14).fontColor($r('app.color.text_tertiary'))
                }
                .layoutWeight(1)
                Button('升级')
                  .height(32)
                  .fontSize(14)
                  .fontWeight(FontWeight.Bold)
                  .backgroundColor($r('app.color.primary'))
                  .fontColor($r('app.color.card'))
                  .borderRadius(16)
                  .padding({ left: 16, right: 16 })
                  .onClick(() => {})
              }
              .width('100%')
              .margin({ bottom: 12 })

              Text(formatNumber(sessionStore.points?.balance ?? 0))
                .fontSize(36)
                .fontWeight(FontWeight.Bold)
                .fontColor($r('app.color.text_primary'))
                .margin({ bottom: 12 })
                .width('100%')

              // 进度条
              if (this.pointsLoaded) {
                Progress({
                  value: progressPercent(
                    (sessionStore.points?.nextMilestone ?? 3800) - (sessionStore.points?.balance ?? 0),
                    sessionStore.points?.nextMilestone ?? 3800,
                  ),
                  total: 100,
                  type: ProgressType.Linear,
                })
                  .width('100%')
                  .height(6)
                  .color($r('app.color.accent'))
                  .backgroundColor($r('app.color.card_sub'))
                  .margin({ bottom: 8 })

                Row() {
                  Text(`${formatNumber((sessionStore.points?.nextMilestone ?? 3800) - (sessionStore.points?.balance ?? 0))} / ${formatNumber(sessionStore.points?.nextMilestone ?? 3800)}`)
                    .fontSize(12)
                    .fontColor($r('app.color.text_tertiary'))
                  Text(`${formatNumber(sessionStore.points?.balance ?? 0)} 剩余`)
                    .fontSize(12)
                    .fontColor($r('app.color.text_tertiary'))
                }
                .width('100%')
                .justifyContent(FlexAlign.SpaceBetween)
                .margin({ bottom: 16 })
              }

              Row({ space: 24 }) {
                Column({ space: 4 }) {
                  Text('基础体验包').fontSize(12).fontColor($r('app.color.text_tertiary'))
                  Row({ space: 4 }) {
                    Text(`${sessionStore.points?.basic.used ?? 0}`).fontSize(14).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'))
                    Text(`/ ${sessionStore.points?.basic.total ?? 500}`).fontSize(14).fontColor($r('app.color.text_tertiary'))
                  }
                }
                .alignItems(HorizontalAlign.Start)
                Column({ space: 4 }) {
                  Text('权益赠送包').fontSize(12).fontColor($r('app.color.text_tertiary'))
                  Row({ space: 4 }) {
                    Text(formatNumber(sessionStore.points?.gifted.used ?? 0)).fontSize(14).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'))
                    Text(`/ ${formatNumber(sessionStore.points?.gifted.total ?? 3300)}`).fontSize(14).fontColor($r('app.color.text_tertiary'))
                  }
                }
                .alignItems(HorizontalAlign.Start)
              }
              .width('100%')
            }
            .width('100%')
            .padding(16)
            .borderRadius(16)
            .backgroundColor($r('app.color.card'))

            // 记忆库/我的分享
            Column() {
              this.NavRow('记忆库')
              this.DividerRow()
              this.NavRow('我的分享')
            }
            .width('100%')
            .borderRadius(16)
            .backgroundColor($r('app.color.card'))

            // 显示设置
            Column() {
              Row({ space: 8 }) {
                Text('主题')
                  .fontSize(16)
                  .fontColor($r('app.color.text_primary'))
                  .layoutWeight(1)
                this.ThemeSegment()
              }
              .width('100%')
              .padding({ left: 16, right: 16, top: 14, bottom: 14 })

              this.DividerRow()
              this.NavRow('语言', '跟随系统')
              this.DividerRow()
              this.NavRow('字体大小')
            }
            .width('100%')
            .borderRadius(16)
            .backgroundColor($r('app.color.card'))

            // 帮助
            Column() {
              this.NavRow('使用帮助')
            }
            .width('100%')
            .borderRadius(16)
            .backgroundColor($r('app.color.card'))
            .margin({ bottom: 40 })
          }
          .width('100%')
          .padding({ left: 16, right: 16 })
        }
        .layoutWeight(1)
        .scrollBar(BarState.Off)
      }
      .width('100%')
      .height('100%')
      .backgroundColor($r('app.color.bg_secondary'))
    }
    .hideTitleBar(true)
  }
}
