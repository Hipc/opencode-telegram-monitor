# Round 1 跨模块拆分契约（split-contracts）

> 状态: frozen（Round 1 doc-prep 冻结，提交于 main）
> 创建: 2026-09-02
> 关联计划: docs/todos/split-monitor-into-modules.md（Round 1，phase 1.1–1.9）
> 基线: `main` @ `674c74c2e9a4ed96f967d23743f795b860660c94`
> 适用范围: 本文件是 Round 1 全部并行 phase 的 **import/导出/签名 唯一事实来源**。
> 任何 phase 对符号名、路径、签名的改动必须先改本文件（由 doc-prep 在下一轮处理），
> 并行工人不得自行发明与本文件冲突的接口。

## 0. 总则（所有 phase 必须遵守）

1. **行为不变优先**：拆分是纯机械平移 + 参数化。除本文件 §2/§3 明确列出的签名替换外，
   函数体、字符串输出、正则、脱敏逻辑 **逐字节保留**。SharedFileStore 与传输层死代码
   按现状平移，不接线、不删除、不"顺手优化"。
2. **导入路径**：所有跨模块 import 一律用本文件冻结的路径与导出名。禁止 `import *` 之后
   重命名再转发（除非本文件允许）；禁止创建本文件未声明的导出。
3. **类型与值分离**：`src/types.ts` 全部为 `export type`；常量模块全部为 `export const`。
4. **日志**：被拆出的模块保留原调用方式——传输层全部走 `dline`（已核实原实现
   monitor.ts:2458/2466/2488/2510/2519/2527/2549/2583），**不是** client.app.log。
5. **命名**：Telegram 协议类型**不重命名**（保留 `TelegramCallbackQuery` 等原名），
   与现有代码事实一致；本文件简写（CallbackQuery 等）仅为行文简称。
6. **类型自引用解耦**：凡原签名含 `ReturnType<TelegramSessionMonitor[...]>` 的地方，
   一律改用本文件 §2.3 冻结的独立类型（TodoCounts / TokensSummary / SessionDisplayState）。
7. 每个 phase 只允许在自己触碰范围内新建/修改文件（见计划文件各 phase 触碰范围）。

---

## 1. 目标目录结构（Round 1 完成后）

```
monitor.ts                        ← 构建产物（bundle 输出；git rm --cached 后由 .gitignore 忽略，1.9 加 /monitor.ts）
src/
  version.ts                      ← 版本/self-update 常量（含 PLUGIN_VERSION 字面量）
  constants.ts                    ← 路径/时间/限额/菜单/命令/ICON 常量
  types.ts                        ← 全部共享类型（含新增独立类型）
  diagnostics.ts                  ← dline（OTG_DIR/DIAG_PATH 自 constants import）
  monitor.ts                      ← TelegramSessionMonitor 主类（命名导出），保留成员见 §2.10
  index.ts                        ← 插件入口 default export + TelegramSessionMonitor 再导出
  config/load-config.ts           ← loadConfig / isMissingFile / writeInitializationError
  registry/index.ts               ← RegistryEntry/ProjectRegistry/纯函数族/ProjectRegistryStore（单文件）
  telegram/
    api-error.ts                  ← TelegramApiError
    client.ts                     ← TransportContext + parseProxy + telegramWithRetry/telegramRequest/
                                     requestDirect/requestViaProxy/openTunnel
    types.ts                      ← 自 ../types re-export Telegram 协议类型（转口文件）
    index.ts                      ← barrel（export * 三文件）
  format/
    coerce.ts                     ← record/string/number/rememberBounded/status/summarizeError/errorCategory
    redact.ts                     ← RedactionContext + safeText/safePath/safeToolTarget/safeProgress
    html.ts                       ← escapeHtml/paragraph/fieldRow/fieldTable/titleLine
    format.ts                     ← FormatContext + 其余格式化函数（见 §2.8）
    index.ts                      ← barrel（export * 四文件）
  infra/
    delay.ts                      ← delay
    poller-lock.ts                ← LockInfo + PollerLock
    shared-file-store.ts          ← SharedFileStoreOptions + SharedFileStore
scripts/
  build.mjs                       ← 1.9 新建：bundle src/index.ts → 根 monitor.ts（不 minify）
  set-version.mjs                 ← 1.9 改：monitor.ts → src/version.ts（正则不变）
  check-version.mjs               ← 1.9 改：monitor.ts → src/version.ts（正则不变）
tests/behavior.test.mjs           ← 1.7 新建：行为验证（stub enqueueMessage 喂事件）
docs/                             ← 设计文档（本轮起纳入 git 跟踪，见 .gitignore 变更）
.worktrees/                       ← 并行 phase worktree 目录（gitignore）
```

---

## 2. 文件与导出清单（**所有 phase 的 import 依据**）

> 每个条目格式：`导出名（原名/来源行号）— 签名 — 提供 phase / 消费 phase`。
> 「来源」指拆分前 monitor.ts 中的定义位置；平移时**值/行为不变**，仅签名按契约调整。

