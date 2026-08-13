# KE-WORK

> **KE-WORK,我帮你** — 基于纯 ArkTS & ArkUI 的 HarmonyOS AI 工作助手。

KE-WORK 是一款原生 HarmonyOS 应用,把 AI 助手带到你的手机与电脑工作流中:一键生成幻灯片、创作 AI 视频、深度研究、写代码、做报告。拥有完全自研的高品质 UI:引导页、手机登录、带"思考中"动画与富文本 Markdown 回复的 AI 聊天、可拖动侧边栏抽屉、系统级深浅色主题。

完全基于官方 HarmonyOS 技术栈构建(Stage 模型、ArkTS、ArkUI 声明式 UI、`@kit.*` 套件)——**零第三方运行时依赖**。

## 徽章

![Platform](https://img.shields.io/badge/平台-HarmonyOS-0A7EED)
![SDK](https://img.shields.io/badge/SDK-6.1.0%20%28API%2023%29-0A7EED)
![Model](https://img.shields.io/badge/模型-Stage-00b96b)
![Language](https://img.shields.io/badge/语言-ArkTS-3178c6)
![UI](https://img.shields.io/badge/UI-ArkUI%20声明式-ff7043)
![State](https://img.shields.io/badge/状态-V1%20%2B%20V2-8e44ad)
![Tests](https://img.shields.io/badge/测试-hypium-f39c12)

## 功能特性

- **引导页** — 2.6s 动画欢迎页:特性介绍、进度条、可跳过;按登录态自动分流到首页或登录页。
- **登录体系** — 手机号登录、本机一键登录、社交登录图标;协议弹窗(兄弟节点遮罩,点击不冒泡);带点击拦截的加载遮罩。
- **双模式首页** — "云端工作"(可横向滚动的快捷指令)与"连接电脑"(工作空间选择底部面板);输入栏带语音图标、发送/添加按钮形态切换、键盘回车发送。
- **AI 聊天** — 乐观更新用户气泡 → 呼吸"思考中"动画 → 富文本回复;可展开的"深度思考"开关(箭头旋转动画);自动滚动到底;**纯手写 Markdown 渲染器**(Span 实现行内 `**加粗**`,支持标题/列表/表格块)。
- **侧边栏抽屉** — 自研三层 Stack 实现(遮罩 + 抽屉 + 主内容右移推挤),SVG Path 线稿图标,双 Tab,任务区空态,千分位格式化的积分条。
- **主题切换** — 系统/浅色/深色三选一;颜色全部走 `resources/base|dark` 限定符资源;`setColorMode` + Preferences 持久化;启动时自动恢复。
- **媒体能力** — 系统照片选择器(`PhotoViewPicker`)与文件选择器(`DocumentViewPicker`),**无需敏感权限**;系统 SymbolGlyph 图标 + 手绘 Path 线稿图标。
- **Mock/Real 服务切换** — 一个常量开关,整个应用在假数据与真实后端之间一键切换。

## 截图

<!-- 将真实截图放入 `docs/screenshots/`,替换下面的占位即可。 -->

| 欢迎页 | 首页 | 聊天页 |
| ------ | ---- | ------ |
| <img src="docs/screenshots/welcome.png" width="200" alt="欢迎页"/> | <img src="docs/screenshots/home.png" width="200" alt="首页"/> | <img src="docs/screenshots/chat.png" width="200" alt="聊天页"/> |

## 技术栈

| 层次 | 技术 |
| ---- | ---- |
| 系统 / SDK | HarmonyOS 6.1.0(target API 23,兼容 API 20) |
| 语言 | ArkTS(TypeScript 严格子集) |
| UI | ArkUI 声明式 — `@Component` / `@Builder` / `@Entry` |
| 应用模型 | Stage 模型(`UIAbility` + `module.json5`) |
| 导航 | `Navigation` + `NavPathStack`(注册表 Builder、类型化参数、页面转场) |
| 状态管理 | V1(`@State` / `@Prop` / `@Link`)+ V2(`@ObservedV2` / `@Trace` 全局 Store) |
| 网络 | `@kit.NetworkKit` — 统一 `HttpClient`(Token 注入、超时、`Result<T>` 解包) |
| 存储 | `@kit.ArkData` Preferences(同步 API) |
| 媒体 | `@kit.MediaLibraryKit`(照片选择)、`@kit.CoreFileKit`(文件选择、备份) |
| 测试 | `@ohos/hypium` 单元测试 + `@kit.TestKit` UI 冒烟测试 |

## 架构

严格的五层单向依赖:

```
pages ──► components ──► store ──► services ──► common
                                   ├── contracts/    (接口契约)
                                   ├── mock/         (假实现,delay 模拟耗时)
                                   ├── real/         (真实实现,委托 HttpClient)
                                   └── ServiceFactory (唯一切换点)
```

- **页面层**只持有局部 UI 状态(`@State`)与导航逻辑,零业务代码。
- **Store 层**(`@ObservedV2` 单例)持有共享状态并编排业务流——例如聊天消息状态机(`user → thinking → done`)。
- **服务层**只暴露接口;`Constants.USE_MOCK = true` 时全部调用走 Mock,改为 `false` 即请求真实后端——页面代码永不改变。

## 项目结构

```
KeWork/
├── AppScope/
│   └── app.json5                  # 包名、版本、应用图标
├── entry/src/main/
│   ├── module.json5               # 权限、Ability、页面路由表
│   ├── ets/
│   │   ├── entryability/          # EntryAbility(生命周期、主题恢复)
│   │   ├── entrybackupability/    # 备份/恢复扩展
│   │   ├── pages/                 # 8 个页面(Index/Welcome/Login/Home/Chat/...)
│   │   ├── components/            # 11 个自定义组件(气泡/弹窗/面板/...)
│   │   ├── services/              # contracts + mock + real + HttpClient
│   │   ├── store/                 # SessionStore / ChatStore / SettingsStore
│   │   └── common/                # types / constants / theme / utils
│   └── resources/
│       ├── base/                  # 浅色资源(颜色、文案、图片)
│       └── dark/                  # 深色模式颜色覆盖
├── entry/src/test/                # 本地单元测试(hypium)
├── entry/src/ohosTest/            # 设备测试 / UI 冒烟测试
└── docs/
    └── HarmonyOS 由入门到精通.md   # 深度 HarmonyOS 学习教程
```

## 快速开始

### 环境要求

- [DevEco Studio](https://developer.huawei.com/consumer/cn/deveco-studio/)(6.x 及以上)
- 包含 **API 23** 的 HarmonyOS SDK(工程 target 6.1.0,兼容 6.0.0/API 20)
- HarmonyOS 5.0+ 的真机或模拟器

### 构建与运行

1. **克隆**仓库并用 DevEco Studio 打开。
2. **同步** — 让 DevEco Studio 解析 `oh-package.json5`(仅开发依赖:`@ohos/hypium`、`@ohos/hamock`)。
3. **签名** — `signingConfigs` 为空数组,DevEco Studio 会为本地调试自动签名(File → Project Structure → Signing Configs,或直接接受自动签名)。
4. **运行** — 选择 `entry` 模块,在模拟器/真机上点击 Run ▶。

> 💡 开箱即运行在 **Mock 模式**下(`entry/src/main/ets/common/constants/Constants.ets` 中 `Constants.USE_MOCK = true`)——无需后端即可体验全部功能。后端就绪后,设置 `BASE_URL` 并把 `USE_MOCK` 改为 `false` 即可。

### 运行测试

```bash
# 本地单元测试(纯逻辑:Formatter、MarkdownParser 等)
hvigorw entry/src/test  --mode module -p product=default

# 设备/UI 冒烟测试(需要模拟器或真机)
hvigorw entry/src/ohosTest --mode module -p product=default
```

*(或在 DevEco Studio 中右键测试目录 → Run)*

## 文档

- [**HarmonyOS 由入门到精通**](docs/HarmonyOS%20由入门到精通.md) — 31 章中文学习教程,以本仓库真实代码为载体,由浅入深讲解本应用用到的全部 HarmonyOS 知识:ArkTS 类型、ArkUI 布局与组件、V1/V2 状态管理、Navigation 导航、面板与弹窗、动画、网络、主题、媒体、架构模式与测试。

## 路线图

- [ ] 持久化会话 token(Preferences),实现"记住登录"
- [ ] 麦克风图标接入真实语音输入(AudioCapturer)
- [ ] 聊天气泡长按操作(复制 / 删除 / 重新生成)
- [ ] 在 USE_MOCK 开关基础上接入 `@ohos/hamock`
- [ ] 多设备适配(折叠屏、平板)与分布式流转
- [ ] 正式签名与华为应用市场上架

## 参与贡献

本项目以学习为导向,欢迎提交 PR 与 Issue。贡献时请遵循:

1. 保持严格的依赖方向:`pages → components → store → services → common`。
2. 颜色写入 `resources/base|dark/element/color.json`;数值写入 `common/theme/Theme.ets` 设计令牌。
3. 遵循既有范式:服务层走接口、统一 `Result<T>` 返回、Store 中数组不可变更新。

## License

尚未指定 License,保留所有权利。复用代码前请联系维护者。

---

*基于官方 HarmonyOS 技术栈打造:ArkTS · ArkUI · Stage 模型 · `@kit.*`。*
