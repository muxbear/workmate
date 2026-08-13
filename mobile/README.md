# KE-WORK

> **KE-WORK,我帮你** — An AI work assistant for HarmonyOS, built with pure ArkTS & ArkUI.

KE-WORK is a native HarmonyOS application that brings an AI assistant to your phone and desktop workflows. Ask it to build slides, generate videos, run deep research, write code, or make reports — with a polished, fully custom-designed UI: onboarding flow, phone login, an AI chat with live "thinking" animation and rich Markdown replies, a draggable sidebar drawer, and system light/dark theming.

Built entirely on the official HarmonyOS stack (Stage model, ArkTS, ArkUI declarative UI, `@kit.*` APIs) — **zero third-party runtime dependencies**.

## Badges

![Platform](https://img.shields.io/badge/Platform-HarmonyOS-0A7EED)
![SDK](https://img.shields.io/badge/SDK-6.1.0%20%28API%2023%29-0A7EED)
![Model](https://img.shields.io/badge/Model-Stage-00b96b)
![Language](https://img.shields.io/badge/Language-ArkTS-3178c6)
![UI](https://img.shields.io/badge/UI-ArkUI%20Declarative-ff7043)
![State](https://img.shields.io/badge/State-V1%20%2B%20V2-8e44ad)
![Tests](https://img.shields.io/badge/Tests-hypium-f39c12)

## Features

- **Onboarding** — 2.6s animated welcome screen with feature intro, progress bar and skip; auto-routes to Home or Login based on sign-in state.
- **Sign-in** — phone login, one-click phone login, social login icons, agreement modal (sibling-node overlay, no click bubbling), loading overlay with hit-test gating.
- **Dual-mode Home** — "Cloud work" (quick-action chips, horizontally scrollable) vs "Connect PC" (workspace picker bottom sheet); input bar with voice icon, send/add button morphing, `onSubmit` keyboard send.
- **AI Chat** — optimistic user bubble → breathing "thinking" dots → rich reply; deep-think toggle with rotating chevron; auto-scroll to bottom; **hand-rolled Markdown renderer** (inline `**bold**` via Span, heading / list / table blocks).
- **Sidebar drawer** — custom 3-layer Stack implementation (mask + drawer + main content push), SVG path icons, dual tabs, task list empty state, points bar with thousand-separator formatting.
- **Theming** — system/light/dark three-way switch; colors live in `resources/base|dark` qualified dirs; `setColorMode` + Preferences persistence; theme restored on launch.
- **Media** — system photo picker (`PhotoViewPicker`) and document picker (`DocumentViewPicker`) — no sensitive permission required; system `SymbolGlyph` + hand-drawn `Path` line icons.
- **Mock/Real service switch** — one constant flips the whole app between Mock and Real backend implementations.

## Screenshots

<!-- Add real screenshots by dropping images into `docs/screenshots/` and replacing the placeholders below. -->

| Welcome | Home | Chat |
| ------- | ---- | ---- |
| <img src="docs/screenshots/welcome.png" width="200" alt="Welcome"/> | <img src="docs/screenshots/home.png" width="200" alt="Home"/> | <img src="docs/screenshots/chat.png" width="200" alt="Chat"/> |

## Tech Stack

| Layer | Technology |
| ----- | ---------- |
| OS / SDK | HarmonyOS 6.1.0 (target API 23, compatible API 20) |
| Language | ArkTS (strict TypeScript subset) |
| UI | ArkUI declarative — `@Component` / `@Builder` / `@Entry` |
| App model | Stage (`UIAbility` + `module.json5`) |
| Navigation | `Navigation` + `NavPathStack` (registry builder, typed params, transitions) |
| State mgmt | V1 (`@State` / `@Prop` / `@Link`) + V2 (`@ObservedV2` / `@Trace` global stores) |
| Networking | `@kit.NetworkKit` — unified `HttpClient` (token injection, timeouts, `Result<T>` unwrapping) |
| Storage | `@kit.ArkData` Preferences (sync API) |
| Media | `@kit.MediaLibraryKit` (photo picker), `@kit.CoreFileKit` (document picker, backup) |
| Tests | `@ohos/hypium` unit tests + `@kit.TestKit` UI smoke tests |

## Architecture

Strict five-layer, one-way dependency:

```
pages ──► components ──► store ──► services ──► common
                                   ├── contracts/   (interfaces)
                                   ├── mock/        (fake impl, delay-simulated)
                                   ├── real/        (HTTP impl via HttpClient)
                                   └── ServiceFactory (single switch point)
```

- **Pages** own only local UI state (`@State`) and navigation; zero business logic.
- **Stores** (`@ObservedV2` singletons) hold shared state and orchestrate flows — e.g. the chat message state machine (`user → thinking → done`).
- **Services** expose interfaces only; `Constants.USE_MOCK = true` routes every call to Mock, flip it to `false` to hit the real backend — pages never change.

## Project Structure

```
KeWork/
├── AppScope/
│   └── app.json5                  # bundle name, version, app icon
├── entry/src/main/
│   ├── module.json5               # permissions, abilities, page routes
│   ├── ets/
│   │   ├── entryability/          # EntryAbility (lifecycle, theme restore)
│   │   ├── entrybackupability/    # backup/restore extension
│   │   ├── pages/                 # 8 pages (Index/Welcome/Login/Home/Chat/...)
│   │   ├── components/            # 11 custom components (bubble/modal/sheet/...)
│   │   ├── services/              # contracts + mock + real + HttpClient
│   │   ├── store/                 # SessionStore / ChatStore / SettingsStore
│   │   └── common/                # types / constants / theme / utils
│   └── resources/
│       ├── base/                  # light resources (colors, strings, media)
│       └── dark/                  # dark-mode color overrides
├── entry/src/test/                # local unit tests (hypium)
├── entry/src/ohosTest/            # instrumented / UI smoke tests
└── docs/
    └── HarmonyOS 由入门到精通.md   # in-depth HarmonyOS tutorial (Chinese)
```

## Getting Started

### Prerequisites

- [DevEco Studio](https://developer.huawei.com/consumer/cn/deveco-studio/) (6.x or later)
- HarmonyOS SDK with **API 23** (project targets 6.1.0, compatible with 6.0.0/API 20)
- A device or emulator running HarmonyOS 5.0+

### Build & Run

1. **Clone** the repository and open it in DevEco Studio.
2. **Sync** — let DevEco Studio resolve `oh-package.json5` (only dev dependencies: `@ohos/hypium`, `@ohos/hamock`).
3. **Sign** — with `signingConfigs` empty, DevEco Studio auto-signs for your local debug runs (File → Project Structure → Signing Configs, or accept the auto-signed default).
4. **Run** — select the `entry` module and press Run ▶ on an emulator or device.

> 💡 Out of the box the app runs in **Mock mode** (`Constants.USE_MOCK = true` in `entry/src/main/ets/common/constants/Constants.ets`) — full feature set works with no backend. Point it at your API by setting `BASE_URL` and flipping `USE_MOCK` to `false`.

### Running Tests

```bash
# Local unit tests (pure logic: Formatter, MarkdownParser, ...)
hvigorw entry/src/test  --mode module -p product=default

# Instrumented / UI smoke tests (needs emulator or device)
hvigorw entry/src/ohosTest --mode module -p product=default
```

*(or simply right-click the test directory in DevEco Studio → Run)*

## Documentation

- [**HarmonyOS 由入门到精通**](docs/HarmonyOS%20由入门到精通.md) — a full Chinese tutorial (31 chapters) that walks through every HarmonyOS concept this app uses, with real code from this repo: ArkTS types, ArkUI layout/components, V1/V2 state management, Navigation, sheets/modals, animations, networking, theming, media, architecture patterns and testing.

## Roadmap

- [ ] Persist session token (Preferences) for "keep me signed in"
- [ ] Real voice input (AudioCapturer) behind the mic icon
- [ ] Long-message actions on chat bubbles (copy / delete / regenerate)
- [ ] `@ohos/hamock` integration alongside the USE_MOCK switch
- [ ] Multi-device support (foldables, tablets) & distributed continuity
- [ ] Release signing & AppGallery publishing

## Contributing

This is a learning-oriented project — PRs and issues are welcome. When contributing:

1. Keep the dependency direction strict: `pages → components → store → services → common`.
2. Colors go into `resources/base|dark/element/color.json`; numbers go into the design tokens in `common/theme/Theme.ets`.
3. Follow the existing patterns: interfaces for services, `Result<T>` everywhere, immutable array updates in stores.

## License

License not yet specified — all rights reserved. Contact the maintainer before reusing the code.

---

*Made with the official HarmonyOS stack: ArkTS · ArkUI · Stage model · `@kit.*`.*
