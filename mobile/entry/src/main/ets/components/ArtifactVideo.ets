import { common } from '@kit.AbilityKit'
import { saveArtifactToSandbox } from '../common/utils/ArtifactAssets'

/**
 * 产物成片:带 token 取件到应用沙箱后播放(失败显示提示)。
 *
 * 产物接口需要 Authorization,不能把地址直接交给 Video 组件;因此先下载到
 * `filesDir/artifacts/` 再以本地路径播放(与 ArtifactImage 同一套取件思路)。
 */
@Component
export struct ArtifactVideo {
  @Prop url: string = ''
  @Prop caption: string = ''
  @Prop videoHeight: number = 200
  @State localPath: string = ''
  @State failed: boolean = false

  aboutToAppear(): void {
    this.load()
  }

  /** 从产物地址里取文件名(保留扩展名,便于播放器识别容器格式) */
  private fileName(): string {
    const marker: string = 'path='
    const at: number = this.url.indexOf(marker)
    let raw: string = at >= 0 ? this.url.substring(at + marker.length) : this.url
    const amp: number = raw.indexOf('&')
    if (amp >= 0) {
      raw = raw.substring(0, amp)
    }
    try {
      raw = decodeURIComponent(raw)
    } catch (err) {
      // 编码非法时按原样取文件名
    }
    const slash: number = raw.lastIndexOf('/')
    const name: string = slash >= 0 ? raw.substring(slash + 1) : raw
    return name !== '' ? name : `成片-${Date.now()}.mp4`
  }

  private load(): void {
    if (this.url === '') {
      this.failed = true
      return
    }
    const context = getContext(this) as common.UIAbilityContext
    saveArtifactToSandbox(context, this.url, this.fileName()).then((path: string | undefined) => {
      if (path === undefined) {
        this.failed = true
        return
      }
      this.localPath = path
    })
  }

  build() {
    Column() {
      if (this.localPath !== '') {
        Video({ src: this.localPath })
          .controls(true)
          .autoPlay(false)
          .objectFit(ImageFit.Contain)
          .width('100%')
          .height(this.videoHeight)
          .borderRadius(12)
      } else if (this.failed) {
        Text('成片加载失败,可在下方交付物清单中下载查看')
          .fontSize(12)
          .fontColor($r('app.color.text_tertiary'))
      } else {
        LoadingProgress()
          .width(28)
          .height(28)
          .color($r('app.color.text_tertiary'))
      }
      if (this.caption !== '') {
        Text(this.caption)
          .fontSize(12)
          .fontColor($r('app.color.text_tertiary'))
          .width('100%')
          .margin({ top: 6 })
      }
    }
    .width('100%')
    .constraintSize({ minHeight: 48 })
    .justifyContent(FlexAlign.Center)
    .margin({ bottom: 12 })
  }
}
