import { Workspace } from '../common/types/Models'
import { Spacing } from '../common/theme/Theme'

/** 工作空间选择面板(bindSheet 的 builder 内容) */
@Component
export struct TaskSheet {
  @Prop workspaces: Workspace[] = []
  @Prop selectedId: string = ''
  onSelect: (ws: Workspace) => void = () => {}

  @Builder
  WsRow(ws: Workspace, isSection: boolean) {
    Row({ space: 12 }) {
      if (isSection) {
        Text('🗂').fontSize(18)
      } else {
        Text('📄').fontSize(18)
      }
      Column({ space: 2 }) {
        Text(ws.name)
          .fontSize(16)
          .fontWeight(ws.id === this.selectedId ? FontWeight.Bold : FontWeight.Normal)
          .fontColor(ws.id === this.selectedId ? $r('app.color.accent') : $r('app.color.text_primary'))
        if (ws.device) {
          Text(ws.device).fontSize(12).fontColor($r('app.color.text_tertiary'))
        }
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
      if (ws.id === this.selectedId) {
        Text('✓')
          .fontSize(16)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.accent'))
      }
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 14, bottom: 14 })
    .borderRadius(16)
    .backgroundColor(ws.id === this.selectedId ? $r('app.color.accent_soft') : Color.Transparent)
    .onClick(() => this.onSelect(ws))
  }

  build() {
    Column({ space: 4 }) {
      Text('选择工作空间')
        .fontSize(18)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.text_primary'))
        .margin({ bottom: 4 })
      Text(`新会话归入哪个列表 · ${this.workspaces[0]?.device ?? ''}`)
        .fontSize(14)
        .fontColor($r('app.color.text_tertiary'))
        .margin({ bottom: Spacing.L })

      ForEach(this.workspaces, (ws: Workspace) => {
        this.WsRow(ws, false)
      }, (ws: Workspace) => ws.id)
    }
    .padding({ left: 20, right: 20, top: 24, bottom: 32 })
    .alignItems(HorizontalAlign.Start)
  }
}
