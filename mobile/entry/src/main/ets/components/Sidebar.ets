import { sessionStore } from '../store/SessionStore'
import { formatNumber } from '../common/utils/Formatter'

interface MenuItem {
  label: string
  path: string
}

/** 菜单图标:设计稿 SVG 转 Path 命令,统一线稿风格(24x24、1.8 描边,手机标准列表图标尺寸) */
const MENU_ITEMS: MenuItem[] = [
  {
    label: '自动化',
    path: 'M10 2.5a7.5 7.5 0 1 0 0 15a7.5 7.5 0 1 0 0 -15 M10 5.5v4.5l3 2',
  },
  {
    label: '项目',
    path: 'M4.5 7a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0 M11.5 7a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0 M4.5 14a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0 M9.5 7h2 M7 9.5v2 M12 9a2.5 2.5 0 0 1 2.5 2.5v3',
  },
  {
    label: '专家',
    path: 'M10 2.5c-2.5 0-4.5 2-4.5 4.5 0 2 1.2 3.7 3 4.4V13h3v-1.6c1.8-.7 3-2.4 3-4.4 0-2.5-2-4.5-4.5-4.5z M7.5 13.5v1a2.5 2.5 0 0 0 5 0v-1 M8.5 7l1 1 2-2',
  },
]

/** 侧边栏抽屉:用户信息/双 Tab/菜单/任务/积分 */
@Component
export struct Sidebar {
  pathStack: NavPathStack = new NavPathStack()
  @Link open: boolean
  @Link sideTab: number
  onOpenSettings: () => void = () => {}
  onOpenSystemSettings: () => void = () => {}
  tasks: string[] = []

  @Builder
  MenuItemRow(item: MenuItem) {
    Row({ space: 12 }) {
      Path()
        .commands(item.path)
        .fillOpacity(0)
        .stroke($r('app.color.text_primary'))
        .strokeWidth(1.8)
        .width(24)
        .height(24)
      Text(item.label)
        .fontSize(16)
        .fontColor($r('app.color.text_primary'))
        .layoutWeight(1)
      Text('›').fontSize(16).fontColor($r('app.color.text_tertiary'))
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 14, bottom: 14 })
    .borderRadius(12)
  }

  build() {
    Stack() {
      // 遮罩
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor('rgba(0,0,0,0.25)')
        .opacity(this.open ? 1 : 0)
        .hitTestBehavior(this.open ? HitTestMode.Block : HitTestMode.None)
        .onClick(() => {
          this.open = false
        })
        .animation({ duration: 320, curve: Curve.EaseOut })

      // 抽屉
      Column() {
        // 头部:头像 + 设置入口
        Row({ space: 12 }) {
          Stack() {
            Text(sessionStore.profile?.nickname.slice(0, 1) ?? '未登录')
              .fontSize(18)
              .fontWeight(FontWeight.Bold)
              .fontColor(Color.White)
          }
          .width(48)
          .height(48)
          .borderRadius(24)
          .backgroundColor('#34d399')
          .clip(true)
          .onClick(() => this.onOpenSettings())

          Column({ space: 2 }) {
            Text(sessionStore.profile?.nickname ?? '未登录')
              .fontSize(16)
              .fontWeight(FontWeight.Bold)
              .fontColor($r('app.color.text_primary'))
            Text(sessionStore.profile?.level ?? '')
              .fontSize(12)
              .fontColor($r('app.color.text_tertiary'))
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)

          Button('⚙')
            .type(ButtonType.Circle)
            .width(36)
            .height(36)
            .fontSize(16)
            .backgroundColor($r('app.color.card_sub'))
            .onClick(() => this.onOpenSystemSettings())
        }
        .width('100%')
        .padding({ left: 20, right: 20, top: 24, bottom: 16 })

        // 双 Tab(云端工作/连接电脑)
        Row({ space: 4 }) {
          ForEach(['云端工作', '连接电脑'], (label: string, i: number) => {
            Text(label)
              .fontSize(14)
              .fontWeight(this.sideTab === i ? FontWeight.Medium : FontWeight.Normal)
              .fontColor(this.sideTab === i ? $r('app.color.text_primary') : $r('app.color.text_tertiary'))
              .textAlign(TextAlign.Center)
              .height(40)
              .layoutWeight(1)
              .backgroundColor(this.sideTab === i ? $r('app.color.card') : Color.Transparent)
              .borderRadius(12)
              .shadow(this.sideTab === i ? { radius: 4, color: 'rgba(0,0,0,0.1)', offsetY: 1 } : { radius: 0 })
              .onClick(() => {
                this.sideTab = i
              })
          }, (label: string) => label)
        }
        .padding(4)
        .borderRadius(16)
        .backgroundColor($r('app.color.card_sub'))
        .margin({ left: 16, right: 16, bottom: 16 })

        // 菜单
        Column({ space: 4 }) {
          ForEach(MENU_ITEMS, (item: MenuItem) => {
            this.MenuItemRow(item)
          }, (item: MenuItem) => item.label)
        }
        .padding({ left: 8, right: 8 })
        .margin({ bottom: 8 })

        Divider().color($r('app.color.divider')).margin({ left: 16, right: 16, bottom: 16 })

        // 任务区
        Column() {
          Row() {
            Text('任务')
              .fontSize(14)
              .fontColor($r('app.color.text_tertiary'))
              .layoutWeight(1)
            Text('编辑')
              .fontSize(14)
              .fontColor($r('app.color.accent'))
          }
          .width('100%')
          .margin({ bottom: 12 })

          Row({ space: 8 }) {
            Text('＋').fontSize(18).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'))
            Text('新建任务').fontSize(16).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'))
          }
          .margin({ bottom: 16 })
          .onClick(() => {})

          if (this.tasks.length === 0) {
            Text('暂无云端任务')
              .fontSize(14)
              .fontColor($r('app.color.text_tertiary'))
              .layoutWeight(1)
          } else {
            ForEach(this.tasks, (t: string) => {
              Text(t).fontSize(14).fontColor($r('app.color.text_primary'))
            }, (t: string) => t)
          }
        }
        .padding({ left: 20, right: 20 })
        .layoutWeight(1)

        // 积分
        Row({ space: 12 }) {
          Text('◈').fontSize(20).fontColor($r('app.color.text_primary'))
          Text('积分余额')
            .fontSize(16)
            .fontColor($r('app.color.text_primary'))
            .layoutWeight(1)
          Text(formatNumber(sessionStore.points?.balance ?? 0))
            .fontSize(16)
            .fontColor($r('app.color.text_primary'))
          Text('›').fontSize(16).fontColor($r('app.color.text_tertiary'))
        }
        .width('100%')
        .padding({ left: 20, right: 20, top: 16, bottom: 16 })
        .border({ width: { top: 1 }, color: $r('app.color.divider') })
      }
      .width('76%')
      .height('100%')
      .backgroundColor($r('app.color.card'))
      .translate({ x: this.open ? 0 : '-100%' })
      .animation({ duration: 320, curve: Curve.EaseOut })
    }
    .alignContent(Alignment.Start)
    .hitTestBehavior(this.open ? HitTestMode.Default : HitTestMode.None)
    .width('100%')
    .height('100%')
  }
}
