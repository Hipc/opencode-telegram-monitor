# 00 — 项目总览（opencode-telegram-monitor）

> 更新: 2026-09-02（Round 1 拆分启动，docs 纳入 git 跟踪；Round 2 起支持 TG 审批回写）

## 技术栈

- **语言/运行时**：TypeScript + Bun（构建/语法冒烟）、Node >= 18（npm 发布环境，`engines` 声明）。
- **宿主**：opencode 插件（`event` hook 接入），目标 opencode 版本 `TARGET_OPENCODE_VERSION = "1.18.23"`。
- **SDK**：`@opencode-ai/plugin`（Plugin/PluginInput）、`@opencode-ai/sdk`（Session/Todo/AssistantMessage 等类型）——均为 peerDependencies，bundle 时 external。
- **发布**：npm `opencode-telegram-monitor`（Trusted Publishing + provenance，`.github/workflows/publish.yml`）。
- **测试**：无测试框架；行为验证靠 `tests/behavior.test.mjs`（bun 运行，stub enqueueMessage 喂事件断言）+ `bun build` 语法冒烟 / `scripts/build.mjs` bundle 产物断言。
- **运行数据**：全部在 `~/.otg/`（telegram.json / projects.json / tgdiag.log / *.lock）。

## 是什么

只读 opencode 插件：监听 opencode 会话，把生命周期、token 用量、todo、等待中的权限/提问等状态推送到 Telegram 机器人。**只读是刻意设计**——审批与回答永远留在 opencode 本体，插件绝不代答（`monitor.ts` 中无任何 permission.reply/question 代答路径）。

> **2026-09-02 起修订（Round 2 / tg-permission-buttons）**：permission 记录支持 TG 三按钮回写
> （Allow once / Allow always / Deny）——点击后经 opencode 官方 permission reply API 应用到
> 真实 session。**仅在用户显式点击按钮时触发**；question 与其它一切审批/回答流程仍留在 opencode，
> 插件绝不擅自代答。契约见 docs/modules/sessions-relay.md §13（supersede 记录见其 §11）。

## 关键机制（改动前必读）

- **事件流**：`accept(event)` → `handleEvent()` 按 `event.type` 分发；`permission.asked/v2`、`question.asked/v2` → `addWaiting`；`permission.replied/v2`、`question.*.replied/rejected` → 取消 waiting 通知；`session.*`/`message.*`/`tool` 事件驱动会话投影与生命周期通知（finalizeIdle/commitIdleOutcome）。
- **权限通知去抖（勿回退）**：auto-approve 是客户端行为，服务端照样发 `permission.asked`；必须走 2 秒去抖窗口（`WAITING_NOTIFY_DEBOUNCE_MS=1000`）内收到 `permission.replied` 即取消发送；question 不去抖、立即发。
- **跨进程一致性**：`~/.otg/poller.lock`（`PollerLock`，O_EXCL + pidAlive/TTL + ownerId）只有锁持有者轮询 Telegram；`SharedFileStore<T>` 短临界区读改写（本轮拆分时原样平移，未接线）。
- **事件去重与内存上限**：`seenEventIDs`/`seenWaitingRequestIDs`/`terminalMessageIDs` 均为有上限集合（`MAX_EVENT_IDS=2000`，`rememberBounded` 维护）。
- **审批回写（2026-09-02+，Round 2）**：permission 记录发送带三按钮（Allow once/Always/Deny）；点击 → 主进程写 `reply` 字段 → 拥有该 session 的实例每秒扫描自己条目，经官方 permission reply API 应用，成功后置 `resolved=true`。resolved 双路径并存（事件回写保留）。question 本轮无按钮。**绝不擅自代答**：只有显式点击才触发 reply API（契约 sessions-relay.md §13）。
- **自更新**：npm 缓存安装（`OPENCODE_CACHE_MARKERS`）才检查；staging + 校验 + 备份 + 原子替换 + 回滚；校验依赖产物中 `const PLUGIN_VERSION = "..."` 字面量（契约见 docs/modules/split-contracts.md §4）。
- **脱敏**：botToken 必须打码（`safeText`/dline 路径 `[REDACTED]` 等），任何日志路径不得泄漏 token 或密钥。

## 版本与发布

- 版本单一事实来源：`package.json` 的 `version` 字段（当前 0.5.3，本轮从
  `src/version.ts` 迁移中——构建时经 `bun build --define` 注入 bundle 产物，
  契约见 docs/modules/version-injection.md）。
- 变更流程：`node scripts/set-version.mjs <v>` 写 package.json + README pin →
  `node scripts/check-version.mjs v<v>` 校验（package.json + README）→ 打 tag →
  publish.yml 构建（注入）+ 发布。
- .github pre-push hook 校验 tag 与 version 一致。

## 本轮（Round 1）目标

把 3611 行单文件 `monitor.ts` 拆为 `src/` 多文件 + bun bundle 打包回根 `monitor.ts` 构建产物。
对外机制（npm 发布、本地单文件复制安装、自更新）完全不变；主类 `TelegramSessionMonitor` 保留，纯函数/独立类全部拆出。
详细计划见 `docs/todos/split-monitor-into-modules.md`，跨 phase 契约见 `docs/modules/split-contracts.md`。

> 拆分轮已完成并合并；版本单源迁移轮已完成（package.json 唯一来源 + 构建时注入，
> 契约见 `docs/modules/version-injection.md`）；sessions 中继轮已完成（计划
> `docs/todos/sessions-tg-relay.md`，契约 `docs/modules/sessions-relay.md`）。
> 当前进行中：**TG 审批按钮 + 回写应用闭环**（计划 `docs/todos/tg-permission-buttons.md`，
> 契约 `docs/modules/sessions-relay.md` §13）。

## Git 约定

- commit 信息一律英文，Conventional Commits（`feat/fix/refactor/docs/test/chore/perf/style/build/ci`）。
- 本轮起 `docs/` 纳入 git 跟踪（由 dev-lead 的 swarm 工作流驱动，取代旧「docs 永不提交」约定，AGENTS.md 表述待后续更新）。
- `AGENTS.md`、`.gitignore` 自忽略条目保留（本地自用文件不随仓库发布语义变化）。