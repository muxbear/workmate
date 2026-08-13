/** 吉祥物:登录页 208 宽,其余页面 176 宽 */
@Component
export struct RobotMascot {
  @Prop large: boolean = false

  build() {
    Image($r('app.media.robot_mascot'))
      .width(this.large ? 208 : 176)
      .height(this.large ? 229 : 194)
      .objectFit(ImageFit.Contain)
  }
}