### 2.1 src/version.ts（Phase 1.1 新建；1.9 的 scripts、1.8 的入口消费）

| 导出 | 来源 | 签名/值 |
|---|---|---|
| `SERVICE` | 260 | `const SERVICE = "telegram-session-monitor";` |
| `TARGET_OPENCODE_VERSION` | 261 | `const TARGET_OPENCODE_VERSION = "1.18.23";` |
| `PLUGIN_VERSION` | 265 | **`export const PLUGIN_VERSION = "0.5.3";`** —— 必须保持 `const PLUGIN_VERSION = "0.5.3";` 这个字面子串形态（scripts 未锚定正则 `/const PLUGIN_VERSION = "[^"]+";/` 与 self-update 字面量断言均依赖它；`export ` 前缀不破坏子串匹配，允许） |
| `NPM_PACKAGE_NAME` | 271 | `= "opencode-telegram-monitor";` |
| `NPM_REGISTRY_BASE` | 272 | `= "https://registry.npmjs.org";` |
| `SELF_UPDATE_FETCH_TIMEOUT_MS` | 273 | `= 10_000;` |
| `OPENCODE_CACHE_MARKERS` | 276 | `= [".cache/opencode", ".cache\\opencode"];` |

- 注释随迁；其中 :263 的过期注释 `scripts/publish-version.mjs` **修正为 `scripts/set-version.mjs`**（1.1 任务已有）。
- 提供：1.1。消费：1.3（SERVICE）、1.5 不重要、1.8（主类/入口）、1.9（scripts 改读此文件）。

### 2.2 src/constants.ts（Phase 1.1 新建；全部后续模块消费）

| 导出 | 来源 | 值（不许改） |
|---|---|---|
| `OTG_DIR` | 30 | `join(homedir(), ".otg")` |
| `DIAG_PATH` | 31 | `join(OTG_DIR, "tgdiag.log")` |
| `DEFAULT_TTL_MS` | 46 | `60_000` |
| `IDLE_DEBOUNCE_MS` | 277 | `5_000` |
| `WAITING_NOTIFY_DEBOUNCE_MS` | 278 | `1_000` |
| `TELEGRAM_POLL_SECONDS` | 279 | `25` |
| `TELEGRAM_POLL_TIMEOUT_MS` | 280 | `35_000` |
| `TELEGRAM_SEND_TIMEOUT_MS` | 281 | `15_000` |
| `TELEGRAM_SEND_ATTEMPTS` | 282 | `3` |
| `TELEGRAM_MESSAGE_LIMIT` | 283 | `3_500` |
| `MAX_EVENT_IDS` | 284 | `2_000` |
| `MENU_MAX_PROJECTS` | 285 | `20` |
| `POLLER_ACQUIRE_INTERVAL_MS` | 286 | `20_000` |
| `POLLER_LOCK_TTL_MS` | 287 | `60_000` |
| `REGISTER_INTERVAL_MS` | 288 | `5 * 60_000` |
| `PLANNED_COMMANDS` | 291-298 | `new Set(["start","sessions","use","status","todo","usage"])`（中文注释随迁） |
| `ICON_COMPLETED` .. `ICON_STATUS` | 303-317 | **全部 15 个**：COMPLETED✅ FAILED❌ CANCELLED❎ PERMISSION⚠️ QUESTION❓ RUNNING🟢 RETRYING🔁 IDLE💤 WAITING⏳ USAGE📊 TODO📋 HELP💁 SESSIONS🗂️ READY🟢 STATUS📊（注释随迁） |

- **本文件保持纯净**：无 import 其他 src 模块、无副作用（`mkdirSync(OTG_DIR)` 迁至 diagnostics.ts，见 §2.4）。
- 提供：1.1。消费：1.2/1.4/1.5/1.6/1.8（dline、PollerLock、registry 重试、传输重试、formatter、主类 poller.lock 路径等）。

### 2.3 src/types.ts（Phase 1.1 新建；全部后续模块消费；全部 `export type`）

自 monitor.ts 原样迁移（321-439 等）：

| 类型 | 来源 |
|---|---|
| `LogLevel` | 321 |
| `SessionState` | 322 |
| `SessionOutcome` | 323 |
| `ToolState` | 324 |
| `WaitingType` | 325 |
| `TelegramConfig` | 327-331 |
| `ProxySpec` | 333-338 |
| `TokenTotals` | 340-348 |
| `ErrorSummary` | 350-354 |
| `WaitingProjection` | 356-361 |
| `ToolProjection` | 363-372 |
| `SessionProjection` | 374-394（引用 SDK `Session`/`Todo`/`AssistantMessage`，type-only import 自 `@opencode-ai/sdk`） |
| `RuntimeEvent` | 396-400 |
| `TelegramCallbackQuery` | 402-410 |
| `TelegramInlineButton` | 412 |
| `TelegramInlineKeyboard` | 413 |
| `TelegramUpdate` | 415-429 |
| `TelegramEnvelope<T>` | 431-439 |

**新增独立导出类型（解耦类自引用，供 format 模块使用）**：

