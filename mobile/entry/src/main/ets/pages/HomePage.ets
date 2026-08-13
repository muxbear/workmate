import { photoAccessHelper } from '@kit.MediaLibraryKit'
import { picker } from '@kit.CoreFileKit'
import { RobotMascot } from '../components/RobotMascot'
import { SegmentedControl } from '../components/SegmentedControl'
import { Sidebar } from '../components/Sidebar'
import { TaskSheet } from '../components/TaskSheet'
import { MediaSheet } from '../components/MediaSheet'
import { chatStore } from '../store/ChatStore'
import { sessionStore } from '../store/SessionStore'
import { ServiceFactory } from '../services/ServiceFactory'
import { Workspace } from '../common/types/Models'
import { ChatPageParams } from './ChatPage'

interface QuickAction {
  label: string
  icon: string
}

const QUICK_ACTIONS: QuickAction[] = [
  { label: '幻灯片', icon: '▭' },
  { label: '视频生成', icon: '◉' },
  { label: '深度研究', icon: '⌕' },
  { label: '更多', icon: '⋯' },
]

/** 首页:双 Tab + 快捷指令 + 输入栏 + 侧边栏 */
@Component
export struct HomePage {
  pathStack: NavPathStack = new NavPathStack()
  @State input: string = ''
  @State sidebarOpen: boolean = false
  @State sideTab: number = 0
  @State sheetVisible: boolean = false
  @State mediaSheetVisible: boolean = false
  @State workspaces: Workspace[] = []
  tasks: string[] = []

  aboutToAppear(): void {
    // 刷新积分与工作空间(失败静默,有缓存值展示缓存)
    sessionStore.refreshPoints()
    ServiceFactory.getTask().listWorkspaces().then((r) => {
      if (r.ok) {
        this.workspaces = r.value
      }
    })
  }

  /** 发送消息 -> 聊天页(mode 取当前 Tab) */
  handleSend(): void {
    const q = this.input.trim()
    if (!q) {
      return
    }
    chatStore.mode = this.sideTab === 0 ? 'cloud' : 'desktop'
    const workspaceId = chatStore.selectedWorkspace.id
    this.input = ''
    const chatParams: ChatPageParams = { query: q, workspaceId: workspaceId }
    this.pathStack.pushPathByName('chat', chatParams)
  }

  @Builder
  QuickChips() {
    Scroll() {
      Row({ space: 8 }) {
        ForEach(QUICK_ACTIONS, (a: QuickAction) => {
          Row({ space: 6 }) {
            Text(a.icon).fontSize(15)
            Text(a.label).fontSize(14)
          }
          .padding({ left: 12, right: 12, top: 8, bottom: 8 })
          .borderRadius(12)
          .backgroundColor($r('app.color.card'))
          .shadow({ radius: 4, color: 'rgba(0,0,0,0.07)', offsetY: 1 })
          .onClick(() => {})
        }, (a: QuickAction) => a.label)
      }
    }
    .scrollable(ScrollDirection.Horizontal)
    .scrollBar(BarState.Off)
    .edgeEffect(EdgeEffect.Spring)
  }

  @Builder
  sheetBuilder() {
    TaskSheet({
      workspaces: this.workspaces,
      selectedId: chatStore.selectedWorkspace.id,
      onSelect: (ws: Workspace) => {
        chatStore.selectedWorkspace = ws
        this.sheetVisible = false
      },
    })
  }

  @Builder
  mediaSheetBuilder() {
    MediaSheet({
      onSelectPhoto: () => {
        this.selectPhoto()
      },
      onSelectFile: () => {
        this.selectFile()
      },
    })
  }

  /** 照片选择(系统 PhotoViewPicker) */
  async selectPhoto(): Promise<void> {
    try {
      const photoPicker = new photoAccessHelper.PhotoViewPicker()
      const result = await photoPicker.select({
        MIMEType: photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE,
        maxSelectNumber: 1,
      })
      this.mediaSheetVisible = false
      if (result.photoUris.length > 0) {
        this.getUIContext().getPromptAction().showToast({ message: '已选择照片' })
      }
    } catch (e) {
      console.error(`selectPhoto failed. Cause: ${JSON.stringify(e)}`)
    }
  }

  /** 文件选择(系统 DocumentViewPicker) */
  async selectFile(): Promise<void> {
    try {
      const ctx = this.getUIContext().getHostContext()
      if (!ctx) {
        return
      }
      const docPicker = new picker.DocumentViewPicker(ctx)
      const result = await docPicker.select({ maxSelectNumber: 1 })
      this.mediaSheetVisible = false
      if (result.length > 0) {
        this.getUIContext().getPromptAction().showToast({ message: '已选择文件' })
      }
    } catch (e) {
      console.error(`selectFile failed. Cause: ${JSON.stringify(e)}`)
    }
  }

