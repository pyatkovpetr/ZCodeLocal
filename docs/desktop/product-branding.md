# ZCodeLocal 产品名

## Feature Summary

| Field                 | Value                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Change                | 桌面应用的产品展示名统一为 `ZCodeLocal`                                                                                                     |
| User-visible surfaces | 应用包名、DMG/ZIP 产物名、Dock/菜单栏、关于窗口、窗口标题、启动页、登录页、侧栏、通知、强制更新页、应用内文案中的产品名                     |
| Existing docs         | `docs/desktop/zcode-preview-packaging.md`、`docs/desktop/macos-dmg-signing-notarization.md`                                                 |
| Existing code owners  | `packages/desktop/scripts/desktop-product-identity.mjs`、`packages/desktop/src/main/desktopRuntimeEnv.ts`、`packages/ui/src/i18n/locales/*` |
| Out of scope          | 协议 scheme、CLI 命令、业务数据目录、服务端组件名、ZCode Computer Use Helper 的独立 bundle 身份                                             |

## Boundary Decisions

| Boundary          | Decision                                                         | Includes                                                      | Excludes            |
| ----------------- | ---------------------------------------------------------------- | ------------------------------------------------------------- | ------------------- |
| 展示身份          | 正式版 `ZCodeLocal`，Preview 版 `ZCodeLocal Preview`             | macOS bundle、DMG/ZIP、About、窗口标题、启动页、应用内文案    | 账号、远端协议      |
| 产物命名          | `ZCodeLocal-<version>-<platform>-<arch>.<ext>`                   | macOS DMG/ZIP、Windows NSIS、Linux 包                         | 旧版本产物          |
| 系统标识          | 保留 `dev.zcode.app` / `dev.zcode.app.preview`                   | Finder workflow、CUA launcher allowlist、钥匙串与安装升级路径 | 无                  |
| Electron 运行目录 | 使用应用名，正式版为 `ZCodeLocal`                                | `userData`、single-instance 锁、Chromium 缓存                 | 业务数据目录        |
| 业务数据          | 继续使用 `${ZCODE_HOME:-$HOME/.zcode}`                           | 任务、设置、凭据                                              | Electron `userData` |
| 协议与 CLI        | 保留 `zcode://` 与 `zcode` 命令                                  | OAuth、深链、远程连接、Agent 运行时                           | 用户可见应用名      |
| 组件名            | `ZCode Agent`、`ZCode Server`、`ZCode Computer Use` 保留内部身份 | MCP、远端 server、CUA Helper                                  | 桌面应用自身名称    |

## 验收

1. macOS 产物为 `ZCodeLocal-<version>-mac-<arch>.dmg` 与 `.zip`，包内 app 为 `ZCodeLocal.app`。
2. Dock、菜单栏、About、主窗口标题、启动页、登录页和侧栏展示 `ZCodeLocal`。
3. 应用内产品名文案使用 `ZCodeLocal`；`zcode://`、`~/.zcode`、`zcode` CLI 与远端协议保持不变。
4. `pnpm typecheck` 与 `pnpm lint` 通过。