```ts
export type TodoCounts = {
  inProgress: number;
  pending: number;
  completed: number;
  cancelled: number;
  total: number;
};
// 原 todoCounts()（monitor.ts:2991-2999）的返回结构，todoSummary（3001-3006）参数化用

export type TokensSummary = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  hasCost: boolean;
};
// 与 TokenTotals 同构（结构相同），语义为「会话聚合 token 汇总」；
// 用作 format.aggregateTokens 的返回类型（§2.8），避免格式层引用 TokenTotals 的投影语义。

export type SessionDisplayState =
  | "waiting"
  | "running"
  | "retrying"
  | SessionOutcome
  | "idle";
// 原 displayState()（2950-2955）返回类型展开；iconForState（2968）参数化用。
```

- `LockInfo` **不**在此文件：随 PollerLock 走 infra/poller-lock.ts（§2.5）。
- 提供：1.1。消费：1.2–1.8 全部。

### 2.4 src/diagnostics.ts（Phase 1.2 新建）

```ts
import { OTG_DIR, DIAG_PATH } from "./constants";   // 冻结：自 constants import
mkdirSync(OTG_DIR, { recursive: true });            // 原 monitor.ts:33 顶层副作用随迁至本文件顶层（dline 定义之前）
export function dline(message: string): void        // 原 35-44，函数体逐字节保留
```

- 决策：`mkdirSync(OTG_DIR, { recursive: true })` 迁到 diagnostics.ts（任何会 dline 的模块都 import diagnostics，目录必然先被创建；constants.ts 保持纯）。
- 提供：1.2。消费：1.5（传输层）、1.8（主类）。

### 2.5 src/infra/（Phase 1.2 新建）

**src/infra/delay.ts**
```ts
export const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));  // 原 181，逐字节保留
```

**src/infra/poller-lock.ts**
- `export type LockInfo`（原 48-53）+ `export class PollerLock`（原 55-174）**整类逐字节平移**。
- import：`DEFAULT_TTL_MS` 自 `../constants`；`node:fs/promises` 的 `open/readFile/rm/stat/utimes`；`node:os` 的 `hostname`；`node:crypto` 的 `randomUUID`；`node:path` 的 `dirname`。
- **不 import delay / dline**（原实现未使用；纠正计划文件旧表述）。

**src/infra/shared-file-store.ts**
- `export type SharedFileStoreOptions`（原 183-187）+ `export class SharedFileStore<T>`（原 189-248）整类逐字节平移（dead code，不接线）。
- import：`PollerLock` 自 `./poller-lock`；`delay` 自 `./delay`；`node:fs/promises` 的 `readFile/writeFile/rename`。
- 提供：1.2。消费：1.8（主类 new PollerLock(poller.lock) 用 infra/poller-lock；SharedFileStore 本轮无人消费，保持 dead）。

### 2.6 src/config/load-config.ts（Phase 1.3 新建）

| 导出 | 来源 | 签名 |
|---|---|---|
| `loadConfig` | 3490-3537 | `async function loadConfig(configPath: string): Promise<TelegramConfig \| undefined>` —— 校验正则、错误消息逐字节保留；`TelegramConfig` 自 `../types` import（冻结） |
| `isMissingFile` | 3539-3545 | `function isMissingFile(error: unknown): boolean` |
| `writeInitializationError` | 3547-3562 | `async function writeInitializationError(client: PluginInput["client"], message: string): Promise<void>` —— `SERVICE` 自 `../version` import |

- 提供：1.3。消费：1.8（index.ts 入口）。

### 2.7 src/registry/index.ts（Phase 1.4 新建；**单文件**，冻结）

全部 `src/registry/index.ts` 内，`export` 直出（消费者 `import { ... } from "../registry"`）：

| 导出 | 来源 | 说明 |
|---|---|---|
| `type RegistryEntry` | 3220-3224 | |
| `type ProjectRegistry` | 3226-3228 | |
| `EMPTY_REGISTRY` | 3230 | `const` |
| `normalizeRegistryPath` | 3232-3235 | |
| `parseRegistry` | 3237-3267 | |
| `serializeRegistry` | 3269-3271 | |
| `findRegistryEntry` | 3273-3281 | |
| `registerProject` | 3283-3298 | |
| `entryToken` | 3300-3307 | JSDoc 随迁 |
| `findEntryByToken` | 3309-3314 | |
| `setProjectEnabled` | 3316-3333 | JSDoc 随迁 |
| `deleteProjectByPath` | 3335-3349 | JSDoc 随迁 |
| `class ProjectRegistryStore` | 3351-3488 | 拆分轮逐字节平移；2026-09-02 Round 1 起 mutate 内嵌 PollerLock 写入锁（CAS×3 移除），类契约以 docs/modules/projects-registry.md 为准 |

- import：`node:path` 的 `resolve/dirname`、`node:fs/promises` 的 `stat/readFile/writeFile/rename/rm/mkdir/copyFile`、`node:crypto` 的 `createHash`。拆分轮无 src 内部依赖；2026-09-02 Round 1 起 ProjectRegistryStore 新增 `../infra/poller-lock`（依赖方向仍符合 directory-layout 的 infra→registry 序），见 projects-registry.md §3。
- 提供：1.4。消费：1.6（buildMenuKeyboard 用 entryToken）、1.7（测试构造 ProjectRegistryStore）、1.8（主类构造参数类型、入口 new ProjectRegistryStore）。

