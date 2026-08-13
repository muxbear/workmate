/** 协议弹窗:同意并登录 / 不同意(遮罩与卡片为兄弟节点,避免点击冒泡) */
@Component
export struct AgreementModal {
  @Prop visible: boolean = false
  onAgree: () => void = () => {}
  onDisagree: () => void = () => {}

  build() {
    if (this.visible) {
      Stack() {
        Column()
          .width('100%')
          .height('100%')
          .backgroundColor('rgba(0,0,0,0.4)')
          .onClick(() => this.onDisagree())

        Column({ space: 20 }) {
          Text('同意协议与隐私保护')
            .fontSize(20)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.text_primary'))
          Text('已阅读并同意《服务协议》和《隐私政策》')
            .fontSize(14)
            .fontColor($r('app.color.text_secondary'))
            .textAlign(TextAlign.Center)
          Column({ space: 12 }) {
            Button('同意并登录')
              .width('100%')
              .height(56)
              .fontSize(16)
              .fontWeight(FontWeight.Medium)
              .backgroundColor($r('app.color.primary'))
              .fontColor($r('app.color.card'))
              .borderRadius(16)
              .onClick(() => this.onAgree())
            Button('不同意')
              .width('100%')
              .height(56)
              .fontSize(16)
              .fontWeight(FontWeight.Medium)
              .backgroundColor($r('app.color.card_sub'))
              .fontColor($r('app.color.text_secondary'))
              .borderRadius(16)
              .onClick(() => this.onDisagree())
          }
          .width('100%')
        }
        .width('80%')
        .padding({ left: 24, right: 24, top: 32, bottom: 24 })
        .borderRadius(24)
        .backgroundColor($r('app.color.card'))
      }
      .width('100%')
      .height('100%')
      .alignContent(Alignment.Center)
      .padding({ left: 16, right: 16 })
    }
  }
}
