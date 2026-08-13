export interface SocialEntry {
  key: string
  label: string
  icon: Resource
}

/** 社交登录入口(微信/QQ/企业版/其他) */
export const SOCIAL_ENTRIES: SocialEntry[] = [
  { key: 'wechat', label: '微信', icon: $r('app.media.icon_wechat') },
  { key: 'qq', label: 'QQ', icon: $r('app.media.icon_qq') },
  { key: 'enterprise', label: '企业版', icon: $r('app.media.icon_enterprise') },
  { key: 'more', label: '其他', icon: $r('app.media.icon_more') },
]

@Component
export struct SocialLoginIcons {
  onTap: (key: string) => void = () => {}

  build() {
    Row() {
      ForEach(SOCIAL_ENTRIES, (entry: SocialEntry) => {
        Column({ space: 8 }) {
          Button() {
            Image(entry.icon).width(30).height(30)
          }
          .type(ButtonType.Circle)
          .width(64)
          .height(64)
          .backgroundColor($r('app.color.card_sub'))
          .onClick(() => this.onTap(entry.key))

          Text(entry.label)
            .fontSize(12)
            .fontColor($r('app.color.text_secondary'))
        }
        .layoutWeight(1)
      }, (entry: SocialEntry) => entry.key)
    }
    .width('100%')
  }
}