### 2.8 src/format/（Phase 1.6 新建；四文件 + barrel）

**src/format/coerce.ts**

| 导出 | 来源 | 签名 |
|---|---|---|
| `record` | 3158-3162 | `function record(value: unknown): Record<string, unknown> \| undefined` |
| `string` | 3164-3166 | `function string(value: unknown): string \| undefined` |
| `number` | 3168-3172 | `function number(value: unknown): number \| undefined` |
| `rememberBounded` | 3144-3149 | `function rememberBounded(set: Set<string>, value: string): void`（`MAX_EVENT_IDS` 自 `../constants` import） |
| `status` | 3106-3120 | `function status(value: unknown, ctx: RedactionContext): SessionStatus \| undefined`（SDK `SessionStatus`） |
| `summarizeError` | 2916-2940 | `function summarizeError(value: unknown, ctx: RedactionContext): ErrorSummary` |
| `errorCategory` | 3174-3180 | `function errorCategory(error: unknown, ctx: RedactionContext): string`（`instanceof TelegramApiError` 分支保留，自 `../telegram/api-error` import） |

> 指派决策：原计划 A/B 档提到的 record/string/number/rememberBounded/errorCategory 归入 format/coerce.ts；
> summarizeError/status 同类纯函数一并归入（原计划未显式列，属本轮 doc-prep 指派，避免含糊）。

**src/format/redact.ts**

```ts
export type RedactionContext = { root: string; botToken: string };

export function safeText(value: string, limit: number, ctx: RedactionContext): string;      // 2834-2874，脱敏链逐字节保留；this.config.botToken→ctx.botToken、this.root→ctx.root
export function safePath(value: string, ctx: RedactionContext): string;                     // 2818-2832，this.root→ctx.root
export function safeToolTarget(tool: string, input: Record<string, unknown> | undefined, ctx: RedactionContext): string | undefined;  // 2752-2779
export function safeProgress(structured: Record<string, unknown> | undefined, content: unknown, ctx: RedactionContext): string | undefined;  // 2781-2816
```
- 内部调用（this.string/this.number/this.record/this.safeText/this.safePath）改为模块内直接调用。

**src/format/html.ts**

| 导出 | 来源 | 签名 |
|---|---|---|
| `escapeHtml` | 2876-2881 | `function escapeHtml(value: string): string` |
| `paragraph` | 2912-2914 | `function paragraph(text: string): string` |
| `fieldRow` | 2896-2898 | `function fieldRow(label: string, value: string): string` |
| `fieldTable` | 2889-2891 | `function fieldTable(rows: string[]): string` |
| `titleLine` | 2905-2907 | `function titleLine(icon: string, projectLabel: string): string`（**projectLabel 显式参数**，冻结） |

**src/format/format.ts**

```ts
export type FormatContext = RedactionContext & {
  projectLabel: string;
  sessions: Map<string, SessionProjection>;
  sessionInfo: Map<string, Session>;   // SDK Session
};
```

| 导出 | 来源 | 签名（冻结） |
|---|---|---|
| `formatNumber` | 3030-3034 | `(value: number): string` |
| `formatCost` | 3036-3041 | `(tokens: TokenTotals): string` |
| `formatDuration` | 3043-3051 | `(milliseconds: number): string` |
| `shortID` | 3053-3058 | `(sessionID: string): string` |
| `matchesSessionID` | 3060-3071 | `(sessionID: string, candidate: string): boolean` |
| `limitMessage` | 3073-3104 | `(text: string): string`（`TELEGRAM_MESSAGE_LIMIT` 自 `../constants`） |
| `todoCounts` | 2991-2999 | `(todos: Todo[]): TodoCounts` |
| `todoSummary` | 3001-3006 | `(counts: TodoCounts): string` |
| `totalTokens` | 3008-3016 | `(tokens: TokenTotals): number` |
| `emptyTokens` | 3018-3028 | `(): TokenTotals` |
| `displayState` | 2950-2955 | `(session: SessionProjection): SessionDisplayState` |
| `sessionTitle` | 2946-2948 | `(session: SessionProjection, ctx: RedactionContext): string` |
| `sessionLabel` | 2942-2944 | `(session: SessionProjection, ctx: RedactionContext): string` |
| `iconForOutcome` | 2957-2966 | `(outcome: SessionOutcome): string`（ICON_* 自 `../constants`） |
| `iconForState` | 2968-2985 | `(state: SessionDisplayState): string`（**类型自引用已解耦**） |
| `iconForWaitingType` | 2987-2989 | `(type: WaitingType): string` |
| `childSessions` | 2725-2736 | `(parentID: string, sessions: Map<string, SessionProjection>, sessionInfo: Map<string, Session>): SessionProjection[]`（**两 Map 显式参数**，冻结） |
| `aggregateTokens` | 2738-2750 | `(session: SessionProjection, ctx: FormatContext): TokensSummary`（内部调 childSessions(session.sessionID, ctx.sessions, ctx.sessionInfo)；返回类型用 TokensSummary，冻结） |
| `menuText` | 1941-1970 | `(): string`（无 ctx 需求；文字仅标题「项目监控列表」，项目列表由 buildMenuKeyboard 按钮承载） |
| `buildMenuKeyboard` | 1972-1994 | `(registry: ProjectRegistry): TelegramInlineKeyboard`（`entryToken` 自 `../registry`；basename；`MENU_MAX_PROJECTS` 自 `../constants`） |
| `helpText` | 2297-2323 | `(): string`（无 ctx 需求） |
| `formatStatus` | 2105-2160 | `(session: SessionProjection, ctx: FormatContext): string` |
| `formatTerminalNotification` | 2162-2228 | `(session: SessionProjection, outcome: SessionOutcome, error: ErrorSummary \| undefined, ctx: FormatContext): string` |
| `formatTodos` | 2230-2278 | `(session: SessionProjection, ctx: FormatContext): string` |
| `formatUsage` | 2280-2295 | `(session: SessionProjection, ctx: FormatContext): string` |

