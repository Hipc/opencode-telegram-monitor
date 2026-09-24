# 00 — 项目总览（opencode-telegram-monitor）

> 更新: 2026-09-25（opencode v2 适配轮：目标 v2.0.15，集成契约 docs/modules/opencode-v2-contract.md；
> 移除 todo 投影——v2 不可观测，用户决策 2026-09-25；此前更新见 git 历史）

## 技术栈

- **语言/运行时**：TypeScript + Bun（构建/语法冒烟）、Node >= 18（npm 发布环境，`engines` 声明）。
- **宿主**：opencode 插件（`client.event.subscribe()` 接入），目标 opencode 版本 `TARGET_OPENCODE_VERSION = "2.0.15"`。
- **SDK**：**零运行时依赖**——v2 本地 TS 插件不带 node_modules，`@opencode-ai/plugin`/`@opencode-ai/sdk`
  不再 import（类型全部本地定义于 `src/v2/types.ts`，契约见 docs/modules/opencode-v2-contract.md §4）；
  `scripts/build.mjs` 相应移除 `--external @opencode-ai/*`；bundle 仍是单文件 `monitor.ts`。
- **宿主 profile**：v2 `client` 面 = `event.subscribe` / `location` / `permission.reply|list|get` /
  `session.get|create|context`（**无** `app.log`、`session.list/messages/todo`、storage 未采用——
  自研 `~/.otg` 落盘保持），精确签名以 opencode-v2-contract.md §3 为准。
- **发布**：npm `opencode-telegram-monitor`（Trusted Publishing + provenance，`.github/workflows/publish.yml`）。
- **测试**：无测试框架；行为验证靠 `tests/behavior.test.mjs`（bun 运行，stub enqueueMessage 喂事件断言）+ `bun build` 语法冒烟 / `scripts/build.mjs` bundle 产物断言。
- **运行数据**：全部在 `~/.otg/`（telegram.json / projects.json / tgdiag.log / *.lock）。

## 是什么

只读 opencode 插件：监听 opencode 会话，把生命周期、token 用量、等待中的权限/提问等状态推送到 Telegram 机器人。**只读是刻意设计**——审批与回答永远留在 opencode 本体，插件绝不代答（回写仅由用户显式点击 TG 按钮触发）。

> **2026-09-25（v2 适配轮）**：目标 opencode **v2.0.15**；**todo 投影已移除**（用户决策：v2.0.15
> 四路验证不可观测，见 opencode-v2-contract.md §6）；v1 用户继续使用已发布 0.6.x。

> **2026-09-02 起修订（Round 2 / tg-permission-buttons）**：permission 记录支持 TG 三按钮回写
> （Allow once / Allow always / Deny）——点击后经 opencode 官方 permission reply API 应用到
> 真实 session。**仅在用户显式点击按钮时触发**；question 与其它一切审批/回答流程仍留在 opencode，
> 插件绝不擅自代答。契约见 docs/modules/sessions-relay.md §13（supersede 记录见其 §11）。

## 关键机制（改动前必读）

- **事件流（v2）**：`setup(client)` 内 `client.event.subscribe()` 长活迭代 → `monitor.accept(rawEnvelope)` → `handleEvent()` 按 `type` 分发；`permission.asked` → `addWaiting`，`permission.replied` → 取消；question 通道 = `form.created/replied/cancelled`（向导与等待记录语义保持，见 sessions-relay.md）；`session.execution.started/succeeded/failed/interrupted` 驱动会话投影与生命周期通知（turn 递增 / idle 终态 / 终态判定 completed|failed|cancelled，替代 v1 `session.status/idle/error`）；`session.step.*`/`session.tool.*` 驱动消息与工具投影；`session.usage.updated`/`session.step.ended` 提供累计 token/cost（绝对赋值）。**完整事件映射表见 docs/modules/opencode-v2-contract.md §2。**
- **权限通知去抖（勿回退）**：auto-approve 是客户端行为，服务端照样发 `permission.asked`；必须走 1 秒去抖窗口（`WAITING_NOTIFY_DEBOUNCE_MS=1000`）内收到 `permission.replied` 即取消发送；question（v2 = form）不去抖、立即发。
- **跨进程一致性**：`~/.otg/poller.lock`（`PollerLock`，O_EXCL + pidAlive/TTL + ownerId）只有锁持有者轮询 Telegram；`SharedFileStore<T>` 短临界区读改写（本轮拆分时原样平移，未接线）。
- **事件去重与内存上限**：`seenEventIDs`/`seenWaitingRequestIDs`/`terminalMessageIDs` 均为有上限集合（`MAX_EVENT_IDS=2000`，`rememberBounded` 维护）。
- **审批回写（v2）**：permission 记录发送带三按钮（Allow once/Always/Deny）；点击 → 主进程写 `reply` 字段 → 拥有该 session 的实例每秒扫描自己条目，经 v2 `client.permission.reply({sessionID, requestID, decision, message?})` 应用，成功后删除记录（Round 6 终态语义）。**绝不擅自代答**：只有显式点击才触发 reply API（契约 sessions-relay.md §13/§16 + opencode-v2-contract.md §3）。
- **自更新**：npm 缓存安装（`OPENCODE_CACHE_MARKERS`）才检查；staging + 校验 + 备份 + 原子替换 + 回滚；校验依赖产物中 `const PLUGIN_VERSION = "..."` 字面量（契约见 docs/modules/split-contracts.md §4）。
- **脱敏**：botToken 必须打码（`safeText`/dline 路径 `[REDACTED]` 等），任何日志路径不得泄漏 token 或密钥。

## 版本与发布

- 版本单一事实来源：`package.json` 的 `version` 字段（v2 轮将落定 1.0.0，06 执行；当前主线是否
  仍为 0.6.0 以此为准）；构建时经 `bun build --define` 注入 bundle 产物 `PLUGIN_VERSION`，
  契约见 docs/modules/version-injection.md（03 只改 `src/version.ts` 的
  `TARGET_OPENCODE_VERSION = "2.0.15"`，注入流程零改动）。
- 变更流程：`node scripts/set-version.mjs <v>` 写 package.json + README pin →
  `node scripts/check-version.mjs v<v>` 校验（package.json + README）→ 打 tag →
  publish.yml 构建（注入）+ 发布。
- .github pre-push hook 校验 tag 与 version 一致。

## 本轮（Round 1）目标

把 3611 行单文件 `monitor.ts` 拆为 `src/` 多文件 + bun bundle 打包回根 `monitor.ts` 构建产物。
对外机制（npm 发布、本地单文件复制安装、自更新）完全不变；主类 `TelegramSessionMonitor` 保留，纯函数/独立类全部拆出。
详细计划见 `docs/todos/split-monitor-into-modules.md`，跨 phase 契约见 `docs/modules/split-contracts.md`。

> 当前进行中：**opencode v2 适配轮**（目标 v2.0.15；探针证据 `tools/v2-probe/FINDINGS.md`；
> 集成契约 `docs/modules/opencode-v2-contract.md`；tickets `.scratch/opencode-v2-adaptation/issues/`）。
> v2 下 **todo 投影已移除**（不可观测，用户决策），README/本文件不再宣称 Todo projection。

## Git 约定

- commit 信息一律英文，Conventional Commits（`feat/fix/refactor/docs/test/chore/perf/style/build/ci`）。
- 本轮起 `docs/` 纳入 git 跟踪（由 dev-lead 的 swarm 工作流驱动，取代旧「docs 永不提交」约定，AGENTS.md 表述待后续更新）。
- `AGENTS.md`、`.gitignore` 自忽略条目保留（本地自用文件不随仓库发布语义变化）。