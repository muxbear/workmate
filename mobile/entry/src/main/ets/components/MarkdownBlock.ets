import { ContentBlock } from '../common/types/Models'
import { parseBold, InlinePiece } from '../common/utils/MarkdownParser'
import { Spacing } from '../common/theme/Theme'
import { DataTable } from './DataTable'

/** AI 回复内容渲染:text/heading/table/list,内联 **加粗** */
@Component
export struct MarkdownBlock {
  @Prop blocks: ContentBlock[] = []

  @Builder
  InlineBold(text: string) {
    Text() {
      ForEach(parseBold(text), (piece: InlinePiece) => {
        Span(piece.text)
          .fontWeight(piece.bold ? FontWeight.Bold : FontWeight.Normal)
      }, (piece: InlinePiece, i: number) => `${i}-${piece.text}`)
    }
    .fontSize(15)
    .fontColor($r('app.color.text_primary'))
  }

  @Builder
  BlockItem(block: ContentBlock) {
    if (block.type === 'text') {
      Row() {
        this.InlineBold(block.content)
      }
      .constraintSize({ maxWidth: '100%' })
      .margin({ bottom: Spacing.M })
    } else if (block.type === 'heading') {
      Text(block.content)
        .fontSize(16)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.text_primary'))
        .margin({ bottom: Spacing.M })
    } else if (block.type === 'list') {
      Column() {
        ForEach(block.items, (item: string) => {
          Row({ space: 8 }) {
            Circle()
              .width(6)
              .height(6)
              .fill($r('app.color.text_secondary'))
              .margin({ top: 8 })
            Row() {
              this.InlineBold(item)
            }
            .layoutWeight(1)
          }
          .alignItems(VerticalAlign.Top)
          .margin({ bottom: Spacing.M })
        }, (item: string, i: number) => `${i}-${item}`)
      }
    } else if (block.type === 'table') {
      DataTable({ headers: block.headers, rows: block.rows })
        .margin({ bottom: Spacing.M })
    }
  }

  build() {
    Column() {
      ForEach(this.blocks, (block: ContentBlock, i: number) => {
        this.BlockItem(block)
      }, (block: ContentBlock, i: number) => `${i}-${block.type}`)
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
  }
}
