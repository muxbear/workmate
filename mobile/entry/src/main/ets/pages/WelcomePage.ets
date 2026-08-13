import { RobotMascot } from '../components/RobotMascot'
import { Spacing } from '../common/theme/Theme'

interface Feature {
  emoji: string
  text: string
}

const FEATURES: Feature[] = [
  { emoji: '🖥️', text: '幻灯片一键生成' },
  { emoji: '🎬', text: 'AI 视频创作' },
  { emoji: '🔍', text: '深度研究助手' },
]

/** 欢迎页:2.6s 进度条自动进入,可跳过 */
@Component
export struct WelcomePage {
  onDone: () => void = () => {}
  @State progress: number = 0
  @State entered: boolean = false
  @State leaving: boolean = false
  private timer: number = -1

  aboutToAppear(): void {
    setTimeout(() => {
      this.entered = true
      this.startProgress()
    }, 60)
  }

  startProgress(): void {
    const start = Date.now()
    const duration = 2600
    this.timer = setInterval(() => {
      const pct = Math.min((Date.now() - start) / duration, 1)
      this.progress = pct
      if (pct >= 1) {
        clearInterval(this.timer)
        this.finish()
      }
    }, 16)
  }

  finish(): void {
    if (this.leaving) {
      return
    }
    this.leaving = true
    setTimeout(() => this.onDone(), 420)
  }

  aboutToDisappear(): void {
    if (this.timer >= 0) {
      clearInterval(this.timer)
    }
  }

  build() {
    Column() {
      Blank()

      // 中心内容
      Column({ space: Spacing.XL }) {
        RobotMascot({ large: false })
        Text('KE-WORK')
          .fontSize(36)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
        Text('你的 AI 工作伙伴')
          .fontSize(16)
          .fontColor($r('app.color.text_tertiary'))
        Column({ space: 12 }) {
          ForEach(FEATURES, (f: Feature, i: number) => {
            Row({ space: 12 }) {
              Text(f.emoji).fontSize(20)
              Text(f.text)
                .fontSize(14)
                .fontColor($r('app.color.text_primary'))
              Text('›')
                .fontSize(16)
                .fontColor($r('app.color.text_tertiary'))
                .layoutWeight(1)
                .textAlign(TextAlign.End)
            }
            .width('100%')
            .padding(16)
            .borderRadius(16)
            .backgroundColor($r('app.color.card_sub'))
            .opacity(this.entered ? 1 : 0)
            .translate({ x: this.entered ? 0 : -16 })
            .animation({ duration: 500, delay: 200 + i * 100, curve: Curve.EaseOut })
          }, (f: Feature) => f.text)
        }
        .width('100%')
      }
      .width('100%')
      .padding({ left: 32, right: 32 })
      .opacity(this.entered ? 1 : 0)
      .translate({ y: this.entered ? 0 : 24 })
      .animation({ duration: 600, curve: Curve.EaseOut })

      // 底部:进度条 + 跳过
      Column({ space: 20 }) {
        Progress({ value: this.progress * 100, total: 100, type: ProgressType.Linear })
          .width('100%')
          .height(2)
          .color($r('app.color.primary'))
          .backgroundColor('rgba(0,0,0,0.08)')
        Text('跳过')
          .fontSize(14)
          .fontColor($r('app.color.text_tertiary'))
          .id('welcome_skip')
          .onClick(() => this.finish())
      }
      .width('100%')
      .padding({ left: 32, right: 32, bottom: 48 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.card'))
    .opacity(this.leaving ? 0 : 1)
    .scale({ x: this.leaving ? 1.04 : 1, y: this.leaving ? 1.04 : 1 })
    .animation({ duration: 420, curve: Curve.EaseOut })
  }
}
