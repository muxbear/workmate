/** 添加内容面板(bindSheet 内容):照片 / 文件 */
@Component
export struct MediaSheet {
  onSelectPhoto: () => void = () => {}
  onSelectFile: () => void = () => {}

  @Builder
  OptionRow(label: string, path: string, onTap: () => void) {
    Row({ space: 12 }) {
      Path()
        .commands(path)
        .fillOpacity(0)
        .stroke($r('app.color.text_primary'))
        .strokeWidth(1.8)
        .width(24)
        .height(24)
      Text(label)
        .fontSize(16)
        .fontColor($r('app.color.text_primary'))
        .layoutWeight(1)
      Text('›').fontSize(16).fontColor($r('app.color.text_tertiary'))
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 14, bottom: 14 })
    .borderRadius(16)
    .backgroundColor($r('app.color.card_sub'))
    .onClick(() => onTap())
  }

  build() {
    Column({ space: 8 }) {
      Text('添加内容')
        .fontSize(18)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.text_primary'))
        .margin({ bottom: 4 })

      this.OptionRow('照片', 'M3 6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z M3 12.5l4-3.5 3 2.5 3-3.5 4 4', () => this.onSelectPhoto())

      this.OptionRow('文件', 'M4 5a2 2 0 0 1 2-2h5l5 5v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5z M11 3v5h5', () => this.onSelectFile())
    }
    .padding({ left: 20, right: 20, top: 24, bottom: 32 })
    .alignItems(HorizontalAlign.Start)
  }
}