- 内部 this.xxx() 调用全部改为模块内直接调用（safeText/safePath/escapeHtml/paragraph/…）。
- 输出字符串拼接 **逐字节不变**；仅签名与 this 引用替换。

**src/format/index.ts**（barrel）
```ts
export * from "./coerce";
export * from "./redact";
export * from "./html";
export * from "./format";
```
- 消费者统一 `import { ... } from "../format"`（或 `../format/index`，等价）。
- 提供：1.6。消费：1.5 不依赖；1.8（主类大量使用）；1.7 间接。

### 2.9 src/telegram/（Phase 1.5 新建；三文件 + barrel）

**src/telegram/api-error.ts**
```ts
export class TelegramApiError extends Error {          // 原 441-450 逐字节
  constructor(message: string, readonly errorCode?: number, readonly retryAfter?: number) { super(message); this.name = "TelegramApiError"; }
}
```

**src/telegram/types.ts**（转口，冻结）
```ts
export type { TelegramConfig, ProxySpec, TelegramCallbackQuery, TelegramInlineButton, TelegramInlineKeyboard, TelegramUpdate, TelegramEnvelope } from "../types";
```

**src/telegram/client.ts**（传输层参数化契约，**§3 全文适用**）

```ts
import { TELEGRAM_SEND_ATTEMPTS, TELEGRAM_SEND_TIMEOUT_MS } from "../constants";
import { dline } from "../diagnostics";
import { delay } from "../infra/delay";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect, type Socket } from "node:tls";   // tls 仅 requestViaProxy/openTunnel 使用
import type { TelegramConfig, ProxySpec, TelegramEnvelope } from "./types";
import { TelegramApiError } from "./api-error";

export type TransportContext = { config: TelegramConfig; signal: AbortSignal };

export function parseProxy(value: string): ProxySpec;                                    // 2610-2623，逐字节
export async function telegramWithRetry<T>(method: string, body: Record<string, unknown>, ctx: TransportContext): Promise<T>;   // 2364-2392
export async function telegramRequest<T>(method: string, body: Record<string, unknown>, timeoutMs: number, ctx: TransportContext): Promise<T>;  // 2394-2422
export async function requestDirect<T>(url: string, body: Record<string, unknown>, signal: AbortSignal): Promise<T>;            // 2424-2444
export async function requestViaProxy<T>(url: string, body: Record<string, unknown>, signal: AbortSignal, timeoutMs: number, proxy: string): Promise<T>;  // 2446-2608
export async function openTunnel(proxy: ProxySpec, targetHost: string, targetPort: number, signal: AbortSignal, timeoutMs: number): Promise<Socket>;      // 2625-2708
```

**src/telegram/index.ts**（barrel）
```ts
export * from "./api-error";
export * from "./client";
export * from "./types";
```

- 提供：1.5。消费：1.8（主类 sendMessage 链、errorCategory instanceof 分支）。

### 2.10 src/monitor.ts（Phase 1.8 新建）

```ts
export class TelegramSessionMonitor { ... }     // 命名导出（tests 契约：import { TelegramSessionMonitor } from "../src/monitor.ts"）
```

- 平移范围：原 452-3218 主类体。**保留成员**（冻结，不得再拆）：
  - `constructor(client: PluginInput["client"], config: TelegramConfig, root: string, registry: ProjectRegistryStore)`（480-488，签名不变）
  - `initialize()`（490-501）
  - `accept(event: unknown)`（733）
  - `dispose()`、`track()`、`log()`（3182-3218）
  - handleEvent 链 + 实例状态投影：`applyStatus`/`rememberEvent`/`parseRuntimeEvent`/`session`/`isTodo`（1256-1290/3137-3156/3122-3127/3129-3135/3151-3156）
  - 轮询与选举：`runTelegram` 链、`handleCommand`/`handleCallback`（1996+）、选 session 辅助（2095-2103）
  - 发送队列：`enqueueMessage(text)`（2325）/`enqueueMessageWithKeyboard`（2332）/`sendMessage`（2344）/`sendMessageWithKeyboard`（2352-2362）
  - 通知去抖：`scheduleWaitingNotify` 系列（timers）+ seen 集合去重
  - self-update 五/六方法：`scheduleSelfUpdate`/`runSelfUpdate`/`fetchNpmLatestVersion`/`applyVersionUpdate`/`downloadAndExtract`/`extractTar`（511-719，**§4 适用**）
