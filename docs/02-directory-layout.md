# 02 — 目录布局（Round 1 目标态）

> 更新: 2026-09-02。拆分完成后根 `monitor.ts` 变为**构建产物**，源码在 `src/`。
> 文件级契约（导出名/签名）以 docs/modules/split-contracts.md §1/§2 为准。

```
opencode-telegram-monitor/
├── monitor.ts                  # 构建产物：bun bundle src/index.ts → 根 monitor.ts（不 minify）
│                               # 由 .gitignore 忽略（/monitor.ts，Phase 1.9 加）；git 不再跟踪
├── src/
│   ├── version.ts              # 版本/self-update 常量（PLUGIN_VERSION 字面量在此）
│   ├── constants.ts            # OTG/DIAG 路径、时间限额、菜单限额、PLANNED_COMMANDS、15 个 ICON_*
│   ├── types.ts                # 全部共享类型（含新增 TodoCounts/TokensSummary/SessionDisplayState）
│   ├── diagnostics.ts          # dline（诊断日志；OTG_DIR mkdir 副作用在此）
│   ├── monitor.ts              # TelegramSessionMonitor 主类（命名导出；保留 handleEvent/投影/命令/
│   │                           #   轮询/发送队列/去抖/self-update/log/track）
│   ├── index.ts                # 插件入口 default export（satisfies Plugin）+ TelegramSessionMonitor 再导出
│   ├── config/
│   │   └── load-config.ts      # loadConfig + isMissingFile + writeInitializationError
│   ├── registry/
│   │   └── index.ts            # RegistryEntry/ProjectRegistry/EMPTY_REGISTRY + 纯函数族 + ProjectRegistryStore
│   ├── telegram/
│   │   ├── api-error.ts        # TelegramApiError
│   │   ├── client.ts           # TransportContext + parseProxy + telegramWithRetry/telegramRequest/
│   │   │                       #   requestDirect/requestViaProxy/openTunnel（TLS socket 逐字节保留）
│   │   ├── types.ts            # 自 ../types 转口 Telegram 协议类型
│   │   └── index.ts            # barrel
│   ├── format/
│   │   ├── coerce.ts           # record/string/number/rememberBounded/status/summarizeError/errorCategory
│   │   ├── redact.ts           # RedactionContext + safeText/safePath/safeToolTarget/safeProgress
│   │   ├── html.ts             # escapeHtml/paragraph/fieldRow/fieldTable/titleLine
│   │   ├── format.ts           # FormatContext + 其余 25 个格式化函数
│   │   └── index.ts            # barrel
│   └── infra/
│       ├── delay.ts            # delay（无 abort 感知的 setTimeout 工具）
│       ├── poller-lock.ts      # LockInfo + PollerLock
│       └── shared-file-store.ts# SharedFileStoreOptions + SharedFileStore<T>（dead，未接线）
├── scripts/
│   ├── build.mjs               # bundle src/index.ts → 根 monitor.ts + PLUGIN_VERSION 字面量断言
│   ├── set-version.mjs         # 改读 src/version.ts（正则不变）
│   └── check-version.mjs       # 改读 src/version.ts（正则不变）
├── tests/
│   └── behavior.test.mjs       # 行为验证（stub enqueueMessage 喂事件；--dry 模式）
├── docs/
│   ├── 00-overview.md
│   ├── 02-directory-layout.md
│   ├── modules/                # 模块契约（split-contracts.md 等）
│   └── todos/                  # 计划文件（split-monitor-into-modules.md、shared-file-store.md）
├── .gitignore                  # 追加 .worktrees/、/monitor.ts；移除 docs/ 忽略（本轮 pol）
├── .worktrees/                 # 并行 phase worktree（gitignore）
├── package.json                # main/types/files 指向构建产物 monitor.ts（CI 现场构建）
├── .github/workflows/publish.yml
├── README.md
└── LICENSE
```

## 依赖方向（禁止循环）

底层：`version.ts` / `constants.ts` / `types.ts`（零内部依赖）
→ `diagnostics.ts` → `infra/*` → `config/*`、`registry/*`、`telegram/*`、`format/*`
→ `src/monitor.ts` → `src/index.ts`（bundle 入口）。
`src/monitor.ts` 与 `src/index.ts` 不得被任何 src 模块 import。详见 split-contracts.md §5。

## 本地/临时

- 行为验证临时脚本放 `/tmp/opencode/`（不入库）。
- 并行 worker worktree 全部在 `.worktrees/phase-r1-p1.x/`（gitignored，不提交）。