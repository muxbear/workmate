# WorkMate 移动版

HarmonyOS 应用（OpenHarmony / DevEco Studio 项目），使用 hvigor 构建。

## 目录结构

- `AppScope/`：应用级配置（`app.json5` 等）。
- `entry/`：主模块。
- `hvigor/`：构建配置。

## 构建

在 DevEco Studio 中打开 `mobile/`，或使用 hvigor 命令行构建。

## 约定

- SDK 版本：targetSdkVersion 6.1.0(23)，compatibleSdkVersion 6.0.0(20)。
- 依赖与构建产物（`oh_modules`、`build`、`.hvigor` 等）已通过 `.gitignore` 忽略，勿提交。