  build() {
    NavDestination() {
      Stack() {
        // 主内容(侧边栏打开时右移)
        Column() {
          Row() {
            Button('≡')
              .type(ButtonType.Circle)
              .width(44)
              .height(44)
              .fontSize(18)
              .fontColor($r('app.color.text_primary'))
              .backgroundColor($r('app.color.card'))
              .shadow({ radius: 6, color: 'rgba(0,0,0,0.08)', offsetY: 1 })
              .onClick(() => {
                this.sidebarOpen = !this.sidebarOpen
              })
          }
          .width('100%')
          .padding({ left: 20, right: 20, top: 24 })
          .justifyContent(FlexAlign.Start)

          Blank()

          Column({ space: 24 }) {
            RobotMascot({ large: false })
            Text('KE-WORK 我帮你')
              .fontSize(28)
              .fontWeight(FontWeight.Bold)
              .fontColor($r('app.color.text_primary'))
              .id('home_title')
            SegmentedControl({
              options: ['云端工作', '连接电脑'],
              index: this.sideTab,
              onSelect: (i: number) => {
                this.sideTab = i
              },
            })
            .width(288)
          }

          Blank()

          Column({ space: 12 }) {
            // 云端模式:快捷指令
            if (this.sideTab === 0) {
              this.QuickChips()
            } else {
              // 连接电脑模式:任务选择器
              Row({ space: 8 }) {
                Text('▤').fontSize(16).fontColor($r('app.color.text_tertiary'))
                Text(chatStore.selectedWorkspace.name)
                  .fontSize(16)
                  .fontColor($r('app.color.text_secondary'))
                Text('⌄').fontSize(14).fontColor($r('app.color.text_tertiary'))
              }
              .width('100%')
              .justifyContent(FlexAlign.Start)
              .onClick(() => {
                this.sheetVisible = true
              })
              .margin({ left: 4 })
            }

            // 输入栏
            Row({ space: 12 }) {
              // 语音输入图标(麦克风)
              SymbolGlyph($r('sys.symbol.mic_fill'))
                .fontSize(22)
                .fontColor([$r('app.color.text_secondary')])

              TextInput({ placeholder: '发消息或按住说话', text: this.input })
                .fontSize(15)
                .backgroundColor(Color.Transparent)
                .layoutWeight(1)
                .onChange((v: string) => {
                  this.input = v
                })
                .onSubmit(() => this.handleSend())

              if (this.input.trim().length > 0) {
                Button('↑')
                  .type(ButtonType.Circle)
                  .width(32)
                  .height(32)
                  .fontSize(14)
                  .backgroundColor($r('app.color.primary'))
                  .fontColor($r('app.color.card'))
                  .onClick(() => this.handleSend())
              } else {
                Button('＋')
                  .type(ButtonType.Circle)
                  .width(32)
                  .height(32)
                  .fontSize(22)
                  .backgroundColor(Color.Transparent)
                  .fontColor($r('app.color.text_secondary'))
                  .onClick(() => {
                    this.mediaSheetVisible = true
                  })
              }
            }
            .width('100%')
            .padding({ left: 16, right: 16, top: 14, bottom: 14 })
            .borderRadius(16)
            .backgroundColor($r('app.color.input_bg'))
            .shadow({ radius: 8, color: 'rgba(0,0,0,0.08)', offsetY: 1 })

            // 连接电脑模式页脚
            if (this.sideTab === 1) {
              Text('内容由 AI 生成')
                .fontSize(12)
                .fontColor($r('app.color.text_tertiary'))
                .width('100%')
                .textAlign(TextAlign.Center)
            }
          }
          .width('100%')
          .padding({ left: 16, right: 16, bottom: 24 })
        }
        .width('100%')
        .height('100%')
        .translate({ x: this.sidebarOpen ? '76%' : 0 })
        .borderRadius(this.sidebarOpen ? { topLeft: 16, bottomLeft: 16 } : 0)
        .animation({ duration: 320, curve: Curve.EaseOut })

        // 侧边栏
        Sidebar({
          pathStack: this.pathStack,
          open: this.sidebarOpen,
          sideTab: this.sideTab,
          tasks: this.tasks,
          onOpenSettings: () => {
            this.sidebarOpen = false
            this.pathStack.pushPathByName('accountSettings', null)
          },
          onOpenSystemSettings: () => {
            this.sidebarOpen = false
            this.pathStack.pushPathByName('settings', null)
          },
        })
      }
      .width('100%')
      .height('100%')
      .bindSheet(this.mediaSheetVisible, this.mediaSheetBuilder, {
        height: 240,
        dragBar: true,
        showClose: false,
        backgroundColor: $r('app.color.card'),
      })
    }
    .backgroundColor($r('app.color.bg'))
    .hideTitleBar(true)
    .bindSheet(this.sheetVisible, this.sheetBuilder, {
      height: 420,
      dragBar: true,
      showClose: false,
      backgroundColor: $r('app.color.card'),
    })
  }
}
