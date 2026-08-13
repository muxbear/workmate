/**
 * 设计令牌:圆角/间距/字号(色彩全部走 resources/base|dark/element/color.json,$r 自动切换)
 */
export class Radius {
  static readonly PILL: number = 12      // 胶囊、输入栏、分段控件
  static readonly CARD: number = 16      // 卡片
  static readonly SHEET: number = 20     // 底部弹层
  static readonly MODAL: number = 24     // 弹窗
}

export class Spacing {
  static readonly XS: number = 4
  static readonly S: number = 8
  static readonly M: number = 12
  static readonly L: number = 16
  static readonly XL: number = 24
}

export class Font {
  static readonly TITLE: number = 28     // 页面主标题(KE-WORK 我帮你)
  static readonly H2: number = 16
  static readonly BODY: number = 15
  static readonly SMALL: number = 13
  static readonly TINY: number = 12
}
