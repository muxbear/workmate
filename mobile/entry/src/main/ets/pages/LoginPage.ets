import { RobotMascot } from '../components/RobotMascot'
import { SocialLoginIcons } from '../components/SocialLoginIcons'
import { AgreementModal } from '../components/AgreementModal'
import { LoadingOverlay } from '../components/LoadingOverlay'

const SUBTITLES: string[] = ['做幻灯片', '生成视频', '深度研究', '写代码', '做报告']

/** 登录页:手机号登录 + 社交登录 + 协议确认 */
@Component
export struct LoginPage {
  pathStack: NavPathStack = new NavPathStack()
  @State agreed: boolean = false
  @State showAgreement: boolean = false
  @State loading: boolean = false
  @State subtitleIndex: number = 0
  @State subtitleVisible: boolean = true
  private timer: number = -1
  private agreeTimer: number = -1

  aboutToAppear(): void {
    this.timer = setInterval(() => {
      this.subtitleVisible = false
      setTimeout(() => {
        this.subtitleIndex = (this.subtitleIndex + 1) % SUBTITLES.length
        this.subtitleVisible = true
      }, 300)
    }, 2200)
  }

  aboutToDisappear(): void {
    if (this.timer >= 0) {
      clearInterval(this.timer)
    }
    if (this.agreeTimer >= 0) {
      clearTimeout(this.agreeTimer)
    }
  }

  /** 登录入口:未勾选协议先弹协议窗 */
  handleLogin(): void {
    if (!this.agreed) {
      this.showAgreement = true
      return
    }
    this.pathStack.pushPathByName('oneClickLogin', null)
  }

  handleAgree(): void {
    this.showAgreement = false
    this.agreed = true
    this.loading = true
    this.agreeTimer = setTimeout(() => {
      this.loading = false
      this.pathStack.pushPathByName('oneClickLogin', null)
    }, 1600)
  }

  build() {
    NavDestination() {
      Stack() {
        Column() {
          Blank()
          Column({ space: 16 }) {
            RobotMascot({ large: false })
            Text('KE-WORK,我帮你')
              .fontSize(28)
              .fontWeight(FontWeight.Bold)
              .fontColor($r('app.color.text_primary'))
            Text(SUBTITLES[this.subtitleIndex])
              .fontSize(16)
              .fontColor($r('app.color.text_tertiary'))
              .opacity(this.subtitleVisible ? 1 : 0)
              .translate({ y: this.subtitleVisible ? 0 : 6 })
              .animation({ duration: 300 })
          }
          Blank()

          // 登录按钮
          Button('手机号登录')
            .width('100%')
            .height(56)
            .fontSize(18)
            .fontWeight(FontWeight.Bold)
            .backgroundColor($r('app.color.primary'))
            .fontColor($r('app.color.card'))
            .borderRadius(16)
            .id('login_phone')
            .onClick(() => this.handleLogin())
            .margin({ bottom: 24 })

          SocialLoginIcons({ onTap: () => this.handleLogin() })

          // 协议勾选(服务协议/隐私政策为加粗下划线 Span,与设计一致)
          Row({ space: 8 }) {
            Button() {
              if (this.agreed) {
                Text('✓').fontSize(10).fontColor($r('app.color.card'))
              }
            }
            .type(ButtonType.Circle)
            .id('login_agree_check')
            .width(20)
            .height(20)
            .backgroundColor(this.agreed ? $r('app.color.primary') : Color.Transparent)
            .border({ width: 2, color: this.agreed ? $r('app.color.primary') : $r('app.color.text_tertiary') })
            .onClick(() => {
              this.agreed = !this.agreed
            })

            Text() {
              Span('已阅读并同意 ')
              Span('服务协议')
                .fontWeight(FontWeight.Bold)
                .decoration({ type: TextDecorationType.Underline })
              Span(' 和 ')
              Span('隐私政策')
                .fontWeight(FontWeight.Bold)
                .decoration({ type: TextDecorationType.Underline })
            }
            .fontSize(14)
            .fontColor($r('app.color.text_secondary'))
            .layoutWeight(1)
          }
          .width('100%')
          .margin({ top: 20 })

          Blank().height(12)
        }
        .width('100%')
        .height('100%')
        .padding({ left: 32, right: 32, top: 16, bottom: 40 })

        LoadingOverlay({ visible: this.loading })

        AgreementModal({
          visible: this.showAgreement,
          onAgree: () => this.handleAgree(),
          onDisagree: () => {
            this.showAgreement = false
          },
        })
      }
      .width('100%')
      .height('100%')
    }
    .backgroundColor($r('app.color.card'))
    .hideTitleBar(true)
    .onBackPressed(() => {
      this.pathStack.pop()
      return true
    })
  }
}