- **删除并改 import**（成员 → 模块函数调用）：
  - `delay`(181)/PollerLock(55-174)/SharedFileStore(189-248) → `../infra/*`；LockInfo 类型引用随之
  - `dline` → `../diagnostics`
  - 全部 format 函数（§2.8 清单）→ `../format`；`this.sessionTitle(s)/sessionLabel(s)` 等调用补 ctx 参数
  - 传输层：`telegramWithRetry/telegramRequest/requestDirect/requestViaProxy/openTunnel/parseProxy` → `../telegram`；`this.sleep()` retry 背压= `delay`（见 §3.1）
  - registry 纯函数族/ProjectRegistryStore 类型 → `../registry`
  - 常量 → `../constants`；类型 → `../types`——**例外**：`join(homedir(), ".otg", "poller.lock")`（472-473）改写为 `join(OTG_DIR, "poller.lock")`（值等价，冻结）
  - `event: unknown` 的 narrowing 用 `isTodo`/`session`/`parseRuntimeEvent` 等类内私有成员（保留）
- 模块顶层保留 `dline("MODULE LOADED");`（原 319；import 之后即可）。
- **`this.xxx()` 类内调用改模块函数时，只补参数、不动逻辑**；任何被拆函数在原类中的旧实现**删除**（不得新旧并存）。

### 2.11 src/index.ts（Phase 1.8 新建）

```ts
import type { Plugin } from "@opencode-ai/plugin";
export { TelegramSessionMonitor } from "./monitor";          // 测试契约
export default (async ({ client, directory, worktree }) => { ... }) satisfies Plugin;   // 原 3564-3611 平移
```
- 入口体引用：`OTG_DIR`/`SERVICE`（constants/version）、`loadConfig`/`writeInitializationError`（config）、`ProjectRegistryStore`/`registerProject`（registry）、`TelegramSessionMonitor`（./monitor）——路径按 §1。
- 提供：1.8。消费：1.9（build.mjs bundle 入口）、1.7（可选）。

### 2.12 tests/behavior.test.mjs（Phase 1.7 新建）

- **导入契约**：`import { TelegramSessionMonitor } from "../src/monitor.ts";`
- **构造契约**：`new TelegramSessionMonitor(client, config, root, registry)`
  - `client`：最小 fake `{ app: { log: async () => {} } }`（主类 initialize/accept 路径只用到 client.app.log；如运行中发现缺字段，在测试内补最小 stub 并注释）
  - `config`：`{ botToken: "123456789:TESTTOKEN_DO_NOT_USE_abcdefg", chatId: "123" }`（fake，绝不真发）
  - `root`：`mkdtemp` 临时目录
  - `registry`：真实 `ProjectRegistryStore`（自 `../src/registry/index.ts`）指向临时目录 `projects.json`（temp；不得触碰真实 `~/.otg`）
- **打桩契约**（构造后、喂事件前，运行时覆写实例方法，.mjs 无类型检查）：
  - `monitor.enqueueMessage = async () => { collected.push(..) }`、`monitor.enqueueMessageWithKeyboard = async () => {}`
  - `monitor.runTelegram = async () => {}`、`monitor.scheduleRegistration = () => {}`、`monitor.scheduleSelfUpdate = () => {}`（避免真实网络轮询/注册/自更新）
- **喂事件**：`monitor.accept(runtimeEvent)`，用例对齐 API-001/002/003：
  1. `permission.asked` 随即 `permission.replied` → 0 条通知（auto-approve 去抖）
  2. 仅 `permission.asked`，等 2.5s（> WAITING_NOTIFY_DEBOUNCE_MS）→ 1 条 `[WAITING]` 且含 "Permission"
  3. `question.asked` → 立即 1 条通知（不去抖）
- **运行**：`HOME=$(mktemp -d) bun tests/behavior.test.mjs`（隔离 HOME 使 `os.homedir()` 指向临时目录，避免写真实 `~/.otg/`）；未隔离运行时 dline 会追加真实 `~/.otg/tgdiag.log`，可接受但测试不得依赖。
- **`--dry` 模式**：`bun tests/behavior.test.mjs --dry` 只做「语法/依赖可载入」检查：`src/monitor.ts` 尚不存在（前序 phase 未合并）时打印说明并 `exit 0`；存在则完成 import + 导出断言。完整行为断言只在合并后整体测试执行。

---

## 3. 传输层参数化契约（Phase 1.5）

### 3.1 参数替换表（this → 显式参数，**唯一允许的改动**）

