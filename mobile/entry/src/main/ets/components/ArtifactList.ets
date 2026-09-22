import { ChatArtifact } from '../common/types/Models'
import { turnLabel } from '../common/utils/ArtifactGroups'

/** 一轮交付物清单:轮次标题 + 文件 chip + 打包下载(落盘由宿主页面处理) */
@Component
export struct ArtifactList {
  @Prop artifacts: ChatArtifact[] = []
  @Prop threadId: string = ''
  @Prop onDownload: (item: ChatArtifact) => void = () => {}
  @Prop onBundle: (turn: string) => void = () => {}

  private turnOf(): string {
    if (this.artifacts.length === 0) {
      return ''
    }
    const turn: string | undefined = this.artifacts[0].turn
    return turn === undefined ? '' : turn
  }

  build() {
    Column({ space: 8 }) {
      Row({ space: 8 }) {
        Text(turnLabel(this.turnOf()) === '' ? '本轮交付物' : turnLabel(this.turnOf()))
          .fontSize(12)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.text_secondary'))
        Button('打包下载')
          .fontSize(12)
          .height(28)
          .backgroundColor($r('app.color.card_sub'))
          .fontColor($r('app.color.text_primary'))
          .onClick(() => {
            this.onBundle(this.turnOf())
          })
      }
      .width('100%')
      .justifyContent(FlexAlign.SpaceBetween)

      ForEach(this.artifacts, (item: ChatArtifact) => {
        Row({ space: 8 }) {
          Text(item.name)
            .fontSize(13)
            .fontColor($r('app.color.text_primary'))
            .layoutWeight(1)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Button('下载')
            .fontSize(12)
            .height(28)
            .backgroundColor($r('app.color.card_sub'))
            .fontColor($r('app.color.text_primary'))
            .onClick(() => {
              this.onDownload(item)
            })
        }
        .width('100%')
        .padding({ left: 12, right: 12, top: 8, bottom: 8 })
        .borderRadius(10)
        .backgroundColor($r('app.color.card'))
      }, (item: ChatArtifact) => item.path)
    }
    .width('100%')
    .padding({ top: 4, bottom: 4 })
    .alignItems(HorizontalAlign.Start)
  }
}
