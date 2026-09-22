import { image } from '@kit.ImageKit'
import { loadArtifactPixelMap } from '../common/utils/ArtifactAssets'

/** 产物配图:按需拉取字节并解码渲染(失败显示占位) */
@Component
export struct ArtifactImage {
  @Prop url: string = ''
  @Prop imageHeight: number = 180
  @State pixelMap: image.PixelMap | undefined = undefined
  @State failed: boolean = false

  aboutToAppear(): void {
    this.load()
  }

  private load(): void {
    if (this.url === '') {
      this.failed = true
      return
    }
    loadArtifactPixelMap(this.url).then((map: image.PixelMap | undefined) => {
      if (map === undefined) {
        this.failed = true
        return
      }
      this.pixelMap = map
    })
  }

  build() {
    Column() {
      if (this.pixelMap !== undefined) {
        Image(this.pixelMap)
          .width('100%')
          .height(this.imageHeight)
          .objectFit(ImageFit.Contain)
          .borderRadius(12)
      } else if (this.failed) {
        Text('配图加载失败')
          .fontSize(12)
          .fontColor($r('app.color.text_tertiary'))
      } else {
        LoadingProgress()
          .width(28)
          .height(28)
          .color($r('app.color.text_tertiary'))
      }
    }
    .width('100%')
    .constraintSize({ minHeight: 48 })
    .justifyContent(FlexAlign.Center)
    .margin({ bottom: 12 })
  }
}