| 原方法 | this 引用 | 替换为 |
|---|---|---|
| `telegramWithRetry` | `this.abortController.signal` | `ctx.signal`（循环顶/异常后 abort 检查**原样保留**，2364-2392） |
| | `this.telegramRequest(...)` | `telegramRequest(method, body, TELEGRAM_SEND_TIMEOUT_MS, ctx)` |
| | `this.sleep(retryAfter ? ... : 2**(attempt-1)*1000)` | `await delay(...)`（自 `../infra/delay`；**语义说明**：delay 不感知 abort，abort 后睡眠最多再等一个背压间隔（≤8s 或 retry_after），随后循环顶 `ctx.signal.aborted` 检查抛出 "Plugin disposed"——与原型抛错点一致，仅时机略延，可接受；**不得**为省事省略循环顶 abort 检查） |
| `telegramRequest` | `this.abortController.signal` | `ctx.signal`（add/removeEventListener 两处） |
| | `this.config.botToken` / `this.config.proxy` | `ctx.config.botToken` / `ctx.config.proxy` |
| | `this.requestViaProxy` / `this.requestDirect` | 模块内调用，`signal` 传 `requestController.signal`（不变） |
| `requestDirect` | 无 this 依赖 | 签名 `(url, body, signal)`，函数体现有样子不变（2424-2444） |
| `requestViaProxy` | `this.parseProxy(this.config.proxy!)` | `parseProxy(proxy)`——`proxy: string` 显式参数（调用方保证非空） |
| | `this.openTunnel(proxy, target.hostname, targetPort, signal, timeoutMs)` | 模块内 `openTunnel(...)` 同参 |
| | `dline(...)` | import { dline }，调用点/内容不变 |
| `openTunnel` | 无 this 依赖 | 签名 `(proxy, targetHost, targetPort, signal, timeoutMs)`，函数体原样（2625-2708） |
| `parseProxy` | 无 this 依赖 | 签名 `(value: string): ProxySpec`，函数体原样（2610-2623） |

### 3.2 铁律：requestViaProxy 的 TLS socket 逐字节保留

- 2490-2494 注释（**勿改写为 http.request over CONNECT**——历史实证该做法会挂死）随代码保留；
- `tlsConnect({ socket, servername })` 直写 HTTP/1.1 请求、data/end/error/setTimeout 处理、`Connection: close`、content-length 解析、204 兜底——全部逐字节平移，**不重构、不简化**。
- 时间限额常量 `TELEGRAM_SEND_ATTEMPTS`/`TELEGRAM_SEND_TIMEOUT_MS` 自 `../constants`。

---

## 4. self-update 校验契约（Phase 1.8 主类 + 1.9 build.mjs）

1. **首选（字面量断言，保留）**：`applyVersionUpdate`（monitor.ts:611/627）的
   `staged.includes('const PLUGIN_VERSION = "${latest}"')` 与
   `fresh.includes('const PLUGIN_VERSION = "${latest}"')` **逐字保留**。
   依据：bun build（`--target node`，不 minify）会保留顶层 `export const PLUGIN_VERSION = "0.5.3";`
   为产物中的 `const PLUGIN_VERSION = "0.5.3";` 字面子串（`export` 前缀不破坏子串匹配）。
2. **实机验证点**：Phase 1.8 手工 bundle 验证必须记录结论——产物是否含 `const PLUGIN_VERSION = "0.5.3"` 字面量（API-004）。
3. **兜底（仅当实机不成立）**：改读 staging 包内 `package/package.json` 的 `version` 字段
   （`JSON.parse`），与 `latest` 比对；改动只限 `applyVersionUpdate` 校验段，并回写本契约与计划文件（由 doc-prep 下轮确认）。
4. **build.mjs 同步断言**（1.9，API-004/005 对齐）：构建后读取根 `monitor.ts` 产物，
   断言存在 `const PLUGIN_VERSION = "0.5.3"` 形态（`/const PLUGIN_VERSION = "[^"]+";/` 未锚定即可），失败 `exit 1`。
5. **scripts 正则不动**：check-version.mjs:41 / set-version.mjs:37,42 的正则 `/const PLUGIN_VERSION = "[^"]+";/`
   原样照用，仅把读取路径 `monitor.ts` → `src/version.ts`（`export const` 前缀不影响未锚定匹配）。

---

## 5. 模块边界与依赖方向（禁止循环）

```
constants.ts/version.ts/types.ts   ← 底层，零内部依赖（constants/version 可有 node:os/node:path 等 std 依赖）
diagnostics.ts                     → constants
infra/delay.ts                     → (none)
infra/poller-lock.ts               → constants
infra/shared-file-store.ts         → infra/delay, infra/poller-lock
config/load-config.ts              → types, version
registry/index.ts                  → (std only)
telegram/api-error.ts              → (none)
telegram/client.ts                 → constants, diagnostics, infra/delay, telegram/api-error, types
telegram/types.ts                  → types
format/coerce.ts                   → constants, types, telegram/api-error
format/redact.ts                   → types
format/html.ts                     → (none；escapeHtml 内部)
format/format.ts                   → constants, types, format/{redact,html,coerce}, registry
src/monitor.ts                     → 全部上述模块 + @opencode-ai/plugin, @opencode-ai/sdk
src/index.ts                       → monitor, config, registry, constants, version + @opencode-ai/plugin
tests/behavior.test.mjs            → src/monitor, src/registry
```
- **禁止**：monitor.ts 被任何 src 模块 import；index.ts 被任何 src 模块 import（除 bundle 入口）；
  format ← telegram ← format 等任何环。
