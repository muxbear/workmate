/** 双段分段控件(云端工作/连接电脑;侧边栏云端工作/连接电脑) */
@Component
export struct SegmentedControl {
  @Prop options: string[] = []
  @Prop index: number = 0
  onSelect: (index: number) => void = () => {}

  @Builder
  Segment(label: string, i: number) {
    Text(label)
      .fontSize(15)
      .fontWeight(i === this.index ? FontWeight.Medium : FontWeight.Normal)
      .fontColor(i === this.index ? $r('app.color.text_primary') : $r('app.color.text_tertiary'))
      .textAlign(TextAlign.Center)
      .height(44)
      .layoutWeight(1)
      .backgroundColor(i === this.index ? $r('app.color.card') : Color.Transparent)
      .borderRadius(12)
      .shadow(i === this.index ? { radius: 4, color: 'rgba(0,0,0,0.1)', offsetY: 1 } : { radius: 0 })
      .onClick(() => this.onSelect(i))
  }

  build() {
    Row() {
      ForEach(this.options, (label: string, i: number) => {
        this.Segment(label, i)
      }, (label: string, i: number) => `${label}-${i}`)
    }
    .padding(4)
    .borderRadius(16)
    .backgroundColor($r('app.color.card_sub'))
  }
}
