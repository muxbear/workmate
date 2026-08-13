import { sessionStore } from '../store/SessionStore'
import { chatStore } from '../store/ChatStore'
import { ServiceFactory } from '../services/ServiceFactory'

/** 账号设置页:头像/昵称/手机号/退出登录/注销 */
@Component
export struct AccountSettingsPage {
  pathStack: NavPathStack = new NavPathStack()

  async handleLogout(): Promise<void> {
    await ServiceFactory.getAuth().logout()
    sessionStore.logout()
    chatStore.reset()
    this.pathStack.clear()
    this.pathStack.pushPathByName('login', null)
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
          Text('账号设置')
            .fontSize(16)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.text_primary'))
            .layoutWeight(1)
            .textAlign(TextAlign.Center)
          Blank().width(36)
        }
        .width('100%')
        .padding({ left: 20, right: 20, top: 40, bottom: 16 })

        // 头像
        Stack() {
          Text(sessionStore.profile?.nickname.slice(0, 1) ?? '').fontSize(48).fontWeight(FontWeight.Bold).fontColor($r('app.color.accent'))
        }
        .width(120)
        .height(120)
        .borderRadius(60)
        .backgroundColor($r('app.color.card_sub'))
        .clip(true)
        .margin({ top: 32 })

        // 信息卡
        Column() {
          Row({ space: 12 }) {
            Text('昵称')
              .fontSize(16)
              .fontColor($r('app.color.text_primary'))
              .layoutWeight(1)
            Text(sessionStore.profile?.nickname ?? '')
              .fontSize(16)
              .fontColor($r('app.color.text_tertiary'))
            Text('›').fontSize(16).fontColor($r('app.color.text_tertiary'))
          }
          .width('100%')
          .padding(16)

          Divider().color($r('app.color.divider')).margin({ left: 16, right: 16 })

          Row({ space: 12 }) {
            Text('手机号')
              .fontSize(16)
              .fontColor($r('app.color.text_primary'))
              .layoutWeight(1)
            Text(sessionStore.profile?.phone ?? '')
              .fontSize(16)
              .fontColor($r('app.color.text_tertiary'))
          }
          .width('100%')
          .padding(16)
        }
        .width('100%')
        .borderRadius(16)
        .backgroundColor($r('app.color.card'))
        .margin({ top: 32 })

        // 退出登录
        Button('退出登录')
          .width('100%')
          .height(52)
          .fontSize(16)
          .fontWeight(FontWeight.Medium)
          .backgroundColor($r('app.color.card'))
          .fontColor($r('app.color.text_primary'))
          .borderRadius(16)
          .margin({ top: 16 })
          .onClick(() => this.handleLogout())

        Blank()

        Text('注销账号')
          .fontSize(16)
          .fontColor($r('app.color.danger'))
          .padding(12)
          .margin({ bottom: 40 })
          .onClick(() => {
            this.getUIContext().getPromptAction().showToast({ message: '注销功能暂未开放' })
          })
      }
      .width('100%')
      .height('100%')
      .padding({ left: 16, right: 16 })
      .backgroundColor($r('app.color.bg_secondary'))
      .alignItems(HorizontalAlign.Center)
    }
    .hideTitleBar(true)
  }
}