- **职责边界**：format 只产字符串/键盘数据，不触网不碰 this；
  telegram 只做传输（含错误分类 TelegramApiError），不做格式化/业务；
  registry 只管 projects.json 状态机；主类保留所有带实例状态/定时器/网络编排的逻辑。

---

## 6. 并行分组（Round 1，写入计划文件，dev-lead 调度依据）

### 批次 A（可全并发，7 个 worktree）：**Phase 1.1 – 1.7**

- 判据：全部是**新建文件**，编辑区间零重叠（1.1: src/version.ts+constants.ts+types.ts；
  1.2: src/diagnostics.ts+infra/*；1.3: src/config/*；1.4: src/registry/*；1.5: src/telegram/*；
  1.6: src/format/*；1.7: tests/behavior.test.mjs）。
- **依赖说明**：A 批次各 phase 的 import 目标可能尚未落盘（如 1.5 import 1.1 的 constants），
  **按 §2 冻结的路径/导出名写 import 即可**，per-phase 语法自检遇到兄弟模块 unresolved import 属预期（计划文件已声明），不算失败。
- 分支/worktree：`phase-r1-p1.{1..7}` / `.worktrees/phase-r1-p1.{1..7}`（1.1 分支名沿用计划表）。

### 批次 B（须在 A 全合并后启动，2 个 worktree 并发）：**Phase 1.8 + 1.9**

- 1.8 依赖批次 A 全部（src/monitor.ts import 所有新模块）；1.9 依赖 1.1 的 version.ts 契约（scripts 改读 src/version.ts）与 §2 冻结的入口路径。
- **编辑区间不相交**：1.8 只碰 src/monitor.ts、src/index.ts、`git rm --cached monitor.ts`；
  1.9 只碰 scripts/build.mjs、package.json、.github/workflows/publish.yml、scripts/check-version.mjs、
  scripts/set-version.mjs、README.md、.gitignore。→ 可同批并发。
- 合并顺序：批次 A 内任意序（不相交）；批次 B 内任意序；**1.9 的 .gitignore /monitor.ts 与 1.8 的 git rm --cached 顺序无关**（tracked+ignored 不影响删除）。
- 与 dev-lead 初步分组一致，无差异。

### 批次间依赖（跨轮次）

- 整体测试（项目最终验证任务）在批次 B 合并后执行；1.7 的完整断言运行也在此刻（--dry 可在批次 A 阶段先行）。

---

## 7. 外部联动点（Phase 1.9 触碰，契约）

| 位置 | 现状（已核实） | 改法（冻结） |
|---|---|---|
| `scripts/set-version.mjs:31,37,42` | `join(root, "monitor.ts")` + `/const PLUGIN_VERSION = "[^"]+";/` | 路径改 `src/version.ts`；正则不动；注释同步 |
| `scripts/check-version.mjs:35,41` | 同上 | 同上 |
| `package.json:15-16` | check/prepublishOnly = `bun build --no-bundle --target node --external "*" monitor.ts` | 改为 `node scripts/build.mjs` |
| `package.json:6-12` | main/types=`monitor.ts`、files=[monitor.ts,LICENSE,README.md] | **不变**（CI 现场构建产物） |
| `.github/workflows/publish.yml:74` | `bun build --no-bundle --target node --external "*" monitor.ts` | 在 Verify version 步骤后改跑 `node scripts/build.mjs`（构建产物先于 check 步骤亦可，见 1.9 实现） |
| `.gitignore` | 无 /monitor.ts、无 .worktrees/ | 1.9 加 `/monitor.ts`（构建产物） |
| `README.md` L49-58（From source） | `cp monitor.ts ~/.config/opencode/plugins/...` | 改为「先 `node scripts/build.mjs` 构建出根 monitor.ts 再复制产物」 |
| `README.md` L79 表（version source of truth） | `monitor.ts` | 改为 `src/version.ts` |

---

## 8. 冻结记录

- Round 1 doc-prep 于 2026-09-02 冻结本文件，提交：`docs(round 1): freeze design docs & contracts for round 1`（SHA 见 git log）。
- 与计划文件的关系：计划文件记 phase 安排与验收；本文件记契约本体。phase 内「契约冻结时定」的待定项均已在 §2 中决议。
- 仍存在的文档风险：无（AGENTS.md 中「docs 永不提交」旧约定已被 dev-lead 本轮指示显式取代，文档已纳入跟踪；AGENTS.md 本身上一轮未跟踪、本轮不纳入提交范围，由 dev-lead 决定后续是否更新其表述）。