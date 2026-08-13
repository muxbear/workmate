import { ChatBubble } from '../components/ChatBubble'
import { MarkdownBlock } from '../components/MarkdownBlock'
import { chatStore } from '../store/ChatStore'
import { ChatMessage } from '../common/types/Models'

export interface ChatPageParams {
  query: string
  workspaceId: string
}

/** 聊天页:cloud/desktop 双模式,AI 回复 thinking -> done */
@Component
export struct ChatPage {
  pathStack: NavPathStack = new NavPathStack()
  params: ChatPageParams = { query: '', workspaceId: '' }
  @State input: string = ''
  @State thinkExpanded: boolean = false
  @State pulse: boolean = false
  private scroller: Scroller = new Scroller()

  aboutToAppear(): void {
    if (this.params.query) {
      chatStore.send(this.params.query).then(() => {
        this.scroller.scrollEdge(Edge.Bottom)
      })
    }
  }

  /** 返回首页,保留会话 */
  goBack(): void {
    this.pathStack.pop()
  }

  @Builder
  ThinkingDots() {
    Row({ space: 6 }) {
      ForEach([0, 1, 2], (i: number) => {
        Circle()
          .width(8)
          .height(8)
          .fill($r('app.color.text_tertiary'))
          .opacity(this.pulse ? 0.2 : 0.6)
          .animation({
            duration: 500,
            delay: i * 120,
            iterations: -1,
            playMode: PlayMode.Alternate,
            curve: Curve.EaseInOut,
          })
      }, (i: number) => `${i}`)
    }
    .padding({ top: 8, bottom: 8 })
    .onAppear(() => {
      this.pulse = !this.pulse
    })
  }

  @Builder
  StatusRow() {
    Row({ space: 8 }) {
      Text('◉').fontSize(16).fontColor($r('app.color.text_tertiary'))
      Text('已完成').fontSize(14).fontColor($r('app.color.text_tertiary'))
      Text('⌄').fontSize(14).fontColor($r('app.color.text_tertiary'))
    }
    .margin({ bottom: 8 })
  }

  @Builder
  ThinkToggle() {
    Row({ space: 8 }) {
      Text('◔').fontSize(16).fontColor($r('app.color.text_tertiary'))
      Text('深度思考').fontSize(14).fontColor($r('app.color.text_tertiary'))
      Text('›')
        .fontSize(14)
        .fontColor($r('app.color.text_tertiary'))
        .rotate({ angle: this.thinkExpanded ? 90 : 0 })
        .animation({ duration: 200 })
    }
    .margin({ bottom: 8 })
    .onClick(() => {
      this.thinkExpanded = !this.thinkExpanded
    })

    if (this.thinkExpanded) {
      Text('正在分析 WorkBuddy 云端架构…检索相关文档…整理回答结构…')
        .fontSize(12)
        .fontColor($r('app.color.text_tertiary'))
        .lineHeight(18)
        .padding(12)
        .borderRadius(12)
        .backgroundColor($r('app.color.card_sub'))
        .margin({ bottom: 12 })
    }
  }

