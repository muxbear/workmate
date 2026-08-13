/** 表格卡片:表头 + 行,带工具条(复制/下载等,本期占位) */
@Component
export struct DataTable {
  @Prop headers: string[] = []
  @Prop rows: string[][] = []

  build() {
    Column() {
      // 工具条
      Row() {
        Text('表格')
          .fontSize(14)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
          .layoutWeight(1)
        Text('⧉').fontSize(16).fontColor($r('app.color.text_tertiary')).margin({ right: 16 })
        Text('⇪').fontSize(16).fontColor($r('app.color.text_tertiary')).margin({ right: 16 })
        Text('⇣').fontSize(16).fontColor($r('app.color.text_tertiary'))
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 10, bottom: 10 })
      .border({ width: { bottom: 1 }, color: $r('app.color.divider') })

      // 表头
      Row() {
        ForEach(this.headers, (h: string) => {
          Text(h)
            .fontSize(14)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.text_primary'))
            .layoutWeight(1)
            .textAlign(TextAlign.Start)
        }, (h: string, i: number) => `h-${i}`)
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 10, bottom: 10 })
      .border({ width: { bottom: 1 }, color: $r('app.color.divider') })

      // 数据行
      ForEach(this.rows, (row: string[], ri: number) => {
        Row() {
          ForEach(row, (cell: string, ci: number) => {
            Text(cell)
              .fontSize(14)
              .fontWeight(ci === 0 ? FontWeight.Bold : FontWeight.Normal)
              .fontColor($r('app.color.text_primary'))
              .layoutWeight(1)
              .textAlign(TextAlign.Start)
          }, (cell: string, ci: number) => `c-${ci}`)
        }
        .width('100%')
        .padding({ left: 12, right: 12, top: 10, bottom: 10 })
        .border({
          width: ri < this.rows.length - 1 ? { bottom: 1 } : 0,
          color: $r('app.color.divider'),
        })
      }, (row: string[], ri: number) => `r-${ri}`)
    }
    .width('100%')
    .borderRadius(16)
    .border({ width: 1, color: $r('app.color.divider') })
    .backgroundColor($r('app.color.card'))
    .clip(true)
  }
}
