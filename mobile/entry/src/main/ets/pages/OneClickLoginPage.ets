import { RobotMascot } from '../components/RobotMascot'
import { LoadingOverlay } from '../components/LoadingOverlay'
import { sessionStore } from '../store/SessionStore'
import { ServiceFactory } from '../services/ServiceFactory'
import { ResultFail } from '../common/types/Models'

/** 一键登录页:本机号码一键登录(移动认证 SDK 契约预留) */
@Component
export struct OneClickLoginPage {
  pathStack: NavPathStack = new NavPathStack()
  @State agreed: boolean = false
  @State logging: boolean = false
  private disappeared: boolean = false

  aboutToDisappear(): void {
    this.disappeared = true
  }

  async handleLogin(): Promise<void> {
    if (!this.agreed) {
      try {
        this.getUIContext().getPromptAction().showToast({ message: '请先阅读并同意服务条款' })
      } catch (e) {
        console.error(`showToast failed. Cause: ${JSON.stringify(e)}`)
      }
      return
    }
    if (this.logging) {
      return
    }
    this.logging = true
    // 契约预留:providerToken 由移动认证 SDK(一键登录)换取后传入
    const r = await ServiceFactory.getAuth().oneClickLogin('mock-provider-token')
    if (this.disappeared) {
      return
    }
    this.logging = false
    if (r.ok) {
      sessionStore.login(r.value)
      this.pathStack.clear()
      this.pathStack.pushPathByName('home', null)
    } else {
      const fail = r as ResultFail
      try {
        this.getUIContext().getPromptAction().showToast({ message: fail.message })
      } catch (e) {
        console.error(`showToast failed. Cause: ${JSON.stringify(e)}`)
      }
    }
  }

  build() {
    NavDestination() {
      Stack() {
        Column() {
          Row() {
            Button('‹')
              .type(ButtonType.Circle)
              .width(40)
              .height(40)
              .fontSize(18)
              .fontColor($r('app.color.text_primary'))
              .backgroundColor($r('app.color.card_sub'))
              .onClick(() => this.pathStack.pop())
          }
          .width('100%')
          .padding(20)
          .justifyContent(FlexAlign.Start)

          Blank()

          Column({ space: 24 }) {
            RobotMascot({ large: false })
            Text('KE-WORK,我帮你')
              .fontSize(28)
              .fontWeight(FontWeight.Bold)
              .fontColor($r('app.color.text_primary'))
            Text('150****5831')
              .fontSize(36)
              .fontWeight(FontWeight.Bold)
              .fontColor($r('app.color.text_primary'))
              .letterSpacing(2)

            Button(this.logging ? '登录中…' : '本机号码一键登录')
              .width('100%')
              .height(56)
              .fontSize(18)
              .fontWeight(FontWeight.Bold)
              .backgroundColor($r('app.color.primary'))
              .fontColor($r('app.color.card'))
              .borderRadius(16)
              .id('oneclick_button')
              .onClick(() => this.handleLogin())
              .margin({ top: 8 })

            Text('切换其他手机号登录')
              .fontSize(16)
              .fontColor($r('app.color.text_secondary'))
              .padding(8)
              .onClick(() => this.pathStack.pop())
          }
          .width('100%')
          .padding({ left: 32, right: 32 })

          Blank()

          // 条款勾选(样式同登录页)
          Row({ space: 8 }) {
            Button() {
              if (this.agreed) {
                Text('✓').fontSize(10).fontColor($r('app.color.card'))
              }
            }
            .type(ButtonType.Circle)
            .width(20)
            .height(20)
            .backgroundColor(this.agreed ? $r('app.color.primary') : Color.Transparent)
            .border({ width: 2, color: this.agreed ? $r('app.color.primary') : $r('app.color.text_tertiary') })
            .onClick(() => {
              this.agreed = !this.agreed
            })
            Text('已阅读并同意中国移动认证服务条款和服务协议、隐私政策并授权使用本机号码登录')
              .fontSize(12)
              .fontColor($r('app.color.text_secondary'))
              .lineHeight(18)
              .layoutWeight(1)
          }
          .width('100%')
          .padding({ left: 32, right: 32 })
          .alignItems(VerticalAlign.Top)

          Text('中国移动提供认证服务')
            .fontSize(12)
            .fontColor($r('app.color.text_tertiary'))
            .margin({ top: 12, bottom: 32 })

          LoadingOverlay({ visible: this.logging })
        }
        .width('100%')
        .height('100%')
      }
      .width('100%')
      .height('100%')
    }
    .backgroundColor($r('app.color.card'))
    .hideTitleBar(true)
  }
}