  build() {
    NavDestination() {
      Column() {
        // Header
        Row({ space: 12 }) {
          Button('≡')
            .type(ButtonType.Circle)
            .width(44)
            .height(44)
            .fontSize(16)
            .fontColor($r('app.color.text_primary'))
            .backgroundColor(chatStore.mode === 'cloud' ? $r('app.color.card') : $r('app.color.card_sub'))
            .shadow(chatStore.mode === 'cloud' ? { radius: 6, color: 'rgba(0,0,0,0.08)', offsetY: 1 } : { radius: 0 })
            .onClick(() => this.goBack())

          Column({ space: 2 }) {
            Text(this.title())
              .fontSize(16)
              .fontColor($r('app.color.text_primary'))
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
            if (chatStore.mode === 'desktop') {
              Row({ space: 4 }) {
                Text('▣').fontSize(12).fontColor($r('app.color.text_tertiary'))
                Text(`${chatStore.selectedWorkspace.device ?? 'DESKTOP-S3R6IMC'} · 任务`)
                  .fontSize(12)
                  .fontColor($r('app.color.text_tertiary'))
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
              }
            }
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)

          Row({ space: 8 }) {
            Button('↻').fontSize(16).fontColor($r('app.color.text_primary')).type(ButtonType.Circle).width(36).height(36).backgroundColor($r('app.color.card_sub'))
            Text('·').fontSize(18).fontColor($r('app.color.text_tertiary'))
            Button('⋯').fontSize(16).fontColor($r('app.color.text_primary')).type(ButtonType.Circle).width(36).height(36).backgroundColor($r('app.color.card_sub'))
          }
          .padding({ left: 12, right: 12, top: 8, bottom: 8 })
          .borderRadius(16)
          .backgroundColor($r('app.color.card_sub'))
        }
        .width('100%')
        .padding({ left: 16, right: 16, top: 24, bottom: 12 })
        .backgroundColor($r('app.color.bg'))

        // 消息列表
        List({ space: 16, scroller: this.scroller }) {
          ForEach(chatStore.messages, (msg: ChatMessage) => {
            ListItem() {
              if (msg.role === 'user') {
                ChatBubble({ text: msg.content })
              } else {
                Column({ space: 12 }) {
                  this.StatusRow()
                  this.ThinkToggle()
                  if (msg.status === 'thinking') {
                    this.ThinkingDots()
                  } else {
                    MarkdownBlock({ blocks: msg.blocks ?? [] })
                  }
                }
                .width('100%')
                .alignItems(HorizontalAlign.Start)
              }
            }
          }, (msg: ChatMessage) => msg.id)
        }
        .width('100%')
        .layoutWeight(1)
        .padding({ left: 16, right: 16 })

        // 输入栏
        Row({ space: 12 }) {
          Text('·').fontSize(20).fontColor($r('app.color.text_tertiary'))
          TextInput({ placeholder: '发消息或按住说话', text: this.input })
            .fontSize(15)
            .backgroundColor(Color.Transparent)
            .layoutWeight(1)
            .onChange((v: string) => {
              this.input = v
            })
            .onSubmit(() => this.handleSend())
          Button('＋')
            .type(ButtonType.Circle)
            .width(32)
            .height(32)
            .fontSize(14)
            .backgroundColor(Color.Transparent)
            .fontColor($r('app.color.text_secondary'))
            .onClick(() => {})
        }
        .width('100%')
        .padding({ left: 16, right: 16, top: 14, bottom: 14 })
        .borderRadius(16)
        .backgroundColor($r('app.color.input_bg'))
        .shadow({ radius: 8, color: 'rgba(0,0,0,0.08)', offsetY: 1 })
        .margin({ left: 16, right: 16, bottom: 8 })

        if (chatStore.mode === 'desktop') {
          Text('内容由 AI 生成')
            .fontSize(12)
            .fontColor($r('app.color.text_tertiary'))
            .width('100%')
            .textAlign(TextAlign.Center)
            .margin({ bottom: 8 })
        }
      }
      .width('100%')
      .height('100%')
      .backgroundColor(chatStore.mode === 'cloud' ? $r('app.color.bg') : $r('app.color.card'))
    }
    .hideTitleBar(true)
    .transition(TransitionEffect.OPACITY.combine(TransitionEffect.translate({ y: 30 })))
  }

  title(): string {
    return this.params.query.length > 12 ? `${this.params.query.slice(0, 12)}…` : this.params.query
  }

  async handleSend(): Promise<void> {
    const q = this.input.trim()
    if (!q) {
      return
    }
    this.input = ''
    await chatStore.send(q)
    this.scroller.scrollEdge(Edge.Bottom)
  }
}
