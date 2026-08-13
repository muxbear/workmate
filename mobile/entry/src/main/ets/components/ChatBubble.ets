/** 用户气泡:右对齐灰底圆角 */
@Component
export struct ChatBubble {
  @Prop text: string = ''

  build() {
    Row() {
      Text(this.text)
        .fontSize(15)
        .fontColor($r('app.color.text_primary'))
        .lineHeight(22)
        .padding({ left: 16, right: 16, top: 12, bottom: 12 })
        .backgroundColor($r('app.color.card_sub'))
        .borderRadius({ topLeft: 16, topRight: 16, bottomLeft: 16, bottomRight: 6 })
        .constraintSize({ maxWidth: '82%' })
    }
    .width('100%')
    .justifyContent(FlexAlign.End)
  }
}
