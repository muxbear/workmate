/** 白色半透明遮罩 + 转圈 + "正在验证…" */
@Component
export struct LoadingOverlay {
  @Prop visible: boolean = false

  build() {
    Stack() {
      if (this.visible) {
        Column({ space: 16 }) {
          LoadingProgress()
            .width(40)
            .height(40)
            .color($r('app.color.primary'))
          Text('正在验证…')
            .fontSize(14)
            .fontColor($r('app.color.text_tertiary'))
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .backgroundColor('rgba(255,255,255,0.85)')
      }
    }
    .width('100%')
    .height('100%')
    .hitTestBehavior(this.visible ? HitTestMode.Block : HitTestMode.None)
  }
}
