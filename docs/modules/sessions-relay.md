# sessions-relay 模块契约（等待状态落盘 + poller 扫描中继）

> 冻结: 2026-09-02（Round 1 / sessions-tg-relay；**Round 2 / tg-permission-buttons 扩展见 §13**；
> Round 2.1 / 结构化渲染修订见 §13.11；**Round 3 / 单表渲染修订见 §13.12**；
> Round 4 / question 向导见 §14；**Round 5 / 富文本编辑统一见 §15**）
> 文件: `src/registry/index.ts`（记录类型与纯函数）、
> `src/monitor.ts`（写入端 Phase 1.2 / 扫描端 Phase 1.3）、`src/constants.ts`（扫描间隔常量，仅 Phase 1.3）
> 计划: docs/todos/sessions-tg-relay.md（Round 1）、docs/todos/tg-permission-buttons.md（Round 2）、
> docs/todos/question-tg-wizard.md（Round 4）、docs/todos/telegram-rich-message-edit.md（Round 5）
> 关联: docs/modules/projects-registry.md（`mutate()` 锁语义只消费不修改，§3/§4 零触碰）
> 本文件是 sessions 落盘 → Telegram 中继的**唯一权威契约**；与 projects-registry.md §2.1
> 「纯函数区零改动」冲突处，以本文件 §3/§4 为准（projects-registry.md §10 记录差异）。

## 1. 模块职责与动机

现状：permission/question 等待通知由 monitor 在事件回调里直接经
`notifyWaiting → enqueueMessage → sendMessage` 发送（permission 有 1s 去抖防
auto-approve 刷屏）。问题：直发依赖事件发生时机与单实例本地状态。

目标：把等待状态**落盘**到 `~/.otg/projects.json` 对应项目条目的 `sessions` 数组，
由持有 `poller.lock` 的主进程**每秒扫描**该项目文件，把 `send=false && resolved=false`
的记录推送到 Telegram，发送成功置 `send=true`；`resolved` 由 opencode 回复事件驱动
回写。旧直发机制 `notifyWaiting` **保留源码、停用调用**（后续可能复用）。

两条路径的分工（本轮核心边界）：

- **写入端（Phase 1.2）**：事件 → 计算记录 → `registry.mutate(appendSessionRecord / markSessionResolved)`。
  **只写盘、绝不发送**。
- **扫描端（Phase 1.3）**：poller.lock 持有者 → `registry.read()`（不加锁）→ 筛选 →
  调用现有发送链 → `registry.mutate(markSessionSent)`。**只读盘、发送与置位；不写任何
  waiting 逻辑、不触碰 addWaiting/去抖/回写**。

## 2. `SessionRecord` 类型契约（Phase 1.1 新建，冻结）

定义位置：`src/registry/index.ts` 类型区（`RegistryEntry` 下方，现 14-18 附近）。

```ts
export type SessionRecord = {
  session_id: string;   // opencode sessionID（事件 properties.sessionID）
  session_name: string; // 展示名：ensureSessionInfo 拉取 info.title；拉不到兜底 sessionID（决策 #7）
  type: "question" | "permission"; // 与 src/types.ts WaitingType 同构（字面量内联，不强依赖 import）
  message: string;      // 完整事件 payload 的 JSON 字符串（决策 #2，见 §4.2）
  send: boolean;        // 初始 false；poller 发送成功置 true（决策 #8）
  resolved: boolean;    // 初始 false；replied/rejected 置 true；终态（决策 #5/#6）
  request_id: string;   // 内部匹配键：asked 事件 properties.id；replied 匹配键见 §5.3
  created_at: string;   // ISO 8601 字符串（new Date().toISOString()），本轮仅预留不消费（决策 #13）
};
```

逐字段语义（冻结）：

| 字段 | 提供方 | 写入值 | 消费方 |
|---|---|---|---|
| `session_id` | 1.2（事件） | `properties.sessionID` 原样 | 1.3（格式展示 shortID） |
| `session_name` | 1.2 | `(await ensureSessionInfo(id))?.info?.title ?? sessionID`，经 `safeText(…, 100, ctx)`；不阻塞写入，拉取失败立即兜底（决策 #7） | 1.3（格式展示） |
| `type` | 1.2 | `"permission"` / `"question"` 字面量 | 1.3（图标 ⚠️/❓） |
| `message` | 1.2 | `JSON.stringify(properties)`（完整事件 payload，见 §4.2） | 1.3（内容节选展示） |
| `send` | 1.2 初始 / 1.3 置位 | 初始 `false`；成功发送后 `true` | 1.3（筛选条件） |
| `resolved` | 1.2 初始 / 1.2 回写 | 初始 `false`；replied/rejected 后 `true`；**写 `true` 后不再改回** | 1.2 回写 / 1.3（终态跳过） |
| `request_id` | 1.2（事件） | asked 事件的 `properties.id`（与现 cancelWaitingNotify 用键一致） | 1.2 回写 / 1.3 置位（匹配键） |
| `created_at` | 1.2 | `new Date().toISOString()` | 本轮无（清理预留） |

## 3. `RegistryEntry.sessions` 与 parse/serialize 扩展契约（Phase 1.1）

### 3.1 类型扩展

```ts
export type RegistryEntry = {
  path: string;
  enabled: boolean;
  addedAt: string;
  sessions?: SessionRecord[]; // 新增（可选）：旧文件/旧代码路径无此键时保持 undefined
};
```

- `sessions` 为**可选**字段：旧 `projects.json`（无 sessions 键）解析后该字段为 `undefined`
  （或直接缺键），`serializeRegistry` 序列化时自动省略（`JSON.stringify` 天然行为，无需特判）。
- 内部遍历统一用 `entry.sessions ?? []` 语义，调用方不得假定字段存在。

### 3.2 `parseRegistry` 白名单扩展（严格模式，容错策略冻结）

现 `parseRegistry`（index.ts:31-61）只白名单保留 `path/enabled/addedAt`；**未列字段被
丢弃**——不扩展则 sessions 被静默丢弃（决策 #12）。本轮扩展为：

- `sessions` 键**不存在** → 条目不含该字段（不报错、不抛错）。
- `sessions` 存在但**非数组** → **丢弃该条目的 sessions 字段**（整字段忽略），条目本身保留。
- `sessions` 是数组 → 逐条校验 `SessionRecord`：全部 8 字段必须类型正确
  （`session_id/session_name/message/request_id/created_at` 为 string、`send/resolved` 为
  boolean、`type` 恰为 `"question" | "permission"` 之一）；**任一字段不符 → 丢弃该记录**
  （不抛错、不影响其它记录）。全数组过滤后为空则保留空数组。
- **既有语义不得改变**：条目缺 `path` → 整体 `return undefined`（现 47 行行为保持，
  sessions 校验不得放宽或收紧该总入口行为）。整个 json 非法 → `undefined`（同现状）。
- sessions 内记录的字段**不允许**从默认值推断（如把非 boolean 的 send 按 truthy 处理）——
  严格丢弃，保证写盘记录始终是合法 SessionRecord（poller 侧可无防御读取）。

### 3.3 `serializeRegistry`

现实现 `JSON.stringify(registry, null, 2)`（63-65）**零改动**：sessions 天然随对象序列化；
`sessions: undefined` 时键自动省略，往返后旧文件不产生新键。测试断言「往返后字段逐项
一致（含 created_at/request_id）」即可，不要求键序固定。

## 4. 记录操作纯函数契约（Phase 1.1 新建，冻结）

全部放 `src/registry/index.ts` 纯函数区（`deleteProjectByPath` 之后、`ProjectRegistryStore`
之前）。**不触碰** `mutate()/锁/缓存/serialized`（projects-registry.md §3/§4 零改动）。

### 4.1 `appendSessionRecord`

```ts
export function appendSessionRecord(
  registry: ProjectRegistry,
  rootPath: string,
  record: SessionRecord,
): ProjectRegistry
```

- 按 `normalizeRegistryPath(rootPath)` 匹配条目（复用 `findRegistryEntry` 语义）。
- 条目**不存在** → **返回原 `registry` 引用**（幂等，`mutate` 的 `next === registry` 短路
  不写盘；调用方 1.2 已保证先 `registerProject`，路径不存在是防御性兜底）。
- 条目存在 → 返回**新 registry**：`sessions: [...(entry.sessions ?? []), record]`
  （**追加不覆盖**，决策 #3；多个并发权限各自追加）。
- **纯函数不去重**：同一 `request_id` 重复 append 会追加两条——去重是写入端职责
  （`seenWaitingRequestIDs`，决策 #3）。
- 返回的 registry 必须是新对象引用（`mutate` 依赖引用比较做幂等短路）。

### 4.2 `markSessionResolved` / `markSessionSent`

```ts
export function markSessionResolved(
  registry: ProjectRegistry,
  requestID: string,
): ProjectRegistry | undefined

export function markSessionSent(
  registry: ProjectRegistry,
  requestID: string,
): ProjectRegistry | undefined
```

统一语义（两函数结构相同，只差置位字段）：

- 在**全部条目**的 `sessions` 中按 `record.request_id === requestID` 精确匹配
  （请求 ID 全局唯一，跨条目全局找第一条；顺序 = `projects` 数组序 + `sessions` 数组序）。
- **无匹配 → 返回 `undefined`**：消费方把它透传给 `mutate`，触发 projects-registry.md §4
  步骤 2 的「不写盘、不抛错、返回 undefined」路径（无匹配就是没有可标记的记录，
  静默跳过写盘）。
- 匹配到且目标字段**已是目标值**（如 markSessionResolved 时 record.resolved 已为 true）→
  返回**原 `registry` 引用**（幂等，`mutate` 短路不写盘）。
- 匹配到且目标字段需要变更 → 返回**新 registry**，仅改该字段：
  - `markSessionResolved`：`resolved = true`；**`send` 保持不动**（决策 #6：resolved 终态，
    即使 send=false 也不补发）；
  - `markSessionSent`：`send = true`；`resolved` 保持不动（poller 只置 send）。
- 返回的 registry 必须是新对象引用（同 §4.1）。

> 冻结理由：函数内不隐含「置位前检查对方字段」（如 resolved 时同时置 send 是**禁止**的），
> 两个字段各自独立、只由各自置位方消费，避免并发窗口下语义纠缠。

## 5. Phase 1.2 写入端契约（monitor 写入路径）

### 5.1 事件 → 记录映射（冻结）

| 输入事件（handleEvent 内） | request_id 提取 | type | message |
|---|---|---|---|
| `permission.asked` / `permission.v2.asked`（658-676） | `string(properties.id)` | `"permission"` | `JSON.stringify(properties)` |
| `permission.updated`（678-690） | `string(properties.id)` | `"permission"` | `JSON.stringify(properties)` |
| `question.asked` / `question.v2.asked`（705-728） | `string(properties.id)` | `"question"` | `JSON.stringify(properties)` |

- `message` = 该事件 `properties` 的完整 JSON 字符串（决策 #2：permission 含完整调用
  内容、question 含完整工具调用内容）。测试断言 `JSON.parse(message)` 可还原且包含
  permission/tool 等关键字段即可，不锁死字段子集。
- `await ensureSessionInfo(sessionID)` 拉名称（1163-1189）：成功取 `info.title`（`session` 的
  info 已缓存进 `session.info`，直接 `session.info.title`）；失败/无 title → `sessionID` 兜底。
  不得因拉取失败阻塞写盘（决策 #7）。
- `send=false`、`resolved=false`、`created_at=now ISO`（决策 #1）。

### 5.2 去抖与写入时机（冻结，勿回退）

- `permission`：`addWaiting` permission 分支（860-868）继续走
  `scheduleWaitingNotify(sessionID, waiting)`（875-886，**复用 `WAITING_NOTIFY_DEBOUNCE_MS`
  = 1000 与 `waitingNotifyTimers: Map<requestID, Timer>` 117-120**），但定时器回调**不再
  调 `notifyWaiting`**，改为：`registry.mutate(appendSessionRecord(reg, this.root, record))`
  写盘。窗口内收到 replied → `cancelWaitingNotify` clearTimeout → **完全不写入**
  （auto-approve 零落盘，决策 #4）。
- `question`：`addWaiting` question 分支（869-872）**立即** mutate 追加（不去抖，决策 #4）；
  原 `notifyWaiting` 调用点移除。
- `cancelWaitingNotify`（888-895）签名与调用点保持不变（session.deleted 563、dispose
  412-415 等继续可用），仅内部语义 = 「取消待写入」，不再有任何发送动作。

### 5.3 resolved 回写（冻结）

- 触发事件与 request_id 提取**必须复用现有 cancelWaitingNotify 调用点的同一表达式**
  （禁止自创键）：`permission.replied`/`permission.v2.replied`（692-703）用
  `string(properties.requestID) ?? string(properties.permissionID)`；`question.replied`/
  `question.rejected`/`question.v2.replied`/`question.v2.rejected`（730-741）用
  `string(properties.requestID)`。
- 分支动作：先 `cancelWaitingNotify(requestID)`（去抖窗口内 → 取消写入，不落盘）；
  **窗口外**（记录已写入）→ `registry.mutate((reg) => markSessionResolved(reg, requestID))`。
- **mutate 返回 `undefined` 一律静默容忍**（抢锁超时 3000ms 或无匹配记录），`logWarn` 一次，
  不重试、不抛错（projects-registry.md §4.2 + 决策 #8）。

### 5.4 旧直发停用（源码保留）

- `notifyWaiting`（897-920）函数体**保留不删**；其所有 waiting 调用点移除（addWaiting
  两分支、scheduleWaitingNotify 回调内）。
- `enqueueMessage`/`sendMessage`（1717-1742）**不动**——/menu、/help、terminal 通知等仍用。
- 验收：`grep notifyWaiting` 在 src/monitor.ts 中仍有定义、无 waiting 调用点。

## 6. Phase 1.3 扫描端契约（poller 每秒中继）

### 6.1 常量

- `src/constants.ts` 新增 `export const SESSIONS_SCAN_INTERVAL_MS = 1_000;`
  （**constants.ts 只允许 Phase 1.3 触碰**，1.2 不得修改该文件；现有
  `WAITING_NOTIFY_DEBOUNCE_MS = 1_000` 归 1.2 只读复用）。

### 6.2 扫描循环（冻结）

- 位置：`runTelegram`（1286-1381）**持锁成功后**（1291 `tryAcquire` 通过）启动 1s
  `setInterval` ticker；`finally` 释放锁之前 `clearInterval`（生命周期与锁严格同生共死；
  未持锁分支 1292-1301 不得启动 ticker）。ticker 回调直接调用 §6.3 的扫描方法。
- 扫描数据源：`registry.read()`（**不加锁读**，projects-registry.md §2 语义：最终一致，
  可读旧内容，无写者等待）。
- 筛选条件（决策 #6，冻结）：`send === false && resolved === false`。
  `resolved === true` 的记录**即使 send=false 也不补发**（终态）；`send === true` 跳过。
- 发送：逐条构造消息 → **`await this.sendMessage(text)`**（复用现有发送私有方法，
  **只调用不修改**；`sendMessage` 内部 `telegramWithRetry("sendRichMessage", …)` +
  `limitMessage`）。**发送成功判定 = `sendMessage` 正常 resolve**；抛错 → 本条不置位、
  `logWarn`，下轮 ticker 重试（决策 #8）。
- 发送成功 → `registry.mutate((reg) => markSessionSent(reg, record.request_id))`；
  mutate 返回 undefined（抢锁超时）→ 静默容忍 + `logWarn`，记录下轮再试（send 未置位属
  安全重试态）。
- 消息格式（决策 #9，复用等待通知样式）：`titleLine(iconForWaitingType(record.type), 项目label)`
  + `fieldTable([fieldRow("Type", type), fieldRow("Session", session_name | shortID)])` +
  message 节选；`项目label` = 记录所属条目 `basename(entry.path)`；整体经 `limitMessage` 截断。
  **（Round 2.1 supersede：permission 记录的「message 节选」改为结构化字段行，见 §13.11；
  question 记录仍为原文节选，本条对 question 保持有效。）**

### 6.3 可测试入口（冻结）

扫描发送逻辑必须抽为**可独立调用的私有方法**（如 `scanSessionQueue()`，返回本轮处理条数
或 Promise<void>），`setInterval` 只负责周期调用它。`tests/sessions-poller.test.mjs`
**不依赖真实 interval 时钟**，直接调用该方法（或 stub `sendMessage` 后驱动 ticker），
用 `monitor.sendMessage = async (text) => …` 打桩断言次数/内容/抛错重试。

### 6.4 扫描端禁区（冻结）

- **不**新增任何 waiting 写盘逻辑（append/resolved 一律不碰）；
- **不**触碰 `addWaiting`/`scheduleWaitingNotify`/`cancelWaitingNotify`（855-895）；
- **不**触碰 `handleEvent` 的 replied/rejected 分支（692-703、730-741）；
- **不**修改 `enqueueMessage`/`sendMessage`/`notifyWaiting`（1717 之后与 897-920）。

## 7. `src/monitor.ts` 编辑区间分配（防合并冲突，冻结）

两 phase 同改一个文件，按**行区域**切分（git 可自动合并的不同 hunk，互不重叠）：

| Phase | 独占编辑区间（当前行号） | 内容 |
|---|---|---|
| 1.2 | 658-741（handleEvent 内 permission/question 各分支） | replied/rejected 分支追加回写 mutate；`permission.updated` 记录内容微调 |
| 1.2 | 855-920（addWaiting / scheduleWaitingNotify / cancelWaitingNotify / notifyWaiting） | 写盘改造、去抖回调改写入、停用 notifyWaiting 调用点（函数体保留） |
| 1.3 | 1286-1383（runTelegram + 其后空白区） | ticker 启动/清理、`scanSessionQueue` 等新私有方法（放 1381/1383 附近） |

- 交集为零；两 phase 各自新增私有方法在自有区间内进行。
- 1.2 添加的辅助私有方法（构造 record、拉 name）放在 895-920 区域附近；
  1.3 的辅助方法放在 runTelegram 之后（1381 与 handleTelegramUpdate 1383 之间）。
- 行号是**冻结时的参考**，随实现漂移±数行不影响区域划分（以函数名界定为准）。

## 8. 测试编号契约（归属冻结）

| 编号 | 定义 | 文件 | 维护 phase |
|---|---|---|---|
| API-001 | auto-approve 回归：permission.asked + 1s 内 replied → projects.json **0 条**新记录 | `tests/behavior.test.mjs` | 1.2（改写） |
| API-002 | 真待审批：仅 asked，等 2.5s → 恰 1 条（type/message/send=false/resolved=false/request_id/created_at/session_name） | `tests/behavior.test.mjs` | 1.2（改写） |
| API-003 | question：asked → **立即** 1 条记录，message=完整调用内容 JSON | `tests/behavior.test.mjs` | 1.2（改写） |
| API-004 | resolved 回写：写入后 replied（含 v2/rejected 变体）→ 按 request_id 置 resolved=true；poller 跳过 resolved | `tests/behavior.test.mjs` | 1.2（新增） |
| API-005 | 并发多 permission（不同 request_id）→ 全部追加保留互不覆盖 | `tests/behavior.test.mjs` | 1.2（新增） |
| API-006 | poller 扫描发送：send=false&&resolved=false → 发 TG（stub 断言格式 ⚠️/❓+Session 字段）→ send=true；失败保留重试；resolved 跳过 | `tests/sessions-poller.test.mjs` | 1.3（新建） |
| REG-101 | sessions 往返：parse/serialize 白名单保留、损坏条目丢弃不抛错；append 追加不覆盖；mark* 按 request_id 精确匹配、无匹配 undefined、幂等返回原引用 | `tests/registry-sessions.test.mjs` | 1.1（新建） |
| LOCK-001~005 | registry 锁回归（既有，不许破坏） | `tests/registry-concurrency.test.mjs` | 无人触碰；1.1 验收须回归 |
| BUILD-001 | `node scripts/build.mjs` exit 0 + 根 monitor.ts 产物 | — | 各 phase 验收 + 终验 |
| BUILD-002 | bundle 冒烟：default 为函数、无其它导出（legacy 加载器约束） | `tests/e2e/bundle-smoke.test.mjs` | 终验 |

- 测试基建冻结：bun 运行、无框架、`HOME=$(mktemp -d)` 隔离、dynamic import
  （`--dry` 模式沿用 behavior.test.mjs 模式：前序产物未合并时可载入 exit 0）。
- 1.2 执行：`HOME=$(mktemp -d) bun tests/behavior.test.mjs`；1.3 执行：
  `HOME=$(mktemp -d) bun tests/sessions-poller.test.mjs`；1.1 执行：
  `bun tests/registry-sessions.test.mjs` + `bun tests/registry-concurrency.test.mjs`。

## 9. 调用点与消费契约（现状，冻结）

| 调用点 | 用途 | 本轮变化 |
|---|---|---|
| `src/monitor.ts:458` | 周期自注册 `mutate(registerProject(reg, this.root))` | 不变；写入端依赖它保证条目存在 |
| `src/monitor.ts:437/1601/1664` | `registry.read()` / isEnabled | 不变；1.3 扫描新增一次 read |
| `src/monitor.ts:117-120` | `waitingNotifyTimers` 表 | 1.2 复用（去抖写盘） |
| `src/monitor.ts:116` | `seenWaitingRequestIDs` | 1.2 继续用于去重（决策 #3） |
| `src/monitor.ts:130-133` | `poller.lock`（TG 轮询互斥） | 1.3 作为扫描执行者资格凭据（唯一持有者） |
| `projects.json.lock` | registry mutate 锁（另一把独立锁） | 1.2/1.3 均经 mutate 消费，不直接触碰 |

两把锁关系（决策 #8 + projects-registry.md）：**`poller.lock` 与 `projects.json.lock`
完全独立**——poller.lock 持有者只是「谁扫描」的裁决；扫描出的每次置位/追加仍走各自
`mutate` 的 projects.json.lock 临界区，两者互不相干。

## 10. 明确不做的事（防过度实现）

- 不做 sessions 清理/去重/过期回收（`created_at` 仅预留，决策 #13）。
- 不改 `mutate`/锁/缓存/serialized/`writeAtomic`（projects-registry.md §3/§4 冻结）。
- 不改 `PollerLock`、`SharedFileStore`。
- 不把 `message` 展开为结构化字段（保持 JSON 字符串，决策 #2）。
- 不给 `read()` 加锁或等待（保持最终一致，poller 每秒重扫天然自愈）。
- 不新增 Telegram 命令/键盘回调（`/sessions` 仍为 PLANNED_COMMANDS 计划状态，本轮不开放）。

## 11. 与既有契约的差异（supersede 记录）

| 出处 | 原句 | 本轮状态 |
|---|---|---|
| projects-registry.md §2.1 | 「详解 parseRegistry/serializeRegistry 等纯函数区 **本轮零改动**」 | 本轮（sessions-tg-relay）扩展：`RegistryEntry` 增 `sessions?`、parseRegistry 白名单扩展、新增 3 个记录纯函数；§3/§4 锁语义**保持零改动**（详见 projects-registry.md §10） |
| projects-registry.md §7 | 验证门含 `behavior.test.mjs（API-001/002/003）` | 本轮 API-001~003 语义改写 + 新增 API-004/005（新语义见本文件 §8） |
| 00-overview.md「权限通知去抖」 | 去抖后 notifyWaiting 发送 | 去抖窗口保留，回调动作改为**写盘**（§5.2） |
| 本文件 §2 `SessionRecord` 类型 | 8 字段，无 reply | Round 2 新增可选 `reply` 字段（§13.1，含 parse 容错） |
| 本文件 §6.2 扫描端筛选条件 | `send === false && resolved === false` | Round 2 追加 `&& reply == null`（§13.3；已写 reply 的未发送记录永不发送，走消费端 apply） |
| 本文件 §5.3 resolved 回写 | resolved 仅由 replied/rejected 事件置位（单路径） | Round 2 新增第二路径：消费端 apply 成功后置位（§13.6；双路径先到先得，§5.3 逻辑保留） |
| 本文件 §7 `src/monitor.ts` 编辑区间 | Round 1 行号区间（658-741/855-920/1286-1383） | 历史已合并；Round 2 区间以 §13.7 为准 |
| 本文件 §8 测试编号表 | API-001~006 / REG-101 / LOCK / BUILD | Round 2 新增 API-101~104 / REG-201，追加锚点规则见 §13.9；Round 2.1 新增 API-105（§13.9/§13.11） |
| README.md「只读」声明 | "The bot is fully read-only: approvals, permission prompts and answers are always handled in opencode itself" | 2026-09-02 起 permission 记录支持 TG 三按钮回写（仅在你显式点击时；question 与其它一切仍留在 opencode，绝不擅自代答）。**本轮 README 修订被 doc-prep 写权限边界阻断（README.md ∉ docs/**），由 dev-lead 另行指派执行，见计划「断点记录」** |
| docs/00-overview.md「只读」声明 | 「插件绝不代答（monitor.ts 中无任何 permission.reply/question 代答路径）」 | 同上：2026-09-02 起支持 TG 审批回写（点击驱动）；monitor.ts 新增 reply API 调用路径为按钮显式触发 |
| 本文件 §6.2 消息格式 | permission 记录渲染 = 「message 节选」 | Round 2.1（Phase 2.1）supersede：permission 记录改为解析 message JSON 后的结构化字段行（§13.11）；question 记录仍为原文节选（§6.2 对 question 保持有效） |
| 本文件 §13.3「formatSessionRecordMessage 零改动」 | 1.2 不碰该函数体（文本格式不变） | Round 2.1 supersede：函数体由 Phase 2.1 修改为结构化渲染（§13.11）；「1.2 不在该轮改此函数」的约束仍成立，且发送通道/键盘/筛选条件零变化 |
| 本文件 §13.11 渲染规则 | permission 记录 = Type/Session 表 + Permission/Pattern/Title 表（**两张** fieldTable）+ 原文节选 fallback；结构化值经 `safeText`（路径脱敏 `<external-path>`/`<project>`/40+ 长 blob） | Round 3（本轮 permission-pattern-table）supersede：**单张** fieldTable（Type/Session/Permission/Pattern N 同表）、**Title 行移除**、Pattern 逐行编号（单 `Pattern` / 多 `Pattern 1/2/…`）、结构化值改 `safeTextKeepPaths`（保留密钥/token 脱敏、**放开路径脱敏**显示真实路径）；fallback（原文节选 300 字符）与 `limitMessage` 保持（§13.12） |
| 本文件 §13.11 编辑区间 | Round 2.1：仅 `formatSessionRecordMessage`（1791-1810）+ tests 尾部追加 API-105 | 本轮 §13.12：1.1 独占 `src/format/redact.ts` + 新测试文件 `tests/redact-keep-paths.test.mjs`；1.2 独占 `src/monitor.ts`（import 块 48-82 + 方法体 1794-1859）+ `tests/sessions-poller.test.mjs`（API-105 区块 907-1001 + 尾部追加） |
| 本文件 §13.10「明确不做」 | 「不做 question 记录按钮/回写（决策 #2，后续轮）」 | Round 4（question-tg-wizard）**supersede**：question 记录实现 TG 交互向导 + reply/reject 回写（§14）；§13.10 其余条目保持 |
| 本文件 §13.3 发送条件 | `send === false && resolved === false && reply == null` | Round 4 追加 `&& q_answers == null && q_reject !== true`（§14.2.2；对 permission 恒真，permission 语义不变） |
| 本文件 §6.2 question 记录渲染 | question 记录 = message 原文节选（300 字符，`safeText`） | Round 4 supersede：question 记录发送改走向导渲染（§14.2.2 scanSessionQueue question 分支）；解析失败/无 questions 时保留原文节选 fallback（§14.2.2 步骤 1） |
| 本文件 §13.7/§13.12.4 编辑区间 | Round 2/3 区间划分 | Round 4 区间以 §14.6 为准 |
| 本文件 §8/§13.9 测试编号 | API-001~006/101~106 / REG-101/201 / REDACT / LOCK / BUILD | Round 4 新增 REG-301 / API-201~205（§14.5） |
| docs/00-overview.md「question 本轮无按钮」 | 「question 与其它一切审批/回答流程仍留在 opencode，插件绝不擅自代答」（00-overview 29 行同款） | Round 4 起 question 记录支持 TG 向导交互（仅用户显式点击/输入触发；绝不主动代答）。README/00-overview 文字修订超出 doc-prep 写权限边界（∉ docs/**），由 dev-lead 另行指派执行 |
| 本文件 §14.4.3 兜底形态 | 扁平方法 `postApiSessionSessionIDQuestionRequestIDReply/...Reject` + 嵌套 body `{ questionV2Reply: { answers } }` | **Round 2（修复轮）supersede**：运行时实证扁平客户端无任何 question 方法（必然 not-a-function），body 实为顶层 `{ answers }`——改走 `(client as any)._client.post` 分层通道 ①②③ + 实例级缓存（§14.8.1） |
| 本文件 §14.4.2 失败重试 | 失败/抛错 → logWarn 不置位，下轮 ticker 重试 | **Round 2（修复轮）supersede 例外**：错误判定「不存在」（404/QuestionNotFound/SessionNotFound）→ 置 resolved 终态 + log info + 不重试（§14.8.2）；非 404 维持原语义 |
| 本文件 §14.2.2 sendMessageWithKeyboard 返回 | `return response?.result?.message_id`（单形态） | **Round 2（修复轮）supersede**：三形态防御解析（`result?.message_id ?? result?.message?.message_id ?? result?.messageId`）+ 首次 dline 键名诊断；语义不变（§14.8.3） |
| 本文件 §14.2.1 custom 行条件 | custom 行仅当 `questions[stage].custom === true` 渲染 | **Round 2（修复轮）supersede**：✏️ Custom 恒显示（真实 payload 从不带 custom 标志）；§14.3.1 custom 防御同步移除、§14.3.3 文案行删除（§14.8.4） |
| 本文件 §14.2.1 总结阶段导航行 | `[✅ Submit] [❌ Cancel]` | **Round 2（修复轮）supersede**：多问题请求总结阶段 = `[⬅️ Prev] [✅ Submit] [❌ Cancel]`；回调 clamp 已支持 prev 从 stage=length 回最后一题，零回调改动（§14.8.5） |
| 本文件 §14.3.2 第 5 步（纯文本编辑） | q_msg_id 缺失 → logWarn 跳过编辑（答案已落盘） | **Round 2（修复轮）supersede**：q_msg_id 缺失 → 发一条新的当前阶段向导消息（多问题含键盘并回写新 q_msg_id；单问题 ✅ Submitted 终态无键盘），旧消息不动（§14.8.6） |
| 本文件 §13.5 第 6 步（editPermissionResultMessage） | originalText = `callback.message.text`（网关纯文本视图）原样拼接结果行；wire 形态 = 官方 `editMessageText` | **Round 5（telegram-rich-message-edit）supersede**：originalText 改为服务器侧记录重渲染（`formatSessionRecordMessage`）+ 结果行（§15.4）；wire 形态统一走 `richEditMessage`（§15.3），内部 = probe gate 赢家富文本形态（§15.2）；结果行文案/键盘移除/失败容忍不变 |
| 本文件 §14.3.1（editQuestionWizardMessage 终态编辑） | 终态文本 = `${message.text ?? ""} + 结果行`（callback.message.text 依赖）；wire 形态 = 官方 `editMessageText` | **Round 5 supersede**：终态文本 = 当前阶段服务器侧重渲染 + 结果行（§15.4，与纯文本输入路径同源）；wire 形态统一走 `richEditMessage`（§15.3）探针赢家形态；重渲染/键盘两态不变 |
| 本文件 §13.5/§14.3.1 编辑 wire 形态 + editMenuMessage | 三条编辑路径各自 `telegramWithRetry("editMessageText", { chat_id, message_id, text, reply_markup? })` | **Round 5 supersede**：三条路径全部迁移到统一 `richEditMessage`（§15.3）；wire 形态 = probe gate 赢家（§15.2，候选 A 对称 `editRichMessage`+`rich_message.html` 优先）；menu 刷新 `<p>` 泄漏随富文本载体修复（§15.1/§15.3） |
| 本文件 §8/§13.9/§14.5 测试编号 | API-001~207 / REG-101~301 / REDACT / LOCK / BUILD；real 探针 E2E-20x | **Round 5 新增** REAL-RICH-EDIT-001~005（探针，§15.2）与 API-301~304（编辑统一形态/终态文本源/菜单/menu/首发达标回归，§15.5） |
| 本文件 §14.3.1 custom 动作文案 | custom 弹窗 = `直接回复文本作为答案，/cancel 取消`（纯文本 toast） | **Round 1（question-custom-input-ux）supersede**：弹窗文案改为 `请输入 {project} 的 {question} 答案，如果放弃输入请输入 /cancel`（questionInputPromptText，外层 safeText 200 截断；§14.9.1） |
| 本文件 §14.2.1 输入模式提示行 | `fieldRow("输入", "✏️ 回复文本作为答案，/cancel 取消")` | **Round 1 supersede**：`fieldRow("输入", \`✏️ ${questionInputPromptText(projectLabel, current, ctx)}\`)`（§14.9.1；✏️ 前缀保留在值内） |
| 本文件 §14.3.2 第 5 步 /cancel | `clearQuestionInputs` 一锅端 + 无条件发「已取消输入模式」 | **Round 1 supersede**：逐条取消新格式（cancelPendingQuestionInputs，§14.9.2）+ 无活取消时静默（§14.9.3）；`clearQuestionInputs` 保留不删（REG-301 仍测）但 monitor 不再调用 |
| 本文件 §14.3.3 文案表 custom 行 / §14.8.4 中文案行 | 均为 `直接回复文本作为答案，/cancel 取消` | **Round 1 supersede**：升级为 questionInputPromptText 新文案（§14.9.1）；custom 恒显示语义不变（§14.8.4 其余保持） |
| 本文件 §8/§13.9/§14.5/§14.8.7 测试编号 | API-001~207 / API-301~304 / REG / REDACT / LOCK / BUILD | **Round 1 新增** API-208-1~4（§14.9.5）与 API-203-1/3/4 改判（§14.9.5）；维护归属见 §14.9.5 |
| 本文件 §14.6/§14.8 编辑区间 | Round 4 / Round 2 区间划分 | Round 1 区间以 §14.9.6 为准（1.1/1.2 严格顺序：批次 A → 批次 B） |

## 12. 变更记录

- 2026-09-02 冻结（Round 1 / sessions-tg-relay）：SessionRecord 类型、RegistryEntry.sessions、
  parse/serialize 扩展容错、append/mark 纯函数、1.2 写入端与 1.3 扫描端边界、编辑区间、
  API/REG/LOCK/BUILD 归属、SESSIONS_SCAN_INTERVAL_MS 常量归属。
- 2026-09-02 冻结（Round 2 / tg-permission-buttons，见 §13）：SessionRecord.reply 字段与 parse 容错、
  setSessionReply 三态、按钮键盘与 callback_data（64 字节核验 + permShortMap 缩短方案）、
  handleCallback perm 分支行为序列、消费端扫描器（scanReplyQueue/applySessionReply）、
  发送条件 `&& reply == null`、Round 2 编辑区间、测试编号 REG-201/API-101~104 与同文件追加锚点规则、
  SDK 签名核验任务与兜底形态。
- 2026-09-02 修订（Round 2 / Phase 2.1 结构化渲染，见 §13.11）：permission 记录渲染
  supersede「message 原文节选」→ 解析 message JSON 的结构化字段行（Session/Type/Permission/Pattern(s)/Title，
  宽松缺字段跳行；解析失败或无字段退回 300 字符原文节选）；question 记录渲染不变；发送通道与键盘零变化。
  supersede 记录见 §11，测试编号新增 API-105（§13.9）。
- 2026-09-02 冻结（Round 3 / permission-pattern-table，见 §13.12）：permission 记录渲染 supersede
  §13.11——**单张 fieldTable**（Type/Session/Permission/Pattern N 同表）、**移除 Title 行**、Pattern
  逐项逐行编号（单 `Pattern` / 多 `Pattern 1/2/…`）、结构化值改 `safeTextKeepPaths`（密钥/token 脱敏链
  与 safeText 完全一致、跳过三条路径类规则，真实路径可见）；新增 `safeTextKeepPaths` 导出契约与
  1.1/1.2 编辑区间（零交集）；fallback（原文节选 300 字符）与 `limitMessage` 保持；测试编号
  REDACT-001~003 / API-105 更新 + API-106 新增。supersede 记录见 §11。
- 2026-09-02 冻结（Round 4 / question-tg-wizard，见 §14）：question 记录实现 TG 交互向导——
  SessionRecord 追加 6 个 q_* 可选字段与白名单容错、5 个纯函数 + clearQuestionInputs（全局匹配 /
  无匹配 undefined / 幂等原引用 / 只改目标字段）、发送端向导渲染（OTG_Q_CB_PREFIX +
  buildQuestionStageText + buildQuestionKeyboard）、sendMessageWithKeyboard 最小扩展返回 message_id、
  发送条件追加 `q_answers==null && q_reject!==true`、questionEntryID/qShortMap（64 字节核验）、
  回调向导状态重建协议（无内存状态）与动作序列、answer 文案总表、纯文本捕获 + /cancel、
  消费端 applyQuestionReply/Reject 与 SDK 签名核验任务（v2 嵌套 body `{ questionV2Reply: { answers } }`
  修正早稿「body `{ answers }`」）、测试编号 REG-301/API-201~205 与锚点修正（API-006-5/API-101-2
  既有断言最小改判归 1.2）、编辑区间零交集。**supersede §13.10「不做 question 按钮/回写」**。
  supersede 记录见 §11。
- 2026-09-02 修订（Round 4 / Phase 1.5 单问题多选提交死角修复）：§14.2.1 键盘行序第 3 条——
  单问题请求多选（`multiple === true`）追加 `[✅ Submit](:submit)` + `[❌ Cancel](:cancel)`
  （toggle 不自动提交，须显式 Submit，消除无提交路径死角）；§14.3.1 submit 守卫放宽为
  **任意 stage 均可提交**（多问题请求键盘层仍总结阶段才渲染 Submit，行为不变）；
  §14.3.3 文案表删除「非总结阶段 submit → Unknown action」场景。
- 2026-09-02 冻结（Round 2 修复轮 / question-tg-wizard，见 §14.8，实机反馈三问题）：消费端
  applyQuestionReply/Reject **supersede §14.4.3 兜底形态**——运行时扁平客户端无任何 question
  方法实证（必然 not-a-function）+ body 顶层 `{answers}` 实证（非嵌套），改走
  `(client as any)._client.post` 分层通道（①扁平 typeof → ②v2 会话级 → ③v2 全局
  `query:{directory:root}`，每轮按序尝试、实例级缓存已成功通道）；404 终态（404/
  QuestionNotFound/SessionNotFound → markSessionResolved + log info + 不重试，非 404 维持重试）；
  sendRichMessage message_id 三形态防御解析 + 首次 dline 键名诊断；✏️ Custom 恒显示
  （移除 custom===true 条件与「该题不支持自定义输入」防御及文案行）；汇总阶段导航行加
  ⬅️ Prev；输入兜底——q_msg_id 缺失改发新向导消息（多问题含键盘+回写新 id / 单问题
  ✅ Submitted 无键盘）；fakeClient 调整（删扁平 stub → `_client.post`）+ API-205 改判（2.1）+
  API-203-4 改判（2.2）；测试编号 API-206/207 与锚点、Round 2 编辑区间（零交集）。
  supersede 记录见 §11。
- 2026-09-03 冻结（Round 5 / telegram-rich-message-edit，见 §15）：**编辑刷新持续富文本渲染**
  统一契约——首次发送 `sendRichMessage`+`rich_message.html` 零改动；三条编辑路径
  （permission 结果 / question 向导 / menu 刷新）从官方 `editMessageText` 纯文本统一迁移到
  probe gate 赢家富文本形态的 `richEditMessage` helper（§15.3）；探针契约
  REAL-RICH-EDIT-001~005（对称候选 A `editRichMessage`+`rich_message.html` → B
  `editMessageText`+`rich_message.html` → C `editMessageText`+`parse_mode:"HTML"`，同一
  message_id 顺序编辑、键盘两态、全部候选失败**不得假装修复**须上报进入后续设计决策轮，§15.2）；
  终态文本脱离 `callback.message.text` 改服务器侧重建（permission = `formatSessionRecordMessage`
  重渲染 + 结果行；question = 当前阶段重渲染 + 结果行，§15.4，supersede §13.5/§14.3.1 文本来源）；
  menu `<p>` 泄漏随富文本载体修复；helper 内 `limitMessage` 补全；错误语义
  （logWarn + errorCategory 脱敏 + 不抛错）与键盘两态不变；测试编号 API-301~304 与既有
  `editMessageText` 断言最小改判锚点（§15.5）；编辑区间单 phase 零交集（§15.6）。
  supersede 记录见 §11。
- 2026-09-03 冻结（Round 1 / question-custom-input-ux，见 §14.9）：question Custom 输入提示
  两点增强——① 提示带标识：format.ts 新增 3 个导出纯函数 questionLabel（header trim 非空直用，
  否则问题正文 safeTextKeepPaths 60 截断兜底，截断加 ASCII `...`）/ questionInputPromptText /
  questionInputCancelledText，弹窗（safeText 200 截断）与向导提示行（`✏️ ` 前缀保留）接入新模板
  （§14.9.1，supersede §14.2.1/§14.3.1/§14.3.3/§14.8.4 文案行）；② 单活输入模式：新私有方法
  cancelPendingQuestionInputs（点新 Custom 自动取消旧待输入——失效残留静默清、活记录发取消消息 +
  清 q_input + renderQuestionStage 重渲染回正常视图，§14.9.2）+ /cancel 重写为逐条取消新格式、
  无活取消静默（§14.9.3，supersede §14.3.2 第 5 步；clearQuestionInputs 保留不删但 monitor 不再
  调用）+ rebuildQuestionState 三处状态重建去重（§14.9.4）；测试 API-203-1/3/4 改判 + API-208-1~4
  新增（§14.9.5）；编辑区间 1.1/1.2 严格顺序批次 A → 批次 B（§14.9.6）。supersede 记录见 §11。

## 13. Round 2 扩展：TG 审批按钮 + reply 回写应用（冻结 2026-09-02）

> 计划: docs/todos/tg-permission-buttons.md。批次 A = [1.1]（registry），批次 B = [1.2（发送端）, 1.3（消费端）]。
> 本文件仍是 sessions 中继子系统的唯一权威契约；本章在 §2/§4/§6/§8 之上追加扩展，supersede 记录见 §11。
> **本轮打破「只读/绝不代答」声明**（用户明确要求）：permission 记录的 TG 消息渲染三个按钮，
> 点击后主进程写入 `reply` 字段，**拥有该 session 的 opencode 实例**每秒扫描自己的条目并调
> opencode 官方 permission reply API 应用，成功后置 resolved=true。question 记录本轮**不做**按钮与回写。
> 插件绝不擅自代答：只有用户显式点击按钮才会触发 reply API。

### 13.1 `SessionRecord.reply` 字段（supersede §2 类型定义，Phase 1.1）

在 §2 类型上追加一个**可选**字段（其余 8 字段及语义不变）：

```ts
export type SessionRecord = {
  // ...（§2 既有 8 字段）
  reply?: "once" | "always" | "reject" | null; // 新增：null/缺失 = 未回复；三值 = 用户选定回复（透传不映射）
};
```

- 定义位置：`src/registry/index.ts` SessionRecord（现 23-32 行）。
- **写入端初始不设置 reply 键**（记录保持「缺失」状态）。

`parseSessionRecord` 扩展（1.1，扩展私有函数 90-117；其余 8 字段校验不变）：

| reply 键形态 | 结果 |
|---|---|
| 键**缺失** | 构造记录**不含 reply 键**（undefined；`serializeRegistry` 零改动自动省略 → 旧文件往返**不新增键**） |
| 显式 `null` | `reply: null`（JSON null 保留 = 显式「未回复」） |
| `"once" \| "always" \| "reject"` | 原样保留 |
| 其它任何值（非 string、或 string 不在三值集、或 array/object/number/boolean） | **丢弃整条记录**（与 §3.2 严格白名单一致：不抛错、不影响其它记录） |

消费语义（冻结）：

- `reply == null`（同时覆盖缺失 undefined 与显式 null）＝ **未回复**。
- 已写 reply 的记录**永不再次发送**（§13.3 筛选追加 `reply == null`），其处理路径 = 消费端 apply（§13.6）。
- `reply` 与 `send`/`resolved` 相互独立：写 reply 不改 send/resolved；置位方不改 reply（§4.2 冻结理由同样适用；`markSessionFlag` 私有实现零改动）。

### 13.2 `setSessionReply` 纯函数（Phase 1.1 新增，冻结）

位置：`src/registry/index.ts` 纯函数区（`markSessionSent` 之后、`ProjectRegistryStore` 之前）。
签名与 `markSessionResolved` 同构（**全局 request_id 精确匹配**——跨全部条目找第一条，顺序 = projects 数组序 + sessions 数组序）：

```ts
export function setSessionReply(
  registry: ProjectRegistry,
  requestID: string,
  reply: "once" | "always" | "reject",
): ProjectRegistry | undefined
```

三态语义（与 §4.2 统一）：

- **无匹配**（全条目无该 request_id）→ 返回 `undefined`：调用方透传 mutate → 不写盘、不抛错（§4.2 步骤 2 路径）。
- **匹配且 `record.reply` 已是同一值** → 返回**原 registry 引用**（幂等，mutate 短路不写盘）。
- **匹配且值不同** → 返回**新 registry**，**仅改 reply 字段**（send/resolved 不动；即使 resolved=true 也允许写 reply——纯字段写、无状态检查）。
- 返回必须是新对象引用（mutate 依赖引用比较）。

**不复用 `markSessionFlag`**：它是 boolean 置 true 的私有 helper，值类型不同，1.1 自行实现（可建私有 helper，仅导出 `setSessionReply`）。
验收：REG-201（往返：缺失/null/三值/非法容错；三态：写入 / 无匹配 undefined / 幂等原引用）；REG-101 与 LOCK-001~005 回归全绿。

### 13.3 发送端：permission 记录带三按钮（Phase 1.2，冻结）

**`buildSessionPermissionKeyboard`（`src/format/format.ts` 新增导出，纯函数；format.ts 本轮 1.2 独占）**：

```ts
export const PERM_CB_PREFIX = "otg:perm:"; // 常量放 format.ts（constants.ts 本轮零新增，决策 #9）
export function buildSessionPermissionKeyboard(entryID: string): TelegramInlineKeyboard
```

- 返回 `{ inline_keyboard: [[ 3 按钮 ]] }`（仿 `buildMenuKeyboard` 行结构，复用 `TelegramInlineButton`/`TelegramInlineKeyboard`，src/types.ts:98-99）：
  - `Allow once` → `${PERM_CB_PREFIX}${entryID}:once`
  - `Allow always` → `${PERM_CB_PREFIX}${entryID}:always`
  - `Deny` → `${PERM_CB_PREFIX}${entryID}:reject`
- `entryID` 由调用方（monitor）保证 ASCII 且每个 callback_data ≤ 64 字节（§13.4）；函数本身**不做**长度断言（纯函数）。
- **只加在 `type === "permission"`** 记录；question 记录无键盘（决策 #2）。

**`scanSessionQueue` 变更（发送通道口径澄清，冻结）**：

- 现状（1534-1578）：所有记录 `await this.sendMessage(text)`；成功判定 = sendMessage resolve → `markSessionSent`；抛错不置位下轮重试（§6.2）。
- 本轮：permission 记录改 `await this.sendMessageWithKeyboard(text, keyboard)`（1969-1979，**awaitable**）；question 记录维持 `await this.sendMessage(text)`。
- **不使用 `enqueueMessageWithKeyboard`**（1949-1959）：它是 fire-and-forget（sendTail 串行、返回 void、无成功判定），扫描循环无法据此维持 markSessionSent 时机；它留给事件路径，本轮无新事件路径调用点。——对计划「改走 enqueueMessageWithKeyboard」表述的修正：发送通道 = **复用现成 `sendMessageWithKeyboard`**（与决策 #2 一致）。
- keyboard 构建：`buildSessionPermissionKeyboard(this.permissionEntryID(record.request_id))`（entryID 换算见 §13.4）。
- **筛选条件更新（supersede §6.2）**：`send === false && resolved === false && reply == null`（决策 #6 防御）。`reply == null` 对 question 记录恒真（无 reply 键 → undefined == null），一条条件同时覆盖两类；已写 reply 的未发送记录**永不发送**（走消费端 apply）。
- `formatSessionRecordMessage`（1587-1606）**零改动**（文本格式不变，1.2 不碰该函数体）。
  **（Round 2.1 supersede：函数体由 Phase 2.1 修改为结构化渲染，见 §13.11；本条对 1.2 的
  「不在 1.2 改该函数」约束仍成立，且发送通道/键盘/筛选条件零变化。）**

**发送端新增私有成员（monitor.ts，1.2 地盘）**：

- `private permShortMap = new Map<string, string>();`（shortID → requestID，§13.4）
- `private permissionEntryID(requestID: string): string`：返回进入键盘的 entryID（全量或缩短），超限时登记缩短映射。
- 新私有方法必须落在 §13.7 划定的 1.2 区间内。

### 13.4 callback_data 契约与 64 字节核验（冻结）

- 格式：`otg:perm:<entryID>:<once|always|reject>`（前缀风格沿用 `otg:set:`/`otg:del:`，buildMenuKeyboard 同源）。
- **Telegram callback_data 上限 64 字节（UTF-8）**。长度核验在 monitor 侧、构建键盘时执行：
  - `full = PERM_CB_PREFIX + requestID + ":always"`（`:always` 为最长后缀，7 字节）；`Buffer.byteLength(full) <= 64` → entryID = requestID（UUID 型 requestID 实测预期成立）。
  - 超限 → `shortID = requestID.slice(0, 44)`（44 + 9 + 7 = 60 ≤ 64，ASCII 假设）；`this.permShortMap.set(shortID, requestID)`；entryID = shortID。重复 key 且 requestID 不同 → logWarn 并覆盖（碰撞概率极低，容忍）。
  - **禁止静默截断 callback_data；禁止在 entryID 上直接截断导致回调不可解析。**
  - 兜底：requestID 含多字节字符致 44 字符仍超限 → logError + 该记录**不发送按钮**（退化为无键盘普通消息），保证可解析性。
  - 实测 requestID 长度结论必须写入 1.2 任务报告。
- **解析**（1.2 handleCallback 前置分支，**早于**通用正则 1837）：`/^otg:perm:(.+):(once|always|reject)$/`（贪婪 `(.+)` 容忍 requestID 内含 `:`；后缀锚定）。不命中 → 落入通用正则 / "Unknown action" 路径。
- **回调侧还原**：`requestID = this.permShortMap.get(entryID) ?? entryID`（缩短映射只存于 poller 实例内存；进程重启后旧按钮点击 → 还原为 raw 找不到记录 → §13.5 无匹配分支，可接受降级，**不做映射持久化**）。
- 按钮发出进程 = poller.lock 持有者（getUpdates 唯一消费方），permShortMap 只在该进程被点击消费，**无跨进程一致性问题**。

### 13.5 `handleCallback` perm 分支（Phase 1.2，冻结）

在现有 chatId 校验（1834 行 `String(callback.from?.id) !== this.config.chatId → return`）之后、通用正则（1837）**之前**插入 perm 判定。行为序列：

1. **判定**：`data.startsWith(PERM_CB_PREFIX)` 或 perm 正则命中（§13.4）。
2. **解析**：perm 正则 → entryID + value；value ∈ {once, always, reject}。
3. **还原**：`requestID = this.permShortMap.get(entryID) ?? entryID`。
4. **mutate**：`await this.registry.mutate((reg) => setSessionReply(reg, requestID, value))`。
   - 返回 `undefined`（无匹配记录 / 抢锁超时）→ `answerCallback(id, "记录不存在或已失效", true)` + logWarn + **return（不编辑消息）**。
   - 有匹配 → 继续；**不读取 resolved/send 状态**（纯写入；已 resolved 记录被写 reply 属容忍竞态——消费端跳过、无安全影响）。
5. **answer**：`answerCallback(id, 文案, false)`，文案冻结：once → `已允许一次`；always → `已允许总是`；reject → `已拒绝`。
6. **编辑原消息**（新增私有方法，可测试入口，冻结签名）：
   ```ts
   private async editPermissionResultMessage(
     chatID: number | string,
     messageID: number,
     originalText: string,
     value: "once" | "always" | "reject",
   )
   ```
   - 内部：`telegramWithRetry("editMessageText", { chat_id, message_id, text: originalText + "\n" + 结果行 })`——**不传 reply_markup ⇒ 键盘被移除**（防重复点击，决策 #4）。
   - 结果行冻结（追加原文末尾）：once → `✅ Allowed once`；always → `✅ Allowed always`；reject → `❌ Rejected`。
   - originalText = `callback.message.text`。**类型扩展（1.2 独占）**：src/types.ts `TelegramCallbackQuery.message`（88-96）追加 `text?: string`（当前只声明 message_id/chat）。
   - 编辑失败 → logWarn（消息过期/被删等），**不抛错中断**（answer 已发出，视为已处理）。
7. **异常兜底**：沿用 handleCallback 现有 try/catch（1891-1898）——answer「操作失败，请重试」（alert）+ log error。**perm 分支不得落入函数末尾的 `editMenuMessage` 菜单刷新（1889-1890）**——须在编辑原消息后自行结束。

失败分支汇总（API-102 断言）：

- 非法 chatId → 1834 行直接 return（无 answer / 无 mutate / 无 edit）。
- data 非 perm 前缀 → 通用正则 → "Unknown action"。
- 无匹配记录 → answer「记录不存在或已失效」+ 不编辑消息。
- value 非法 → 同 "Unknown action" 路径。

### 13.6 消费端扫描器：每实例 reply 应用（Phase 1.3，冻结）

**成员（1.3 地盘，§13.7）**：

- `private replyScanTimer?: ReturnType<typeof setInterval>;`（145 行附近字段区）
- `private replyScanInFlight = false;`
- `private startReplyScan()` / `private stopReplyScan()`：挂载/清理 1s ticker（仿 startSessionsScan 1499-1516 / stopSessionsScan 1519-1524 模式：in-flight 守卫 + track 包裹 + try/finally 复位）。
- **生命周期（与 poller.lock 无关）**：`initialize()`（158-169）末尾追加 `this.startReplyScan();`；`dispose()`（412-443）追加 `clearInterval(replyScanTimer)`（验收：dispose 后无残留 interval）。每个 opencode 实例都跑自己的消费扫描（决策 #5），不依赖 runTelegram/持锁。startReplyScan 需 disposed 守卫（仿 scheduleRegistration 458-464）。

**`scanReplyQueue()`（私有，`Promise<number>`，可测试入口——契约 §6.3 同款）**：

- 头部 `if (this.disposed) return 0;`
- `registry.read()`（不加锁，最终一致）→ `findRegistryEntry(reg, this.root)`：**只扫自己条目**；条目缺失 → 返回 0 无操作。
- 筛选（决策 #5，冻结）：`record.type === "permission" && record.reply != null && record.resolved === false`。
- 逐条**串行**调 `applySessionReply`；单条抛错不得中断整轮（try/catch → logWarn 继续）。返回本轮成功应用条数。
- ticker 回调：仿 startSessionsScan（in-flight 守卫 + track(async()=>{ try { await scanReplyQueue() } finally { inFlight=false } })）。

**`applySessionReply(record: SessionRecord)`（私有，异步）**：

- **透传语义（决策 #1，冻结）**：`response = record.reply` 原样（"once"|"always"|"reject"），不映射、不校验（parse 已保证合法）。
- 调用参数：`sessionID = record.session_id`、`permissionID = record.request_id`（SDK 签名见 §13.8）。
- **成功**（API resolve）→ `await this.registry.mutate((reg) => markSessionResolved(reg, record.request_id))`；mutate 返回 undefined（抢锁超时/记录消失）→ logWarn，下轮重试（resolved 未置位属安全重试态）。
- **失败/抛错** → logWarn（token 脱敏）+ **不置位**（resolved 保持 false），下轮 ticker 重试（决策 #5 / API-104①）。
- **双路径跳过（API-104②）**：筛选已排除 resolved；若 read→apply 窗口内另一实例/TUI 事件先置 resolved，本实例 API 调用会以「已决」失败被捕获 → logWarn → 下轮读到 resolved=true 即跳过。不额外做窗口内二次读盘。
- **竞态收敛（决策 #10 解读，冻结）**：同项目多实例同时扫到同一 reply 都尝试 apply——二次 reply 在 opencode 端失败被捕获（logWarn）后**不强制置位**；resolved=true 由「胜者实例 apply 成功置位」或「任一实例 permission.replied 事件路径（§5.3）」收敛，败者下轮跳过。**不引入认领机制**（保持简单）。

### 13.7 `src/monitor.ts` 编辑区间分配（Round 2，supersede §7 本轮范围）

| Phase | 独占编辑区间（当前行号，参考） | 内容 |
|---|---|---|
| 1.2 | 48-60 区（`./format/format` import 块，`buildMenuKeyboard` 处） | 追加 `buildSessionPermissionKeyboard` 导入 |
| 1.2 | 1534-1578（`scanSessionQueue` 函数体） | 发送条件追加 `reply == null`；permission 记录改 `sendMessageWithKeyboard` + 键盘构建；`permissionEntryID` 调用 |
| 1.2 | 1833-1911（`handleCallback` + `answerCallback` 区） | perm 前置分支；`permShortMap` 消费；`editPermissionResultMessage` 新增（放 handleCallback 近旁） |
| 1.2 | `src/types.ts` 88-96（`TelegramCallbackQuery.message`） | 追加 `text?: string` |
| 1.2 | `src/format/format.ts`（独立文件，1.2 独占） | `PERM_CB_PREFIX` + `buildSessionPermissionKeyboard` |
| 1.3 | 140-146 区（字段声明区） | `replyScanTimer` / `replyScanInFlight` |
| 1.3 | 158-169（`initialize`） | 末尾追加 `this.startReplyScan();` |
| 1.3 | 412-443（`dispose`） | 追加 `clearInterval(replyScanTimer)`（与 registerTimer/selfUpdateTimer 同区） |
| 1.3 | 1524-1526（`stopSessionsScan` 之后、`scanSessionQueue` JSDoc 之前的空白区） | 新增 `startReplyScan` / `stopReplyScan` / `scanReplyQueue` / `applySessionReply` |

- 交集为零；两 phase 各自新私有方法落在自有区间。
- 1.2 不得触碰 140-146 / 158-169 / 412-443 / 1524-1526；1.3 不得触碰 import 区、1534-1578、1833-1911、`src/types.ts`、`src/format/format.ts`、`src/registry/index.ts`（registry 全部归 1.1）。
- **1.2 的 `permShortMap` 字段**（以及 `permissionEntryID`/`editPermissionResultMessage` 方法）一律落在 1.2 区间内声明——字段可置于 scanSessionQueue 或 handleCallback 近旁（类内字段声明合法），**不得放进 140-146 字段区（1.3 地盘）**。
- 行号为冻结时参考，漂移 ±数行以函数名界定为准。

### 13.8 SDK 签名核验（Phase 1.3 先行任务，冻结）

- 环境事实：本机 opencode 安装存在（`~/.opencode/bin/opencode`，目标 1.18.23），`~/.cache/opencode` 存在——**核验可行，1.3 必须先做**。
- 核验路径：在本机 opencode 安装里定位 `@opencode-ai/sdk` 的 `types.gen.d.ts` / `sdk.gen.ts`，确认 permission reply 的精确方法名与参数形状（`path.id` / `path.permissionId` / `body.response` vs `body.reply`、返回类型）。
- **兜底形态（核验失败或名称分歧时采用，并在任务报告标注「推测」）**：
  ```ts
  await this.client.session.postSessionByIdPermissionsByPermissionId({
    path: { id: record.session_id, permissionId: record.request_id },
    body: { response: record.reply },
  });
  ```
- 核验结果（精确签名 / 与兜底差异）必须写入 1.3 任务报告；本契约以核验后结果为准，§13.8 为冻结兜底基线。

### 13.9 测试编号与同文件追加锚点契约（supersede §8 新增编号）

| 编号 | 定义 | 文件 | 维护 phase |
|---|---|---|---|
| REG-201 | reply 往返（缺失/null/三值/非法容错）+ `setSessionReply` 三态（写入/无匹配 undefined/幂等原引用） | `tests/registry-sessions.test.mjs`（追加，文件尾） | 1.1 |
| API-101 | permission 发送带三按钮（data `otg:perm:<req>:<once\|always\|reject>`）；question 发送**无**键盘 | `tests/sessions-poller.test.mjs` | 1.2 |
| API-102 | 回调三值写入 + answer 文案 + 编辑（键盘移除+结果行）+ 非法 chatId 拒绝 + 无匹配记录失败分支 | `tests/sessions-poller.test.mjs` | 1.2 |
| API-103 | 消费端 apply：stub reply API 断言透传（sessionID/requestID/response）→ resolved=true；reply=null 或已 resolved 不触发 | `tests/sessions-poller.test.mjs` | 1.3 |
| API-104 | ①apply 失败保持 false、下轮重试成功 ②TUI 先置位（resolved=true）→ 跳过不调 API ③poller 对 reply!=null 未发送记录不发送（防御条件联动 1.2） | `tests/sessions-poller.test.mjs` | 1.3 |
| API-105 | 结构化渲染（Round 2.1）：permission 记录 message JSON 解析 → 渲染含 Permission/Pattern/Title 行、不含 `{` 开头 JSON dump；非法 JSON / 合法但无可识别字段 → 退回 300 字符原文节选；question 记录渲染不变 | `tests/sessions-poller.test.mjs`（尾部追加，§13.11） | 2.1 |

**同文件追加锚点规则（防合并冲突，经 git 3-way 合并实测：同锚点追加 ⇒ CONFLICT；不同锚点追加 ⇒ 自动干净合并）**：

- **1.2 区块**：插在 **API-006-5 用例收尾 `);` 之后**（现 327 行后、`await rm(baseDir, ...)` 之前）；区块头注释 `// ---- Phase 1.2 (API-101/102) ----`。
- **1.3 区块**：插在 **API-006-2 用例收尾 `);` 之后**（现 206 行后、`// API-006-3` 注释之前）；区块头注释 `// ---- Phase 1.3 (API-103/104) ----`。
- **1.3 独立编辑点**：`fakeClient`（44-51 区）追加 reply stub 方法（方法名以 §13.8 核验结果为准）；此点与两区块互不相邻。
- 定位以「紧跟指定既有用例的收尾 `);`」为准（锚定用例名/注释，不锚定行号）；**两区块之间必须保留至少一个既有用例作间隔**。
- **用例纪律（自包含 + 终态）**：每个新用例独立 append 自己的记录并独立断言；结束时记录处于终态（send=true 或 resolved=true；仅 API-104③ 允许遗留 reply!=null 且 unresolved 的记录——新筛选保证它被永久跳过，不影响任何后续用例计数）。不得依赖执行顺序，不得改动其它用例的记录。
- 既有 API-006 用例**零改动**；发送条件变更后 API-006 回归兼容由 1.2 验收保证。

### 13.10 明确不做（Round 2 补充）

- 不做 question 记录按钮/回写（决策 #2，后续轮）。
- 不引入认领机制；不持久化 permShortMap（§13.4/§13.6）。
- 不改 mutate/锁/缓存/serialized（projects-registry.md §3/§4 保持零改动）；不改 PollerLock/SharedFileStore。
- `src/constants.ts` 零新增（决策 #9；PERM_CB_PREFIX 放 format.ts）。
- 不改 `formatSessionRecordMessage` 文本；不改 `enqueueMessageWithKeyboard`/`sendMessage` 本体（发送通道只新增 sendMessageWithKeyboard 调用点）。
  **（Round 2.1 supersede：「不改 formatSessionRecordMessage 文本」不再成立——该函数体由 Phase 2.1
  修改为结构化渲染（§13.11）；「不改 enqueueMessageWithKeyboard/sendMessage 本体」仍成立。）**
- 不做 TG 侧的 question 应答通道；不新增 Telegram 命令（`/sessions` 等仍为 PLANNED_COMMANDS）。

### 13.11 结构化渲染：permission 记录字段行（Round 2.1 冻结）

> 计划: docs/todos/tg-permission-buttons.md Phase 2.1（修复轮）。
> **本轮修改 `formatSessionRecordMessage`（src/monitor.ts 1791-1810）方法体本身**——
> 上轮 §6.2/§13.3 对 permission 记录描述为「message 原文节选」，现 supersede 为
> 「解析 message JSON 后的结构化字段行」；**发送通道（scanSessionQueue →
> sendMessage/sendMessageWithKeyboard）、键盘构建（§13.3/§13.4）、筛选条件（§13.3
> `reply == null`）、消费端（§13.6）与 question 记录渲染全部零变化**。

**触发（冻结）**：

- 结构化路径**只对 `type === "permission"` 生效**；`type === "question"` 记录渲染不变
  （恒为 message 原文节选，见下「fallback」同款 paragraph，300 字符）。
- 结构骨架不变：`titleLine(iconForWaitingType(record.type), 项目label)` +
  `fieldTable(rows)` + （结构化行 | 节选），整体 `limitMessage` 截断（⚠️ 图标 + 项目名开头）。

**渲染流程（冻结）**：

1. `try { parsed = JSON.parse(record.message) } catch { → fallback }`。
2. `parsed` 非普通对象（null/数组/非 object）→ fallback。
3. 基础行恒输出（来自 record 字段，不经 parsed）：`Type`（record.type）、
   `Session`（session_name || shortID(session_id)，safeText 100）。
4. 结构化行（来自 parsed，宽松渲染——字段缺失/类型不符即跳过该行，不抛错）：

| 行标签 | 取值来源（按事件类型，本机 SDK v2 `types.gen.d.ts` 核验） | 输出条件 |
|---|---|---|
| `Permission` | `parsed.permission`（permission.asked，string）→ `parsed.action`（permission.v2.asked，string）→ `parsed.type`（permission.updated，string） | 值为 string（如 external_directory） |
| `Pattern` | `parsed.patterns`（permission.asked，Array<string>）→ `parsed.resources`（permission.v2.asked，Array<string>）→ `parsed.pattern`（permission.updated，string\|Array<string>） | 数组逐项或安全拼接展示，safeText 截断 |
| `Title` | `parsed.title`（permission.updated，string；asked/v2.asked **无此字段**） | 值为 string（人类可读摘要行） |

- 事件 payload 实形（核验依据，SDK v2）：
  - `permission.asked` properties：`{ id, sessionID, permission: string, patterns: Array<string>, metadata, always, tool? }`；
  - `permission.v2.asked` properties：`{ id, sessionID, action: string, resources: Array<string>, save?, metadata?, source? }`；
  - `permission.updated` properties = `Permission`：`{ id, type: string, pattern?: string|Array<string>, title, sessionID, messageID, callID?, metadata, time }`；
  - question 类 properties 无 permission/patterns/title 可识别字段 → 天然走 fallback。

**fallback（冻结）**：`JSON.parse` 抛错、parsed 非对象、或 Permission/Pattern/Title
**三行均无输出**（无可展示字段）→ 退回原行为：`paragraph(safeText(record.message, 300, ctx))`
（message 原文节选，300 字符，与 question 记录同款）。**不得**在 fallback 时抛错中断发送链。

**测试锚点（API-105，追加到 §13.9）**：

- 合成 permission 记录（message 含 permission/patterns/title 的 JSON）→ 断言渲染含
  Permission/Pattern/Title 行、**不含** `{` 开头的 JSON dump；
- message=非法 JSON → 断言退回原文节选（含截断 JSON 文本）；
- message=合法 JSON 但无可识别字段（如 `{}`）→ 断言退回原文节选；
- 回归：API-006/101/102 既有断言仍绿（question 节选断言、键盘断言不受影响）；
  若既有用例断言了 permission 的 JSON 节选文本，允许**最小**修正相关断言行并在报告注明。

**编辑区间（Round 2.1）**：

- `src/monitor.ts`：**仅 `formatSessionRecordMessage` 方法体（1791-1810）**；不得触碰
  发送链（scanSessionQueue 1600-1618 附近/sendMessage*/handleCallback 2200+ 附近）、
  registry、format.ts 键盘函数、`src/types.ts`。
- `tests/sessions-poller.test.mjs`：尾部追加 API-105 区块（分节注释
  `// ---- API-105: structured rendering (round 2) ----`），单 phase 无合并冲突顾虑。
- **发送通道与键盘契约零变化**：permission 记录仍走 sendMessageWithKeyboard 三按钮（§13.3），
  回调/回写/消费端（§13.4~§13.6）不受渲染改动影响。

### 13.12 单表渲染修订：Type/Session/Permission/Pattern 同一张 fieldTable（Round 3 冻结）

> 计划: docs/todos/permission-pattern-table.md（其 Round 1；本模块契约序列 Round 3）。
> **本小节 supersede §13.11 的渲染规则与编辑区间**（差异记录见 §11）：permission 记录的结构化渲染
> 由「Type/Session 表 + Permission/Pattern/Title 表（两张）」改为**单张 fieldTable**（
> Type/Session/Permission/Pattern N 全部同表），**移除 Title 行**，Pattern 逐行编号，结构化值改用
> **keep-paths 脱敏**（`safeTextKeepPaths`，真实路径可见）；fallback 与 `limitMessage` 保持。
> 发送通道（scanSessionQueue → sendMessage/sendMessageWithKeyboard）、键盘构建（§13.3/§13.4）、
> 筛选条件（§13.3 `reply == null`）、消费端（§13.6）与 question 记录渲染全部零变化。

**触发（冻结）**：

- 结构化路径仍只对 `type === "permission"` 生效；`type === "question"` 记录渲染不变
  （恒为 message 原文节选，paragraph，300 字符）。
- 结构骨架不变：`titleLine(iconForWaitingType(record.type), 项目label)` + **单张**
  `fieldTable(rows)` + （结构化行 | 节选），整体 `limitMessage` 截断（⚠️ 图标 + 项目名开头）。

#### 13.12.1 Phase 1.1 契约：`safeTextKeepPaths`（src/format/redact.ts 新增导出，冻结）

```ts
export function safeTextKeepPaths(
  value: string,
  limit: number,
  ctx: RedactionContext,
): string
```

- **密钥/token 脱敏链与 `safeText` 完全一致**（逐条原样、顺序不得变，均已在 redact.ts 现有链中）：

| # | 规则 | 替换为 |
|---|---|---|
| 1 | `-----BEGIN ...PRIVATE KEY\|CERTIFICATE----- ... -----END ...-----`（PEM 块） | `[REDACTED_KEY]` |
| 2 | `ctx.botToken`（`replaceAll`） | `[REDACTED]` |
| 3 | `\b\d{6,}:[A-Za-z0-9_-]{20,}\b`（TG token 形态） | `[REDACTED]` |
| 4 | `\bBearer\s+[A-Za-z0-9._~+/=-]{8,}` | `Bearer [REDACTED]` |
| 5 | `\b(?:sk-(?:ant-)?\|gh[pousr]_)[A-Za-z0-9_-]{12,}\b`（sk-/ghp_ 等） | `[REDACTED]` |
| 6 | `\b(?:github_pat_\|npm_\|hf_)[A-Za-z0-9_-]{16,}\b` | `[REDACTED]` |
| 7 | `\b(?:glpat-\|xox[baprs]-\|pypi-)[A-Za-z0-9_-]{12,}\b` | `[REDACTED]` |
| 8 | `\bAIza[A-Za-z0-9_-]{30,}\b`（Google） | `[REDACTED]` |
| 9 | `\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`（JWT） | `[REDACTED]` |
| 10 | `\bAKIA[A-Z0-9]{16}\b`（AWS） | `[REDACTED]` |
| 11 | `\b[A-Z0-9_]*(?:API[_-]?KEY\|ACCESS[_-]?KEY\|PRIVATE[_-]?KEY\|PASSWORD\|PASSWD\|SECRET\|TOKEN\|AUTHORIZATION\|CREDENTIALS\|COOKIE)[A-Z0-9_]*\b\s*[:=]\s*[^\s,;]+`（KEY=xxx） | `[REDACTED_SECRET]` |
| 12 | `\b(?:https?\|postgres(?:ql)?\|mysql\|mongodb(?:\+srv)?\|redis\|amqp):\/\/\S+`（URL） | `[REDACTED_URL]` |

- **跳过三条路径类规则**（与 `safeText` 的唯一差异点，**全部跳过**）：
  1. `ctx.root` → `<project>` 替换；
  2. 绝对路径 `(^|[\s=:"'(])\/(?:[^\s/]+\/)*[^\s,;)]*` → `<external-path>`；
  3. `\b[A-Za-z0-9_+/=-]{40,}\b` → `[REDACTED_VALUE]`——该规则字符类含 `/`，40+ 字符的绝对路径
     会被整段误杀（用户痛点根因），必须跳过。
- **空白折叠**（`\s+` → `" "`）、`trim()`、**limit 截断**（`length <= limit` 原样，否则
  `slice(0, limit - 3) + "..."`）与 `safeText` 完全一致。
- **既有导出零行为变化**：`safeText`/`safePath`/`safeToolTarget`/`safeProgress` 不得改动；
  允许抽私有共享 helper 复用密钥链（1-12），但**规则与顺序不得变**；路径类三条只在
  `safeText` 内保留。
- **barrel**：`src/format/index.ts` 已 `export * from "./redact"`，新导出自动可用，**index.ts
  零改动**；monitor.ts 仅 import 块追加一个导入名（1.2 地盘）。

#### 13.12.2 Phase 1.2 契约：`formatSessionRecordMessage` 新渲染（src/monitor.ts 1794-1859）

渲染流程（冻结）：

1. `try { parsed = JSON.parse(record.message) } catch { → fallback }`。
2. `parsed` 非普通对象（null/数组/非 object）→ fallback。
3. **行序（rows 数组顺序冻结，全部进同一张 `fieldTable(rows)`）**：
   - `Type`：`record.type`（fieldRow 直出，不经脱敏——字面量 `"permission"`/`"question"`）。
   - `Session`：`safeText(record.session_name || shortID(record.session_id), 100, ctx)`（原样）。
   - `Permission`（宽松跳行）：来源 `parsed.permission ?? parsed.action ?? parsed.type`；
     值为 string 才输出；值 = `safeTextKeepPaths(value, 300, ctx)`。
   - `Pattern` 行（宽松跳行，**逐项单独一行**）：来源
     `parsed.patterns ?? parsed.resources ?? parsed.pattern`；数组归一
     （`Array.isArray ? arr : [arr]`，仅保留 string 项），逐项一行：
     - 恰 1 项 → 标签 `Pattern`；
     - ≥2 项 → 标签 `Pattern 1` / `Pattern 2` / …（从 1 起，按数组序）；
     - 每项值 = `safeTextKeepPaths(item, 300, ctx)`。
   - **`Title` 行移除**：`parsed.title` 不再渲染（决策 #2），也不参与「有无输出」判定。
4. 单表输出：`fieldTable(rows)` 一张（Type/Session/Permission/Pattern N 全在其中）。

fallback（冻结，supersede §13.11 fallback 的判定口径）：`JSON.parse` 抛错、parsed 非对象、
或 **Permission 与 Pattern 行均无输出**（无可展示字段）→ 在单表**之后**追加
`paragraph(safeText(record.message, 300, ctx))`（message 原文节选，300 字符，**路径脱敏照旧**
——fallback 走 `safeText` 而非 `safeTextKeepPaths`）。**不得**在 fallback 时抛错中断发送链。

question 记录：渲染零改动（恒为 message 原文节选 paragraph，300 字符，`safeText`）。

整体：`parts = [titleLine(iconForWaitingType(record.type), projectLabel), fieldTable(rows), body]`
`join("\n")` 后经 `limitMessage`（不变）。

#### 13.12.3 测试编号契约（supersede §13.9 维护归属）

| 编号 | 定义 | 文件 | 维护 phase |
|---|---|---|---|
| REDACT-001 | keep-paths：绝对路径 `/a/b/c.ts` 与 45 字符长路径**原样保留**，无 `<external-path>`/`<project>`/`[REDACTED_VALUE]` | `tests/redact-keep-paths.test.mjs`（新建） | 1.1 |
| REDACT-002 | keep-paths：botToken 与 `sk-xxx` 密钥仍被 `[REDACTED]`（密钥链与 safeText 一致） | 同上 | 1.1 |
| REDACT-003 | keep-paths：limit 截断加 `...` 尾，与 safeText 行为一致 | 同上 | 1.1 |
| API-105（更新） | 单表渲染：permission 记录（多 patterns）→ **恰 1 个 `<table`**、`Permission` 行、`Pattern 1`/`Pattern 2` 编号行、单 pattern 标签 `Pattern`、**无 Title 行**、无 `{` 开头 JSON dump；非法 JSON / `{}` → 退回原文节选（无结构化行） | `tests/sessions-poller.test.mjs`（API-105 区块更新，§13.12.4） | 1.2 |
| API-106（新增） | 真实路径：pattern 为绝对路径 + 45 字符长路径 → **原样出现**，无 `<external-path>`/`<project>`/`[REDACTED_VALUE]` | `tests/sessions-poller.test.mjs`（尾部追加，§13.12.4） | 1.2 |

- **既有断言最小修正规则**：API-105-1 的 Title 断言（`includes("Title")` /
  `includes("Allow access to external directory")`）必须移除/改判（Title 行已删）；其余既有
  API-006/101~104 断言若受单表化影响，允许**最小**修正并在任务报告注明；API-006-5 的
  Type/Session 存在性断言不受影响。
- REDACT 单测可直接 `bun tests/redact-keep-paths.test.mjs`（behavior.test.mjs 先例：直接
  import src TS，无需 HOME 隔离）；sessions-poller 仍 `HOME=$(mktemp -d) bun ...`。

#### 13.12.4 编辑区间分配（防合并冲突，冻结；两 phase 文件集零交集）

| Phase | 独占文件/区间 | 内容 |
|---|---|---|
| 1.1 | `src/format/redact.ts`（新增导出 + 可选私有共享 helper） | `safeTextKeepPaths`；既有导出零改动 |
| 1.1 | `tests/redact-keep-paths.test.mjs`（新建文件） | REDACT-001~003 |
| 1.2 | `src/monitor.ts` import 块（48-82 区，`./format` 命名导入） | 追加 `safeTextKeepPaths` 导入名一行 |
| 1.2 | `src/monitor.ts` `formatSessionRecordMessage` 方法体（1794-1859） | 单表渲染重写（§13.12.2） |
| 1.2 | `tests/sessions-poller.test.mjs`（API-105 区块 907-1001 + 尾部追加） | API-105 更新 + API-106 新增 |

- 1.1 不得碰 monitor.ts / sessions-poller.test.mjs；1.2 不得碰 redact.ts。
- 行号为冻结时参考，随实现漂移 ±数行以函数名/区块界定为准。

#### 13.12.5 明确不做（Round 3 补充）

- 不新增/删除任何密钥类脱敏规则（仅路径类差异）；不碰发送通道/键盘/筛选/消费端（§13.3~§13.6）。
- 不改 `html.ts`（fieldRow/fieldTable/titleLine 原样复用）；不改 `constants.ts`。
- 不做 question 记录单表化（保持原文节选）；不做 fallback 走 keep-paths（路径脱敏照旧）。

## 14. Round 4 扩展：question 请求 TG 交互向导（选项 + 自定义输入 + 持久化状态机）（冻结 2026-09-02）

> 计划: docs/todos/question-tg-wizard.md。批次 A = [1.1（registry）] → 批次 B = [1.2（发送端）, 1.4（消费端）] → 批次 C = [1.3（回调向导）]。
> 本文件仍是 sessions 中继子系统的唯一权威契约；本章在 §2/§4/§6/§8/§13 之上追加扩展，supersede 记录见 §11。
> **supersede §13.10「不做 question 记录按钮/回写（后续轮）」——本轮正是那轮**：question 记录实现 TG 交互向导——
> 选项按钮 + 多选 toggle + 自定义输入 + 导航 + 总结确认，交互对齐 TUI；**向导状态全部持久化 projects.json**
> （注册表纯函数读写，不靠内存，进程重启后点旧按钮从盘上重建状态）；确认后由**拥有该 session 的 opencode 实例**
> 调官方 question reply/reject API 回传。**permission 链路（§13 全部）零改动**。插件绝不擅自代答：只有用户在 TG
> 显式点击/输入才触发回传。

### 14.1 registry：向导状态字段 + 纯函数（Phase 1.1，冻结）

#### 14.1.1 `SessionRecord` 追加 6 个可选字段（supersede §2/§13.1 类型定义）

在 §13.1 类型上追加（其余字段及语义不变；定义位置 `src/registry/index.ts` SessionRecord，24-34）：

```ts
export type SessionRecord = {
  // ...（§2 既有 8 字段 + §13.1 reply）
  q_draft?: Array<Array<string>>;   // 草稿答案：长度=questions 数；每题=已选 label 数组；未答=空数组
  q_stage?: number;                 // 当前题索引 0-based；=questions.length 表示总结阶段
  q_input?: number | null;          // 待自定义输入题索引；显式 null=无输入态
  q_answers?: Array<Array<string>>; // 最终提交答案（每题=label/文本数组，透传不映射）；消费端 reply 触发器
  q_reject?: boolean;               // 放弃标记（true=用户取消整个向导）；消费端 reject 触发器
  q_msg_id?: number;                // TG 向导消息 message_id（poller 发送成功后回写，供编辑）
};
```

- **写入端初始不设置任何 q_\* 键**（记录保持「缺失」态；`q_answers == null` 与 `q_reject !== true` 对缺失键恒成立——旧记录天然兼容）。
- **字段间独立**（与 §4.2 冻结理由一致）：置 q_answers/q_reject 不改 send/resolved/reply；各 q_* 字段各自独立，只由各自置位方消费。
- **生命周期（冻结）**：发送初始消息 → q_msg_id 回写 → 向导交互（q_draft/q_stage/q_input 演变）→ 终态二选一：q_answers 写入（submit）或 q_reject=true（cancel）→ 消费端 apply（§14.4）成功后 resolved=true。resolved 后 q_* 冻结不再清理（不做回收）。

#### 14.1.2 `parseSessionRecord` 白名单扩展（逐字段容错冻结，1.1）

在现有校验（95-137）上追加 6 字段，与 §13.1 同款「缺失/null/合法/非法」四态：

| 字段 | 键**缺失** | 显式 `null` | 合法值 | 非法值（类型/结构不符） |
|---|---|---|---|---|
| `q_draft` | 构造记录**不含该键**（serialize 自动省略 → 旧文件往返不新增键） | 丢弃整条记录 | `Array.isArray` 且每项为 `Array` 且元素全为 string | **丢弃整条记录**（不抛错、不影响其它记录，§3.2 严格白名单同款） |
| `q_stage` | 不含键 | 丢弃整条记录 | `typeof === "number"`（**不校验范围/整数性**——非法值由 §14.3.1 状态重建钳制） | 丢弃整条记录 |
| `q_input` | 不含键 | `q_input: null`（JSON null 保留 = 显式无输入态） | `typeof === "number"` | 丢弃整条记录 |
| `q_answers` | 不含键 | 丢弃整条记录 | 同 q_draft 结构 | 丢弃整条记录 |
| `q_reject` | 不含键 | 丢弃整条记录 | `typeof === "boolean"` | 丢弃整条记录 |
| `q_msg_id` | 不含键 | 丢弃整条记录 | `typeof === "number"` | 丢弃整条记录 |

- 既有 9 字段（8 基础 + reply）校验**零改动**；q_* 校验紧随 reply 之后追加，构造记录时按「有值才赋键」模式（同 reply）。

#### 14.1.3 纯函数（5 个主函数 + 1 个辅助，1.1 新增，冻结）

位置：`src/registry/index.ts` 纯函数区（`setSessionReply` 285-308 之后、`markSessionFlag` 310 之前）。

统一语义（与 §4.2/§13.2 完全一致）：**全局 request_id 精确匹配**（跨全部条目找第一条，顺序 = projects 数组序 + sessions 数组序）；**无匹配 → 返回 `undefined`**（调用方透传 mutate → 不写盘、不抛错）；**匹配且目标字段与入参完全一致 → 返回原 registry 引用**（幂等，mutate 短路不写盘）；**需变更 → 返回新 registry，仅改本函数目标字段**（send/resolved/reply 及其它 q_* 不动）；返回必须是新对象引用。

```ts
// 写草稿 + 阶段（选项点击/导航/自定义输入写入共用；draft 与 stage 都为完整新值）
export function setQuestionDraft(
  registry: ProjectRegistry,
  requestID: string,
  draft: Array<Array<string>>, // 长度=questions 数
  stage: number,               // 0..questions.length；=length 为总结阶段
): ProjectRegistry | undefined

// 写/清自定义输入态（index=题索引；null=清除）
export function setQuestionInput(
  registry: ProjectRegistry,
  requestID: string,
  index: number | null,
): ProjectRegistry | undefined

// 最终提交（消费端 reply 触发器；answers 原样透传不校验）
export function submitQuestionAnswers(
  registry: ProjectRegistry,
  requestID: string,
  answers: Array<Array<string>>,
): ProjectRegistry | undefined

// 放弃整个向导（消费端 reject 触发器；置 q_reject=true）
export function rejectQuestion(
  registry: ProjectRegistry,
  requestID: string,
): ProjectRegistry | undefined

// 回写向导消息 message_id（poller 发送成功后）
export function setQuestionMessageID(
  registry: ProjectRegistry,
  requestID: string,
  messageID: number,
): ProjectRegistry | undefined
```

辅助函数（`/cancel` 批量清除用，仍由 1.1 实现；同上三态语义但**不返回 undefined**）：

```ts
// 清除全部记录的 q_input（无任何变更 → 原引用；有变更 → 新 registry）
export function clearQuestionInputs(registry: ProjectRegistry): ProjectRegistry
```

验收：REG-301（6 字段往返容错 + 5 函数三态「无匹配 undefined / 幂等原引用 / 只改目标字段」+ clearQuestionInputs 批量断言）；REG-101/201 与 LOCK-001~005 回归全绿。

### 14.2 发送端：question 初始消息渲染 + 键盘（Phase 1.2，冻结）

#### 14.2.1 format.ts 新导出（format.ts 本轮 1.2 独占）

```ts
export const OTG_Q_CB_PREFIX = "otg:q:"; // 放 format.ts（PERM_CB_PREFIX 286 旁；constants.ts 保持零新增，§13.3 决策 #9 同款）

export function buildQuestionStageText(
  projectLabel: string,
  type: "question",
  sessionLabel: string,       // 调用方已处理脱敏/短 ID（safeText(record.session_name || shortID(...), 100, ctx)）
  questions: Array<QuestionV2Info>, // 解析自 record.message（SDK 形状：{question, header, options: Array<{label, description}>, multiple?, custom?}）
  stage: number,              // 0..questions.length；=length 为总结阶段
  draft: Array<Array<string>>,// 长度=questions.length；每题=已选 label 数组；未答=空数组
  inputPending: boolean,      // q_input != null（输入模式提示行）
  ctx: FormatContext,         // 脱敏上下文（safeTextKeepPaths 必需）
): string
```

- 结构：`titleLine(iconForWaitingType("question"), projectLabel)` + **单张 fieldTable(rows)**（⚠️ 图标 + 项目名开头骨架不变）+ 整体 `limitMessage` 截断；rows 行序冻结：
  - `Type` → `type` 字面量 `"question"`（不经脱敏，同 §13.12.2）；
  - `Session` → `sessionLabel`；
  - **非总结阶段**（`stage < questions.length`）：
    - `Question m/n` → `${stage + 1}/${questions.length}`；
    - `Header` → `questions[stage].header`（宽松跳行：值为 string 才输出）；值 = `safeTextKeepPaths(header, 300, ctx)`；
    - 问题文本行（标签冻结 `Question`？不——问题文本与 Question m/n 合并为一行 `Question m/n` → 文本？任务要求「Question m/n/Header/问题文本/选项行」——冻结：`Question m/n` 行值 = 问题文本；`Header` 单独行。即：
      - `Question m/n` → `${questions[stage].question}`（`safeTextKeepPaths(question, 300, ctx)`——**问题文本含路径时显示真实路径**，沿用 Round 3 keep-paths 决策）；
      - 选项行逐项（`questions[stage].options ?? []`，宽松跳行）：每选项一行，标签为 `Option N`（N 从 1 起），值为 `${safeTextKeepPaths(label, 200, ctx)}${description ? " — " + safeTextKeepPaths(description, 200, ctx) : ""}`；**多选且该选项已选** → 前缀 `✅ `（`✅ ${label}`）；
  - **总结阶段**（`stage === questions.length`）：每题一行 `Question m/n` → 值 = 已选答案 `labels.join("、")`（经 `safeTextKeepPaths`）或 **`（未答）`** 标注；不输出选项行；
  - **输入模式提示行**（`inputPending === true` 时追加）：`fieldRow("输入", "✏️ 回复文本作为答案，/cancel 取消")`。
- 任务签名补充说明：任务描述要求问题文本/答案经 `safeTextKeepPaths` 显示真实路径——脱敏需要上下文，故完整签名带 `ctx: FormatContext`（与 formatStatus/formatTerminalNotification 惯例一致，§13.12.1 同款）。

```ts
export function buildQuestionKeyboard(
  entryID: string,
  questions: Array<QuestionV2Info>,
  stage: number,
  draft: Array<Array<string>>,
): TelegramInlineKeyboard
```

- 行序冻结（返回 `{ inline_keyboard: rows }`，复用 `TelegramInlineButton`/`TelegramInlineKeyboard`）：
  1. **选项行**（`questions[stage].options ?? []` 逐项按钮，单行内平铺）：callback_data 统一 `${OTG_Q_CB_PREFIX}${entryID}:o${idx}`（idx = 选项数组 0-based 下标）；text = **多选**（`multiple === true`）且已选 → `✅ ${label}`，否则 `label`；
  2. **custom 行**（**Round 2 修订：恒显示**，§14.8.4 supersede——原「仅当
     `questions[stage].custom === true`」条件移除；有 current 即渲染）：
     `[{ text: "✏️ Custom", callback_data: `${OTG_Q_CB_PREFIX}${entryID}:custom` }]`；
   3. **导航/提交行**：
      - 多问题请求（`questions.length > 1`）非总结：`[⬅️ Prev](:prev)` `[➡️ Next](:next)` `[❌ Cancel](:cancel)`；
      - 多问题请求总结阶段（`stage === questions.length`）：**（Round 2 修订：加 ⬅️ Prev，§14.8.5 supersede）**
        `[⬅️ Prev](:prev)` `[✅ Submit](:submit)` `[❌ Cancel](:cancel)`；
      - **单问题请求（`questions.length === 1`）单选**：**无导航无提交按钮**——只有选项行（+custom 行若有）+ `[❌ Cancel](:cancel)`（点选项直接提交形态，决策 #6）；
      - **单问题请求多选（`multiple === true`，Phase 1.5 修订）**：选项行（toggle）+（custom 行若有）+ `[✅ Submit](:submit)` + `[❌ Cancel](:cancel)`——多选 toggle 不自动提交，须显式 Submit（TUI 对齐：space 切换、enter 提交；否则该形态无提交路径的功能死角）。
- `entryID` 由调用方（monitor）保证回调 ASCII 且 ≤ 64 字节（§14.2.3）；函数本身不做长度断言（同 §13.3）。

#### 14.2.2 scanSessionQueue question 分支（1.2 地盘 1679-1740，冻结）

- 现 question 记录走 `await this.sendMessage(text)` 原文节选（无键盘）→ 本轮改为向导发送，行为序列：
  1. `try { parsed = JSON.parse(record.message) }` → `questions = parsed?.questions`；**宽松防御（冻结）**：解析抛错、parsed 非对象、`questions` 非数组、或首元素缺 string 型 `question` → **退化**为既有行为 `await this.sendMessage(text)`（原文节选发送，无键盘、不置 q_msg_id）——问题记录永远可达，防御不中断；
  2. 渲染：`text = buildQuestionStageText(projectLabel, "question", sessionLabel, questions, 0, draft0, false, ctx)` + `keyboard = buildQuestionKeyboard(entryID, questions, 0, draft0)`（`draft0 = questions.map(() => [])`；`sessionLabel = safeText(record.session_name || shortID(record.session_id), 100, ctx)`）；
  3. `entryID = this.questionEntryID(record.request_id)`；`undefined`（超限兜底 §14.2.3）→ 退化为 `sendMessage(text)` 无键盘（同 §13.4 兜底）；
  4. `const messageID = await this.sendMessageWithKeyboard(text, keyboard)` → **messageID 非 undefined** → `registry.mutate((reg) => setQuestionMessageID(reg, record.request_id, messageID))`；undefined（响应无 message_id）→ logWarn 一次不中断（后续编辑退化为 `callback.message.message_id` 兜底，§14.3.1）；
  5. 发送成功判定不变 = sendMessageWithKeyboard resolve（同 §13.3）；抛错 → 不置位、下轮重试（既有 try/catch 保持）；成功后才 `markSessionSent`（既有流程不变）。
- **发送条件追加（supersede §13.3 条件，冻结）**：跳过条件改为 `record.send || record.resolved || record.reply != null || record.q_answers != null || record.q_reject === true`。语义：已提交（q_answers）/已放弃（q_reject）的未发送记录**永不发送初始消息**（走消费端 apply，§14.4）；对 permission 记录 q_* 恒空（无键 → == null / !== true），permission 语义**零变化**。
- `formatSessionRecordMessage`（1794-1859）**零改动**——question 渲染完全由 scanSessionQueue 新分支接管，不再进该函数（其内部 question 节选路径保留为防御 dead code，不删不改）。

**`sendMessageWithKeyboard` 最小扩展（1.2 独占方法体 2328-2338，冻结）**：

- 现状已核验：返回 `Promise<void>`（telegramWithRetry 结果被丢弃）。扩展为返回 message_id：
  ```ts
  private async sendMessageWithKeyboard(
    text: string,
    replyMarkup: TelegramInlineKeyboard,
  ): Promise<number | undefined> // 响应 result.message_id；无则 undefined
  ```
- 实现：`const response = await telegramWithRetry<{ result?: { message_id?: number } }>("sendRichMessage", {…}, ctx)` → `return response?.result?.message_id`。
  **（Round 2 修订：§14.8.3 supersede 此返回解析**——防御三形态
  `result?.message_id ?? result?.message?.message_id ?? result?.messageId` + 首次 dline 键名诊断；语义不变）
- 既有调用点（permission 键盘发送）忽略返回值，兼容；测试 stub 同步改为可返回 message_id。

#### 14.2.3 questionEntryID / qShortMap（1.2，冻结）

- `private qShortMap = new Map<string, string>();` + `private questionEntryID(requestID: string): string | undefined`：与 `permissionEntryID`（1759-1783）**同构**——`full = OTG_Q_CB_PREFIX + requestID + ":submit"`（`:submit` 7 字节，最长后缀）`Buffer.byteLength(full, "utf8") <= 64` → entryID = requestID；超限 → `shortID = requestID.slice(0, 44)` 复核，`qShortMap.set(shortID, requestID)`（重复 key 且 requestID 不同 → logWarn 覆盖）；仍超限 → logError + `undefined`（无键盘退化）。实测 requestID 长度结论写入 1.2 任务报告。
- **独立映射表**：qShortMap 与 permShortMap（§13.4）分开，不得混用。
- **不持久化 qShortMap**（同 §13.4：只存 poller 实例内存；重启后旧按钮还原 raw 找不到记录 → §14.3.1 失效分支，可接受降级）。
- 按钮发出进程 = poller.lock 持有者（getUpdates 唯一消费方），无跨进程一致性问题。

**permission 路径零改动**（§13 全部保持）——以上全部只落在 question 分支。

### 14.3 回调向导状态机 + 纯文本捕获（Phase 1.3，冻结）

#### 14.3.1 handleCallback q 前置分支（1.3 地盘，perm 分支后、通用正则前）

- 判定：`data.startsWith(OTG_Q_CB_PREFIX)` → 正则 `^otg:q:(.+):(o\d+|prev|next|cancel|custom|submit)$`（贪婪 `(.+)` 容忍 requestID 含 `:`；后缀锚定）；不命中 → `answerCallback(id, "Unknown action", false)` + return。
- **状态重建协议（无内存状态，本小节核心，冻结）**——每次回调从**盘上**重建，进程重启天然恢复（决策 #8）：
  1. `requestID = this.qShortMap.get(entryID) ?? entryID`；
  2. `registry.read()`（不加锁，最终一致）→ **全局**线性扫描全部条目全部 sessions（与纯函数全局匹配同序），找 `record.request_id === requestID` 第一条；找不到 → answer「记录不存在或已失效」（alert）+ logWarn + return（不编辑）；
  3. **失效判定**：`record.resolved === true || record.q_answers != null || record.q_reject === true` → 同上失效 answer + return（不编辑）；
  4. `JSON.parse(record.message)` → `questions`（解析抛错/非数组 → 失效 answer + logWarn + return）；
  5. 重建：`draft = record.q_draft ?? questions.map(() => [])`；`stage = typeof record.q_stage === "number" ? clamp(record.q_stage, 0, questions.length) : 0`（**钳制**——parse 不校验范围，此处防御；q_stage === questions.length = 总结阶段）。
- **动作行为序列**（每步：先 mutate 落盘；返回 undefined → 失效 answer + return 不编辑；成功 → answer 文案（§14.3.3）+ 编辑消息（§14.3.1 末））：
  - `o<idx>`（idx 0-based；越界 → answer「选项无效」return）：
    - 当前题**多选**（`multiple === true`）：toggle——`draft[stage]` 含 label → 移除；不含 → 追加（保持数组顺序）→ `setQuestionDraft(reg, requestID, draft, stage)` → answer `已选 {draft[stage].length} 项` → 编辑当前题（✓ 刷新）；
    - 当前题**单选**且**多问题**：`draft[stage] = [label]` → `setQuestionDraft(reg, requestID, draft, Math.min(stage + 1, questions.length))`（=length 自然进总结）→ answer `已选「{label}」` → 编辑下一题；
    - 当前题**单选**且**单问题请求**（`questions.length === 1`）：**直接提交** `submitQuestionAnswers(reg, requestID, [[label]])` → answer `已提交` → 编辑 ✅ Submitted（键盘移除）。
  - `prev` / `next`：`newStage = clamp(stage + (next ? 1 : -1), 0, questions.length)`（next 上限 = 总结阶段；prev 下限 0；答案保留不丢）→ `setQuestionDraft(reg, requestID, draft, newStage)` → answer `已跳转` → 编辑目标阶段。
  - `custom`（**Round 2 修订：恒可用，§14.8.4 supersede**——移除去「`questions[stage].custom !== true` →
    answer「该题不支持自定义输入」return」防御；`current` 判空保留为失效兜底）：
    `setQuestionInput(reg, requestID, stage)` → answer `直接回复文本作为答案，/cancel 取消` → 编辑当前消息（追加输入提示行、**键盘保留**）。
  - `submit`（**Phase 1.5 修订：任意 stage 均可提交**——原「非总结阶段 → Unknown action」守卫删除；键盘层多问题请求仍只在总结阶段渲染 Submit，行为不变，放宽仅为单问题多选（恒 stage 0）提供提交路径）：
    - 校验 `draft.every((a) => a.length > 0)`；未全答 → answer `第 {n} 题未作答，请先作答`（n = 首个空数组下标 + 1）+ **不提交不编辑**；
    - 全答 → `submitQuestionAnswers(reg, requestID, draft)` → answer `已提交` → 编辑 ✅ Submitted（键盘移除）。
  - `cancel`（任意阶段可用）：`rejectQuestion(reg, requestID)` → answer `已取消` → 编辑 ❌ Cancelled（键盘移除）。
- **编辑消息（可测试入口，冻结签名，放 handleCallback/editPermissionResultMessage 近旁）**：
  ```ts
  private async editQuestionWizardMessage(
    chatID: number | string,
    messageID: number,
    text: string,                        // 完整新渲染文本（buildQuestionStageText）或 原文本 + 结果行
    keyboard?: TelegramInlineKeyboard,   // 不传/undefined ⇒ 键盘移除（终态，决策 #4 同款）
  )
  ```
  - 内部：`telegramWithRetry("editMessageText", { chat_id, message_id, text, reply_markup? }, ctx)`——**不传 reply_markup ⇒ 键盘被移除**（同 §13.5）。
  - `messageID = record.q_msg_id ?? callback.message.message_id`（q_msg_id 缺失/重启后兜底 = 用户点击消息自身 id）。
  - 结果行冻结（追加原文本末尾）：submit 成功 → `\n✅ Submitted`；cancel → `\n❌ Cancelled`。
  - 编辑失败 → logWarn（消息过期/被删等），不抛错中断（answer 已发出，视为已处理，同 §13.5）。
  - 非终态编辑（选项/导航/custom 提示）用**完整重渲染**：`editQuestionWizardMessage(chatID, messageID, buildQuestionStageText(…new state…), buildQuestionKeyboard(…new state…))`。
- **异常兜底**：沿用 handleCallback 现有 try/catch（1891-1898 同款）——answer「操作失败，请重试」（alert）+ log error；**q 分支不得落入函数末尾的 editMenuMessage 菜单刷新**（须在编辑原消息后自行结束，同 §13.5 第 7 点）。

#### 14.3.2 handleTelegramUpdate 纯文本捕获 + /cancel（1.3 地盘 1872-1914，冻结）

- **插入点（澄清）**：现 `if (!match) return;`（命令正则不匹配 = 纯文本）改为 `if (!match) { await this.handleQuestionTextInput(message.text); return; }`——纯文本（非 `/` 开头命令）才走自定义输入捕获；`/cancel` 是命令形态 → 走命令 switch（不触发捕获）。chatId 匹配校验沿用既有前置条件（1910-1915 同款，已含 `message.chat.type === "private"` + bot/from id 校验）。
- `handleQuestionTextInput(text)`（私有辅助方法，放 handleTelegramUpdate 近旁，可测试入口）：
  1. `registry.read()` → 全局找 `type === "question" && resolved === false && q_answers == null && q_input != null` 的**第一条**记录（跨全部条目，顺序 = projects 数组序 + sessions 数组序）；找不到 → 静默 return（非命令文本保持忽略）；
  2. 重建 questions（JSON.parse 失败/非数组 → logWarn + return）；
  3. 写答案：`draft = record.q_draft ?? questions.map(() => [])`；`draft[q_input] = [text.trim()]`（**覆盖式**：每次回复覆盖该题草稿，TUI 输入语义同款）；
  4. 落盘（两个 mutate 串行，冻结顺序：先清输入态 → 再推进）：
     - `setQuestionInput(reg, requestID, null)`（清输入态）；
     - **多问题** → `setQuestionDraft(reg, requestID, draft, Math.min(q_input + 1, questions.length))`（=length 自然进总结）；
     - **单问题** → `submitQuestionAnswers(reg, requestID, draft)`（直接提交）。
  5. 编辑向导消息：多问题 → `editQuestionWizardMessage` 渲染下一题（键盘保留）；单问题 → 原文本 + `\n✅ Submitted`（键盘移除）；**纯文本路径 messageID 仅用 `record.q_msg_id`**（无 callback.message 可兜底；缺失 → **Round 2 修订：§14.8.6 supersede「logWarn 跳过编辑」**——改为发一条新的当前阶段向导消息（多问题含键盘并回写新 q_msg_id；单问题 ✅ Submitted 终态文本无键盘），旧消息不动；答案已落盘不受影响）；
  6. 回复确认：`this.enqueueMessage(paragraph("已记录第 {n} 题答案"))`（n = q_input + 1；enqueueMessage 与命令路径一致，不阻塞）。
- **`/cancel` 命令**：switch 追加 `case "cancel":` → `registry.mutate((reg) => clearQuestionInputs(reg))` → `this.enqueueMessage(paragraph("已取消输入模式"))` → return。**不改 `PLANNED_COMMANDS`**（已核验 constants.ts 26-33：cancel 不在其中，命令可达）。
- 确认文案冻结：`已记录第 {n} 题答案`；`/cancel` → `已取消输入模式`。

#### 14.3.3 answer 文案总表（冻结，供 API-202/203/204 断言）

| 场景 | 文案 | alert |
|---|---|---|
| 记录不存在 / 已 resolved / 已 q_answers / 已 q_reject / message 解析失败 | `记录不存在或已失效` | true |
| 正则不命中 | `Unknown action` | false |
| `o<idx>` 越界 | `选项无效` | false |
| ~~custom 但该题不支持~~（**Round 2 修订：该行删除，§14.8.4 supersede**——custom 恒可用，路径不存在） | — | — |
| 单选多题点选 | `已选「{label}」` | false |
| 多选 toggle | `已选 {n} 项` | false |
| 单问题直接提交 / submit 成功 | `已提交` | false |
| prev / next | `已跳转` | false |
| custom 进入输入模式 | `直接回复文本作为答案，/cancel 取消` | false |
| submit 未全答 | `第 {n} 题未作答，请先作答` | false |
| cancel | `已取消` | false |
| 兜底异常 | `操作失败，请重试` | true |

### 14.4 消费端：q_answers / q_reject 应用（Phase 1.4，冻结）

#### 14.4.1 scanReplyQueue 筛选扩展（1.4 地盘 1588-1619）

- 现 `if (record.type !== "permission") continue;` → 改为双分支（permission 分支 §13.6 **零改动**）：
  - `record.type === "permission"`：`record.reply == null || record.resolved` → continue（原样）；
  - `record.type === "question"`：`record.resolved || (record.q_answers == null && record.q_reject !== true)` → continue；否则：
    - `record.q_answers != null` → `applyQuestionReply(record)`；
    - `record.q_answers == null && record.q_reject === true` → `applyQuestionReject(record)`。
- 逐条**串行**、单条抛错不中断整轮（既有 try/catch 保持）；返回成功应用条数（语义不变）。

#### 14.4.2 applyQuestionReply / applyQuestionReject（1.4 新增，放 applySessionReply 之后）

- 与 `applySessionReply`（1633-1669）**同构**：调用 → 成功 `registry.mutate(markSessionResolved)`（undefined → logWarn，下轮重试）；失败/抛错 → logWarn（token 脱敏）**不置位**，下轮 ticker 重试；不引入认领机制。
  **（Round 2 修订：§14.8.2 supersede 失败语义**——错误判定「不存在」（404/QuestionNotFound/SessionNotFound）→ 置 resolved 终态 + log info + 不 rethrow，不再重试；非 404 维持 logWarn + rethrow 下轮重试）**
- **透传语义（冻结）**：`answers = record.q_answers` 原样（不映射、不校验——parse 已保证 `Array<Array<string>>`）；`sessionID = record.session_id`、`requestID = record.request_id`。
- **双路径说明（冻结）**：question.replied/rejected 事件路径（§5.3）保留**先到先得**——筛选已排除 resolved；若 read→apply 窗口内事件/其它实例先置位，本实例 API 调用以「已决」失败被捕获 → logWarn → 下轮读到 resolved=true 即跳过（§13.6 竞态收敛同款）。

#### 14.4.3 SDK 签名核验先行任务（冻结）

- **doc-prep 已核验事实（本机 `~/.opencode/node_modules/@opencode-ai/sdk@1.17.13`，`dist/v2/gen/`）**：
  - root export 扁平客户端（`dist/gen/sdk.gen.d.ts`，即 `postSessionIdPermissionsPermissionId` 所在）**无任何 question 方法**（grep 实证）——本机装的是旧版，**不能**据此断言运行时方法名，必须核验目标版本；
  - `dist/v2/gen`（OpencodeClient2）有 class 方法：`client.question.reply({ requestID, answers?: Array<QuestionAnswer> })` / `reject({ requestID })`；`client.session.question.reply({ sessionID, requestID, questionV2Reply })` / `reject({ sessionID, requestID })`；
  - **`QuestionV2Reply = { answers: Array<Array<string>> }`**（**嵌套 body**——计划文件早稿「body `{ answers }`」表述修正为 `{ questionV2Reply: { answers } }`）；v1 `QuestionAnswer = Array<string>`（扁平 `{ answers }`）。
- **候选扁平方法名**（按 `postSessionIdPermissionsPermissionId` 命名约定 + 路由推断）：
  - v2 会话级：`postApiSessionSessionIDQuestionRequestIDReply({ path: { sessionID, requestID }, body: { questionV2Reply: { answers } } })`；reject `postApiSessionSessionIDQuestionRequestIDReject({ path: { sessionID, requestID } })`；
  - v1 全局：`postQuestionRequestIDReply({ path: { requestID }, body: { answers } })`；reject `postQuestionRequestIDReject({ path: { requestID } })`。
- **1.4 先行任务（必须先做，结果写入任务报告）**：核验运行时 SDK（目标 opencode 1.18.23）扁平方法名与 body 形状。核验途径：a) 本机/缓存中更新版 `@opencode-ai/sdk` 的 `dist/gen/sdk.gen.d.ts`；b) opencode 安装内 bundle 导出面；c) **实机冒烟**（真实 question 请求 → TG 点击提交 → 断言 TUI 侧 question toolcall 真实收到答案——部署清单第 5 步同款）。无法核验 → 按下列**兜底形态**实现并在任务报告标注「推测」。
- **冻结兜底形态**（v2 会话级优先——与 permission session-scoped 先例一致；v1 全局为交替候选）：
  ```ts
  // reply
  await this.client.postApiSessionSessionIDQuestionRequestIDReply({
    path: { sessionID: record.session_id, requestID: record.request_id },
    body: { questionV2Reply: { answers: record.q_answers } },
    throwOnError: true,
  });
  // reject
  await this.client.postApiSessionSessionIDQuestionRequestIDReject({
    path: { sessionID: record.session_id, requestID: record.request_id },
    throwOnError: true,
  });
  ```
- 本契约以核验后结果为准，§14.4.3 为冻结兜底基线。
- **（Round 2 修订：§14.8.1 supersede 本小节全部**——运行时实证扁平客户端**无任何 question 方法**
  且 body 为顶层 `{ answers }`（非嵌套），§14.4.3 兜底形态作废，改走
  `(client as any)._client.post` 分层通道）**

### 14.5 测试编号与锚点契约（supersede §8/§13.9 新增编号）

| 编号 | 定义 | 文件 | 维护 phase |
|---|---|---|---|
| REG-301 | q_* 6 字段往返容错（缺失/null/合法/非法丢记录不抛错）+ 5 纯函数三态（全局匹配 / 无匹配 undefined / 幂等原引用 / 只改目标字段）+ clearQuestionInputs 批量 | `tests/registry-sessions.test.mjs`（尾部追加，704 行后） | 1.1 |
| API-201 | question 发送：初始消息单表（Type/Session/Question m/n/Header/问题文本/选项行 label+description）+ 键盘结构（选项 o<idx>；多题 ⬅️/➡️/❌；custom 题 ✏️；**单问题无导航**）+ 发送条件防御（q_answers!=null / q_reject=true 不发送）+ sendMessageWithKeyboard 返回 message_id → q_msg_id 回写；permission 路径零变化 | `tests/sessions-poller.test.mjs`（Phase 1.2 区块尾部，锚点见下） | 1.2 |
| API-202 | 向导回调：单选多题自动跳下一题；多选 toggle ✓ 落盘；prev/next 钳制；带未答题进总结但 Submit 拒绝并提示题号；全答 Submit → q_answers + 编辑 ✅；单问题点选项直接提交；已 resolved/不存在/已 q_answers → 失效提示；**重启重建**（直接构造带 q_draft/q_stage 的记录 → 回调继续） | `tests/sessions-poller.test.mjs`（文件尾部追加） | 1.3 |
| API-203 | 自定义输入：✏️ Custom → q_input 落盘 + answer + 编辑提示；纯文本消息 → draft[q_input] 写入 + 清输入 + 推进（多问题）/直接提交（单问题）+ 回复确认；/cancel 清除全部 q_input + 确认 | 同上 | 1.3 |
| API-204 | 取消：任意阶段 ❌ → q_reject 落盘 + answer + 编辑 ❌ 键盘移除；已取消记录再点按钮 → 失效提示 | 同上 | 1.3 |
| API-205 | 消费端：q_answers → reply API 透传（sessionID/requestID/answers）→ resolved=true；q_reject → reject API → resolved=true；失败不置位下轮重试；已 resolved 跳过；permission 回归（API-103/104 不受影响） | `tests/sessions-poller.test.mjs`（Phase 1.3 区块尾部 + fakeClient 扩展） | 1.4 |
| API-206 | **（Round 2 新增，§14.8.7）** 消费端通道：分层命中通道②（`_client.post` url/path/body 顶层 `{answers}`）；① 扁平方法存在时直用；404 → resolved 终态不重试；非 404 失败重试（② 降级 ③ 后仍失败）；reject 同构 | 同上（API-205 区块 657 行后 + fakeClient 55-93 区调整） | 2.1 |
| API-207 | **（Round 2 新增，§14.8.7）** 交互：任意题键盘恒含 ✏️ Custom；汇总页含 ⬅️ Prev 且点击回最后一题；无 q_msg_id 输入兜底发新消息（含键盘/终态 ✅ Submitted）；API-203-4 改判 | 同上（文件尾 2682 后） | 2.2 |

**同文件追加锚点（当前文件 1058 行事实；沿用 §13.9 实测经验：同锚点追加 ⇒ CONFLICT；不同锚点 ⇒ 自动干净合并）**：

- **1.2 区块（API-201）**：Phase 1.2 区块**内部尾部**——API-102 用例收尾 `);` 之后（现 905 行后）、`// ---- API-105` 注释之前；区块头 `// ---- Phase 1.2 (API-201) ----`。
  （说明：任务初稿锚点「API-006-5 收尾后」已被 Round 2 的 API-101/102 区块占用——修正为区块内尾部，仍属 1.2 地域。）
- **1.3 区块（API-202/203/204）**：文件尾部——API-106 用例收尾 `);` 之后（现 1058 行文件尾追加）。
- **1.4 区块（API-205）**：Phase 1.3 区块**内部尾部**——API-104 用例收尾 `);` 之后（现 369 行后）、`// API-006-3` 注释之前；区块头 `// ---- Phase 1.4 (API-205) ----`。
  （说明：任务初稿锚点「API-006-2 收尾后」已被 Round 2 的 API-103/104 区块占用——修正为区块内尾部，仍属 1.3 消费端地域。）
- **1.4 独立编辑点**：`fakeClient`（44-66 区）追加 question reply/reject stub（方法名以 §14.4.3 核验结果为准；先按兜底形态命名）；此点与三个区块互不相邻。
- 定位以「紧跟指定既有用例的收尾 `);`」为准（锚定用例名/注释，不锚定行号）；区块之间必须保留至少一个既有用例作间隔。
- **用例纪律（§13.9 沿用 + 本类补充）**：自包含 + **终态**——本类用例终态 = `resolved=true` 或 `send=true`；**不得遗留** q_answers/q_reject 已置且 unresolved 的记录（1.4 扫描器会扫到并尝试 apply，必须在用例内闭环到 resolved）。
- **既有断言最小修正规则（冻结）**：API-101-2（question 发送**无键盘**）与 API-006-5（question 渲染为**原文节选**）的既有断言**不再成立**——question 记录本轮改走向导渲染（API-201 新断言覆盖）。这两处由 **1.2** 以最小修正更新并在任务报告注明（§13.12.3 同款规则）；其余既有用例零改动。

### 14.6 编辑区间分配（supersede §7/§13.7/§13.12.4 本轮范围，冻结；行号参考，以函数名界定）

| Phase | 独占文件/区间（当前行号） | 内容 |
|---|---|---|
| 1.1 | `src/registry/index.ts`（SessionRecord 24-34；parseSessionRecord 95-137；纯函数区 setSessionReply 285-308 之后） | 6 字段 + 白名单 + 5 纯函数 + clearQuestionInputs |
| 1.1 | `tests/registry-sessions.test.mjs`（尾部，704 后） | REG-301 |
| 1.2 | `src/format/format.ts`（PERM_CB_PREFIX 286 近旁 + 文件内） | OTG_Q_CB_PREFIX、buildQuestionStageText、buildQuestionKeyboard |
| 1.2 | `src/monitor.ts` import 块（24-82 区） | 追加 3 个导入名 |
| 1.2 | `src/monitor.ts` scanSessionQueue（1679-1740） | question 分支 + 发送条件追加 + q_msg_id 回写 |
| 1.2 | `src/monitor.ts` sendMessageWithKeyboard（2328-2338） | 返回 message_id |
| 1.2 | `src/monitor.ts` permissionEntryID 近旁（1759-1783 后空白） | questionEntryID + qShortMap（**不得**放进 140-146 字段区，§13.7 同款约束） |
| 1.2 | `tests/sessions-poller.test.mjs`（Phase 1.2 区块尾 905/907 间；API-006-5 430-492、API-101-2 584-624 最小修正；makeMonitor 96-120 的 sendMessageWithKeyboard stub 改返回 message_id） | API-201 追加 + 改判 |
| 1.3 | `src/monitor.ts` handleCallback（2097-2219） | q 前置分支分派（调用 §14.3 辅助） |
| 1.3 | `src/monitor.ts` editPermissionResultMessage 近旁（2239-2270 后空白） | editQuestionWizardMessage + handleQuestionTextInput 等 q 辅助方法 |
| 1.3 | `src/monitor.ts` handleTelegramUpdate（1872-1914） | 纯文本捕获分支 + /cancel case |
| 1.3 | `tests/sessions-poller.test.mjs`（文件尾，API-106 收尾后） | API-202/203/204 |
| 1.4 | `src/monitor.ts` scanReplyQueue（1588-1619）+ applySessionReply 后空白（1669 后） | 筛选双分支 + applyQuestionReply/applyQuestionReject |
| 1.4 | `tests/sessions-poller.test.mjs` fakeClient（44-66）+ Phase 1.3 区块尾部（369/372 间） | question stub + API-205 |

**Round 2 编辑区间（supersede §14.6 本轮范围，冻结；行号参考，以函数名界定）**：

| Phase | 独占文件/区间（当前行号） | 内容 |
|---|---|---|
| 2.1 | `src/monitor.ts` applyQuestionReply/applyQuestionReject（1731-1811） | 分层调用通道（§14.8.1）+ 404 终态（§14.8.2）+ 实例级通道缓存字段 |
| 2.1 | `src/monitor.ts` sendMessageWithKeyboard（3209-3224） | message_id 三形态防御解析 + 首次 dline 键名诊断（§14.8.3） |
| 2.1 | `tests/sessions-poller.test.mjs` fakeClient（55-93） | 删两个扁平 question stub + 四个成员；新增 `_client.post` stub（postCalls/postError） |
| 2.1 | `tests/sessions-poller.test.mjs` API-205 区块（399-657） | 三个用例断言最小改判为 `_client.post` 形态 |
| 2.1 | `tests/sessions-poller.test.mjs`（657 行 `);` 后、`// API-006-3` 前） | API-206 区块 |
| 2.2 | `src/format/format.ts` buildQuestionKeyboard（409-491） | custom 行恒显示 + 总结阶段加 ⬅️ Prev（§14.8.4/§14.8.5） |
| 2.2 | `src/monitor.ts` handleQuestionCallback custom 分支（2888-2919） | 移除「该题不支持自定义输入」防御（§14.8.4） |
| 2.2 | `src/monitor.ts` handleQuestionTextInput（2224-2358，2316-2322 / 2349-2355 两处 logWarn 分支） | q_msg_id 缺失 → 发新消息兜底 + q_msg_id 回写（§14.8.6） |
| 2.2 | `tests/sessions-poller.test.mjs` API-203-4（2437-2458） | 最小改判为「custom 恒可用」语义 |
| 2.2 | `tests/sessions-poller.test.mjs`（文件尾 2682 后） | API-207 区块 |

- **交集为零**：2.1 不得碰 format.ts / handleQuestionCallback / handleQuestionTextInput /
  scanSessionQueue / handleTelegramUpdate；2.2 不得碰 applyQuestionReply/applyQuestionReject /
  sendMessageWithKeyboard（仅**调用**它，不改其实现体）/ fakeClient / API-205 区块 /
  scanSessionQueue。2.2 对 sendMessageWithKeyboard 是「使用方」，2.1 是「实现方」——职责边界清晰，
  行为契约 §14.8.3（返回 `Promise<number | undefined>`）由 2.1 保证、2.2 消费。

- **交集为零**：1.2 不得碰 handleCallback/handleTelegramUpdate/scanReplyQueue/applySessionReply/fakeClient/registry；1.3 不得碰 scanSessionQueue/sendMessageWithKeyboard/import 块/format.ts/registry/scanReplyQueue；1.4 不得碰 scanSessionQueue/handleCallback/handleTelegramUpdate/format.ts/registry/import 块。
- `src/registry/index.ts` 全文件归 1.1；`src/format/format.ts` 全文件归 1.2；`src/constants.ts`、`src/types.ts` **零改动**（本轮无类型/常量扩展需求）。
- makeMonitor（96-120）的 sendMessageWithKeyboard stub 由 1.2 改为「返回 message_id」形态——1.3/1.4 只读该 helper 的既有参数（sendStub 签名不动），不编辑该函数。

### 14.7 明确不做（防过度实现）

- **不动 permission 链路**：§13 全部（键盘/回调/消费端/渲染）零改动——唯一例外是 scanSessionQueue 发送条件追加 `q_answers/q_reject`（对 permission 恒空，语义不变）。
- **不删 `notifyWaiting`**（源码保留、调用点维持现状）。
- **不做向导超时回收**：无 q_created 字段、无过期清理（与 §10 一致）。
- **不持久化 qShortMap**（§14.2.3）。
- **不新增 TG 命令**（除 `/cancel`；`/sessions` 等仍为 PLANNED_COMMANDS）。
- **不做多实例向导并发治理**：同记录并发点击由 mutate 幂等（同值原引用）+ 消费端 resolved 收敛，不引入认领机制（§13.6 同款）。
- **不改 constants.ts**（OTG_Q_CB_PREFIX 放 format.ts，§13.3 决策 #9 同款）。
- **不改 mutate/锁/缓存/serialized/PollerLock/SharedFileStore**（projects-registry.md §3/§4 保持零改动）。

### 14.8 Round 2 修订：消费端 API 通道修复 + 交互修复（实机反馈，冻结 2026-09-02）

> 计划: docs/todos/question-tg-wizard.md Round 2。批次 A = [2.1（消费端通道）, 2.2（交互）] 并发。
> 背景: 用户实机测试反馈三问题——① ✏️ Custom 永不出现（真实 payload 从不带 `custom: true`）；
> ② 汇总页无 ⬅️ Prev；③ 提交后 TUI 不动（**运行时扁平客户端无任何 question 方法**，
> Phase 1.4 推测方法必然 not-a-function）。另有隐藏缺陷：sendRichMessage 响应形态导致
> q_msg_id 缺失 → 自定义输入路径无法编辑原消息。
> 本小节 supersede/修订 §14.2/§14.3/§14.4 相应条款，supersede 总表见 §11。

#### 14.8.1 question reply/reject 调用通道（supersede §14.4.3 兜底形态，Phase 2.1 冻结）

**实证事实（doc-prep + dev-lead 核验）**：

- **运行时扁平客户端无任何 question 方法**：最新 npm `@opencode-ai/sdk` + 本机 SDK 1.17.13 均实证——
  root 扁平客户端**唯一** question 相关方法为零（grep 实证），permission 扁平方法
  `postSessionIdPermissionsPermissionId` 是仅有的扁平先例。→ Phase 1.4 冻结的推测方法
  `postApiSessionSessionIDQuestionRequestIDReply / ...Reject`（§14.4.3）在运行时**必然
  not-a-function**，§14.4.3 兜底形态**作废**，由本小节取代。
- **HTTP body 形状（实证）**：v2 gen `buildClientParams` 把 class 方法签名参数 `questionV2Reply`
  展开为 HTTP body **顶层** `{ answers: Array<Array<string>> }`——§14.4.3 冻结的「嵌套
  `{ questionV2Reply: { answers } }`」表述作废（`questionV2Reply` 仅是 v2 class 方法签名参数名，
  并非 HTTP body 字段）。即使扁平方法存在，按嵌套 body 调用也会错。
- v2 question 路由只有两条：会话级 `POST /api/session/{sessionID}/question/{requestID}/reply`
  与全局 `POST /question/{requestID}/reply`；reject 同构（`.../reject`，无 body）。

**分层调用策略（冻结，每次按序尝试，任一成功即用；实例级缓存已成功策略）**：

```ts
private questionApplyChannel?: 1 | 2 | 3 | undefined; // 实例级缓存：某通道首次成功即记录
```

- **① 扁平方法（typeof 检查）**：`typeof (this.client as any).postApiSessionSessionIDQuestionRequestIDReply === "function"` 等——
  未来 SDK 若有扁平方法则直用（方法名以实际存在为准，两条路由各一）；不存在 → 下一通道。
- **② v2 会话级路由（主通道，与 permission session-scoped 先例一致）**：
  ```ts
  await (this.client as any)._client.post({
    url: "/api/session/{sessionID}/question/{requestID}/reply", // reject: ".../reject"
    path: { sessionID: record.session_id, requestID: record.request_id },
    body: { answers: record.q_answers },                        // reject: 无 body 字段
    headers: { "Content-Type": "application/json" },
    throwOnError: true,
  });
  ```
  已核验 v2 gen 内部即此形态（`client.post({ url, path, body, ... })`），走同一 transport，
  自动继承 baseUrl/auth（含代理与根目录配置）。
- **③ v2 全局路由（降级候选）**：
  ```ts
  await (this.client as any)._client.post({
    url: "/question/{requestID}/reply",                         // reject: ".../reject"
    path: { requestID: record.request_id },
    query: { directory: this.root },
    body: { answers: record.q_answers },                        // reject: 无 body 字段
    headers: { "Content-Type": "application/json" },
    throwOnError: true,
  });
  ```
- **通道降级与 404 终态交互（冻结）**：某通道调用**成功** → 即用其结果并缓存该通道序号；
  某通道抛错且判定「不存在」（§14.8.2）→ **立即终态**，不继续尝试后续通道；某通道抛错
  非「不存在」→ 尝试下一通道；全部通道失败且非「不存在」→ logWarn + rethrow（下轮重试，
  §14.8.2）。
- answer 透传语义不变（§14.4.2）：`answers = record.q_answers` 原样、`sessionID/requestID`
  取自记录；**成功路径** `mutate(markSessionResolved)`（undefined → logWarn 下轮重试，
  既有形态不变）。

#### 14.8.2 404 终态（修订 §14.4.2 失败重试，Phase 2.1 冻结）

- **判定「不存在」**：applyQuestionReply/Reject 捕获错误后判定错误可识别为对象不存在——
  `errorCategory(error, ctx)` 字符串含 `404`、`QuestionNotFound`、`SessionNotFound`，
  或 `error` 的 `status`/`statusCode` 字段 === 404（SDK APIError 形态两者取一即可）。
- **终态行为（冻结）**：`mutate(markSessionResolved)` + `log("info", "question no longer exists; marking resolved", { requestId, sessionId })` +
  **不 rethrow**——本轮视为已处理，下轮 ticker 读到 resolved=true 自然跳过
  （与双路径先到先得 §14.4.2 竞态收敛一致；事件路径或其它实例先置位时同理跳过）。
- **非 404 错误**：维持既有行为（logWarn token 脱敏 + rethrow，scanReplyQueue 捕获不中断整轮，
  下轮重试）。

#### 14.8.3 sendRichMessage message_id 防御解析（修订 §14.2.2 sendMessageWithKeyboard 扩展，Phase 2.1 冻结）

- 实机观察：非官方通道 `sendRichMessage` 响应**无 `result.message_id`**（键名形态与官方
  sendMessage 不同），导致所有记录 q_msg_id 缺失 → 自定义输入路径无法编辑原消息（回调路径
  靠 `callback.message.message_id` 兜底才正常）。
- **防御解析（冻结，替换 §14.2.2 的 `return response?.result?.message_id`）**：
  ```ts
  const messageID =
    response?.result?.message_id ??
    response?.result?.message?.message_id ??
    (response as any)?.result?.messageId ??
    undefined;
  return messageID;
  ```
- **首次诊断（冻结）**：实例级 flag（如 `sendRichMessageKeysLogged`），首次发送成功时
  `dline("sendMessageWithKeyboard response keys: " + Object.keys(response?.result ?? {}).join(","))`
  ——仅键名、不含任何消息内容，天然脱敏；供后续诊断响应形态演进。
- 语义不变：`Promise<number | undefined>`；无则 undefined（§14.2.2 步骤 4 的 logWarn 与
  回调兜底不变）；既有调用点忽略返回值兼容。

#### 14.8.4 Custom 恒显示（supersede §14.2.1 custom 行条件 + §14.3.1 custom 防御 + §14.3.3 文案行，Phase 2.2 冻结）

- 实证：真实 question payload **从不带 `custom: true`**（projects.json 全部真实记录零条
  有此字段），而 ✏️ Custom 仅在 `custom === true` 时渲染 → 永不出现。用户确认：✏️ Custom
  **每题恒显示**（任何题都可回复文本作答——服务端接受纯文本答案）。
- **§14.2.1 键盘行序第 2 条修订（supersede）**：custom 行**无条件渲染**
  （有 `current` 即渲染 `[{ text: "✏️ Custom", callback_data: ...:custom }]`）——
  移除 `questions[stage].custom === true` 条件；单问题单选/多选形态、行序其余不变。
- **§14.3.1 custom 动作修订（supersede）**：移除「`questions[stage].custom !== true` →
  answer「该题不支持自定义输入」return」防御——custom 动作恒可用；
  `current` 判空保留为失效兜底（state 重建已钳制，理论不可达）。
- **§14.3.3 文案表修订**：删除「custom 但该题不支持 → `该题不支持自定义输入`」行（恒显示后
  该路径不存在）。
- **测试影响**：API-203-4（现 2437-2458 区）断言「该题不支持自定义输入」——**由 2.2 最小改判**
  为「custom 恒可用 → 进入输入模式（q_input 落盘 + 提示 + 编辑键盘保留）」并注明。

#### 14.8.5 汇总阶段 Prev（修订 §14.2.1 导航行，Phase 2.2 冻结）

- 实机反馈：总结阶段键盘只有 [✅ Submit] [❌ Cancel]，想改答案必须先取消再从头点。
- **§14.2.1 导航/提交行第 3 条修订（supersede）**：多问题请求总结阶段
  （`stage === questions.length`）导航行 = `[⬅️ Prev](:prev) [✅ Submit](:submit) [❌ Cancel](:cancel)`。
- 回调逻辑**零改动**：`prev` 的 clamp（§14.3.1 `clamp(stage - 1, 0, questions.length)`）
  已支持从 stage=length 回最后一题（length-1）；答案保留语义不变。

#### 14.8.6 输入兜底：无 q_msg_id 发新向导消息（修订 §14.3.2 第 5 步，Phase 2.2 冻结）

- 背景：q_msg_id 缺失（§14.8.3 未修复前的历史记录、或 sendRichMessage 响应形态异常）时，
  自定义输入纯文本路径**无法编辑原消息**——既有行为 logWarn 跳过导致画面停留在旧阶段，
  用户看不到推进结果。用户确认：**发新向导消息继续**，旧消息不动（按钮仍可用、状态在盘上）。
- **§14.3.2 第 5 步修订（supersede）**：`record.q_msg_id !== undefined` 的 else
  （logWarn 跳过编辑）分支改为**发送新消息兜底**：
  - **多问题推进**：`text = buildQuestionStageText(...newStage...)` +
    `keyboard = buildQuestionKeyboard(entryID, questions, newStage, draft)` →
    `const newMsgID = await this.sendMessageWithKeyboard(text, keyboard)`（含键盘）；
    `newMsgID !== undefined` → `registry.mutate((reg) => setQuestionMessageID(reg,
    requestID, newMsgID))` 回写（后续编辑/回调指向新消息）；undefined → logWarn（答案已
    落盘，不影响正确性）；`entryID = this.questionEntryID(requestID)`；undefined（超限
    兜底）→ 退化为 `this.sendMessage(text)` 无键盘（§14.2.2 步骤 3 同款）。
  - **单问题直接提交**：`text = buildQuestionStageText(...index...) + "\n✅ Submitted"`
    （终态文本，**无键盘**）→ `sendMessageWithKeyboard(text)` 或 `sendMessage(text)`
    （entryID 无关，无键盘形态直接文本发送；统一走 sendMessageWithKeyboard 亦可，仅传文本）；
    同样回写新消息 id。
  - 失败（抛错）→ logWarn 不中断，答案已落盘下轮无需重试（消费端照常 apply）。
- 编辑失败路径保持（§14.3.1 编辑消息 logWarn 不中断）；q_msg_id 存在时既有编辑路径**零改动**。

#### 14.8.7 测试编号与锚点契约（supersede §14.5 新增编号，Phase 2.1/2.2 冻结）

| 编号 | 定义 | 文件 | 维护 phase |
|---|---|---|---|
| API-206 | 消费端通道：分层策略命中通道②（`_client.post` 断言 url/path/body **顶层 `{answers}` 且不含 questionV2Reply 嵌套**）；① 扁平方法存在时直用（用例内临时挂方法）；404 → resolved 终态不再重试；非 404 失败仍重试（通道② 失败降级通道③ 后仍失败）；reject 同构（无 body） | `tests/sessions-poller.test.mjs`（API-205 区块 657 行 `);` 后、`// API-006-3` 之前） | 2.1 |
| API-207 | 交互：任意题键盘恒含 ✏️ Custom（payload 无 custom 字段也含）；汇总页导航含 ⬅️ Prev 且点击回最后一题（q_stage=length→prev→length-1）；自定义输入后无 q_msg_id → 新消息收发断言（stub 捕获新文本+键盘 + 新消息 id 回写）；单问题直接提交新消息含 ✅ Submitted | 同上（文件尾 2682 后） | 2.2 |

- **fakeClient stub 调整（2.1 独占，冻结）**：运行时实证无扁平 question 方法 → 删除
  `postApiSessionSessionIDQuestionRequestIDReply/...Reject` 两个 stub（现 71-87 区）与
  `questionReplyCalls/questionRejectCalls/questionReplyError/questionRejectError` 四个成员
  （现 90-93 区）；新增 `fakeClient._client = { post: async (options) => {...} }`——
  `postCalls` 数组记录 `{ url, path, query, body, headers, throwOnError }`、`postError`
  控制失败（可置 Error/含 status 对象模拟 404）。typeof 检查对假 client 自然失败 → 走通道②。
- **API-205 三个用例断言最小改判（2.1 独占，冻结）**：透传断言改 `_client.post` 形态
  （postCalls 的 url 含 `/api/session/.../reply`、path.sessionID/requestID、body.answers 顶层）；
  失败重引用例改 `postError`；已 resolved 跳过断言改 `postCalls.length === 0`。改判于任务报告注明。
- **API-203-4 最小改判（2.2 独占，冻结）**：见 §14.8.4 测试影响。
- 既有断言不受影响核验：API-201-1 的 custom 行断言为正向（Q1 构造 custom:true），恒显示后仍成立；
  API-202-1 总结键盘断言用 `some()` 非硬编码行数，加 Prev 后仍成立；API-201-2/3/4 无 custom/总结断言。
- 用例纪律（§14.5 沿用）：终态 = resolved=true 或 send=true；不得遗留 q_answers/q_reject 未闭环记录。

### 14.9 Round 1 修订：question Custom 输入提示增强（单活输入模式 + 提示带项目/问题标识）（冻结 2026-09-03）

> 计划: docs/todos/question-custom-input-ux.md（其 Round 1；本模块契约 §14 的修订段，紧跟 §14.8 顺延）。
> 批次 A = [1.1（文案模板层）] → 批次 B = [1.2（单活取消 + /cancel 统一）]（**1.2 依赖 1.1 的
> format.ts 新导出函数 questionInputCancelledText，须 1.1 合并后开始**）。
> 两点增强（用户 grilling 确认）：① Custom 提示（弹窗 toast + 向导消息提示行两处）带项目名/问题
> 标识——`请输入 <project> 的 <question> 答案，如果放弃输入请输入 /cancel`；② **单活输入模式**——
> 点新 Custom 自动取消旧待输入（发取消消息 + 清旧 q_input + 旧向导消息重渲染回正常视图），
> /cancel 统一逐条取消新格式、无待输入时静默。
> 本小节 supersede/修订 §14.2.1（输入模式提示行）/§14.3.1（custom 动作文案）/§14.3.2（第 5 步
> /cancel）/§14.3.3（文案表 custom 行）/§14.8.4（中文案行）相应条款，supersede 总表见 §11。

#### 14.9.1 文案模板与纯函数（Phase 1.1 冻结）

`src/format/format.ts` 新增 3 个**导出纯函数**（barrel `export *` 自动透出；`safeTextKeepPaths`
已在 format.ts 内 import，format.ts:33 `import { safeText, safeTextKeepPaths } from "./redact"`——
函数内部直接调用，无需新 import）：

```ts
// 问题标识：header trim 后非空 → 返回 trim 后的 header；否则问题正文
// safeTextKeepPaths 截断 60 兜底。question 可 undefined（防御：取消路径解析
// 失败/越界时仍要发取消消息，label 兜底为空串）。
export function questionLabel(
  question: QuestionV2Info | undefined,
  ctx: FormatContext,
): string

// 进入输入模式提示文案（弹窗 toast 与向导消息提示行共用）：
// `请输入 ${projectLabel} 的 ${questionLabel(question, ctx)} 答案，如果放弃输入请输入 /cancel`
export function questionInputPromptText(
  projectLabel: string,
  question: QuestionV2Info, // 调用点（custom 分支）已有 current 判空守卫，可非空
  ctx: FormatContext,
): string

// 输入被取消文案（取消旧待输入时经 enqueueMessage + paragraph 发送）：
// `${projectLabel} 的 ${questionLabel(question, ctx)} 输入被取消`
// question 可 undefined（防御，见 questionLabel）
export function questionInputCancelledText(
  projectLabel: string,
  question: QuestionV2Info | undefined,
  ctx: FormatContext,
): string
```

- **questionLabel 语义（冻结）**：
  - `header = question?.header`；`typeof header === "string" && header.trim() !== ""` →
    返回 `header.trim()`（trim 后直用，前后空白不进入消息模板）；
  - 否则 → `safeTextKeepPaths(question?.question ?? "", 60, ctx)`。
  - **核验事实（截断形态）**：`safeTextKeepPaths` 截断走 `finishText`（redact.ts 69-75）——
    空白折叠 + trim；超限 → `slice(0, limit - 3) + "..."`，追加 **ASCII 三个点 `...`**（不是 `…`）；
    未超限 → 原样返回。密钥/token 脱敏链同 safeText，跳过三条路径类规则（保留真实路径，§13.12.1）。
  - `question === undefined` → 走兜底路径返回 `safeTextKeepPaths("", 60, ctx)` = `""`（空 label，
    取消消息仍照发——决策 #7 防御语义）。
- **提示行形态（supersede §14.2.1「输入模式提示行」，buildQuestionStageText 373-375）**：
  ```ts
  if (inputPending) {
    rows.push(fieldRow("输入", `✏️ ${questionInputPromptText(projectLabel, current, ctx)}`));
  }
  ```
  ——`current = questions[stage]`（339 行）判空防御保留（无 current 不渲染提示行）；`✏️ ` 前缀
  保留在 fieldRow 值内（决策 #1）。**buildQuestionStageText 无需加参数**（projectLabel/ctx 已在
  作用域，§14.2.1 签名冻结不变）。
- **弹窗形态（supersede §14.3.1 custom 动作文案 + §14.3.3 文案表 custom 行 + §14.8.4 中文案行，
  monitor.ts custom 分支 3103-3107）**：
  ```ts
  await this.answerCallback(
    callbackID,
    safeTextKeepPaths(questionInputPromptText(projectLabel, current, ctx), 200, ctx), // 200 截断 + botToken 脱敏，跳过路径脱敏
    false,
  );
  ```
  ——Telegram answerCallbackQuery `text` 上限 **200 字符**，外层截断兜底。**实现修订
  （Phase 1.1 实证，2026-09-03）**：不可用 `safeText`——其 `redactPaths` 规则
  `/(^|[\s=:"'(])\/(?:[^\s/]+\/)*[^\s,;)]*/g` 会把前置空格的命令 ` /cancel` 误判为外部
  路径并脱敏为 ` <external-path>`，弹窗文案变成「…请输入 <external-path>」与文案模板/
  §14.9.5 断言冲突；改用 `safeTextKeepPaths`（保留 200 截断与 botToken 脱敏、跳过路径
  脱敏规则），`/cancel` 命令完整展示（弹窗是纯文本不走 HTML，无需转义）。
  - **ctx 构造（核验事实）**：custom 分支位于 `handleQuestionCallback` 内，函数顶部已构造
    `ctx`（monitor.ts 2903-2909：`{ root: this.root, botToken: this.config.botToken,
    projectLabel: this.projectLabel, sessions: this.sessions, sessionInfo: this.sessionInfo }`）。
    `safeText`/`safeTextKeepPaths` 只读 `RedactionContext` 字段（root/botToken），`ctx.projectLabel`
    字段不参与脱敏；`projectLabel` 标识本身以**参数**传入 questionInputPromptText（与 ctx.projectLabel
    无关）——**直接复用函数顶部 ctx 即可**；如需 per-record ctx，按 questionStageText 现场同法
    （monitor.ts 3228-3234：`{ root, botToken, projectLabel, sessions, sessionInfo }`）构造，两者等价。
- **独立提示消息通道（Round 2 实机反馈修订，2026-09-03，supersede「提示载体仅弹窗+编辑行」
  的 Round 1 形态）**：custom 分支在 `renderQuestionStage(...)` 之后追加
  `this.enqueueMessage(paragraph(questionInputPromptText(projectLabel, current, ctx)))`
  ——点 Custom 后用户收到**一条独立的持久 TG 消息**承载模板文案（作为后续纯文本输入的
  持久锚点；Round 1 仅弹窗 toast 一闪即逝 + 编辑行不显眼，实机反馈不满足）。弹窗与编辑
  提示行**均保留**（三载体信息一致，冗余无害）；`/cancel` 与纯文本捕获路径不加消息。多
  记录取消场景 enqueueMessage 串行天然有序：A 取消消息先入队 → B 提示消息后入队。
- **取消消息通道（§14.9.2 消费）**：`enqueueMessage(paragraph(text))`——paragraph 内部
  escapeHtml 自动转义（HTML 安全，无需手工转义）；enqueueMessage → `sendMessage`（tests 以
  `monitor.sendMessage` stub 捕获 `sent` 数组断言）。
- **两 phase 共用（1.2 依赖 1.1 的接口点）**：`questionInputCancelledText` 由 Phase 1.2 的
  cancelPendingQuestionInputs 调用；monitor.ts import 块（49-88 区，字母序）由 Phase 1.1 追加
  `questionInputCancelledText` / `questionInputPromptText` / `questionLabel` 三个导出名。

#### 14.9.2 单活取消：cancelPendingQuestionInputs（Phase 1.2 冻结）

```ts
private async cancelPendingQuestionInputs(
  excludeRequestID?: string, // 排除自己（同记录重复点 Custom 幂等刷新不取消，决策 #5）
): Promise<number>           // 返回实际发出取消消息的条数（活记录数；失效静默清与 mutate 未命中不计）
```

**行为规格（完整，冻结）**：

1. `registry.read()` → **全局线性扫描**全部条目全部 sessions（顺序 = projects 数组序 +
   sessions 数组序，与 handleQuestionCallback/handleQuestionTextInput 同款），匹配条件
   `record.type === "question" && record.q_input != null && record.request_id !== excludeRequestID`。
2. 每条匹配记录分类处理（per-record `projectLabel = basename(entry.path) || this.projectLabel`
   ——与现有各扫描点 1918/2332/2918 同款）：
   - **失效记录**（`resolved === true || q_answers != null || q_reject === true`）→ **仅静默**
     `await this.registry.mutate((rec) => setQuestionInput(rec, record.request_id, null))`
     （决策 #6）；**不发消息、不重渲染、不计数**。
   - **活记录**：
     a. `await this.registry.mutate((rec) => setQuestionInput(rec, record.request_id, null))`
        ——清 q_input（草稿保留、向导仍可用，决策 #3）；**返回 undefined → logWarn + 跳过本条**
        （并发已清理/无匹配防御，不发消息不计数，与 handleQuestionCallback 的 undefined 防御同款）；
     b. `const questions = this.parseQuestionPayload(record.message)`（monitor.ts 3194-3214，
        解析失败返回 undefined）；
     c. `enqueueMessage(paragraph(questionInputCancelledText(projectLabel,
        questions ? questions[record.q_input] : undefined, ctx)))`——取消消息**照发**（决策 #7：
        解析失败也发，label 兜底空串）；`questions[record.q_input]` 越界/缺题 → undefined →
        label 兜底空串（防御）；
     d. **parseQuestionPayload 成功 且 `record.q_msg_id` 存在（number）** →
        `await this.renderQuestionStage(record, projectLabel, record.request_id, questions,
        stage, draft, false, this.config.chatId, record.q_msg_id)`——重渲染回正常阶段视图
        （inputPending=false 去输入提示行、键盘保留，决策 #3）；`stage`/`draft` 来自
        `this.rebuildQuestionState(record, questions)`（§14.9.4，第三处使用点）；
     e. 解析失败 或 `q_msg_id` 缺失 → **跳过重渲染**（取消消息本身已是提示，决策 #7）；
     f. `count += 1`。
   - ctx：每记录按 questionStageText 同法（3228-3234）构造（root/botToken/projectLabel(per-record)/
     sessions/sessionInfo），或以 per-record projectLabel 传入参数（safeText 系只读 root/botToken，
     任选其一，行为等价）。
3. `return count`。

**调用点（custom 分支前置，Phase 1.2 地盘）**：custom 分支（3090-3120）在
`setQuestionInput(rec, requestID, stage)`（3096-3098）**之前**插入
`await this.cancelPendingQuestionInputs(requestID)`（排除自己 = 幂等刷新不取消，决策 #5）；
随后原流程不变（setQuestionInput → 弹窗新文案（§14.9.1）→ renderQuestionStage inputPending=true）。

#### 14.9.3 /cancel 新语义（supersede §14.3.2 第 5 步 /cancel，Phase 1.2 冻结）

- `/cancel` 分支（2291-2296）重写为：
  ```ts
  case "cancel":
    await this.cancelPendingQuestionInputs(); // 不排除任何记录（exclude=undefined）
    return;
  ```
- **无活取消（返回 0）→ 静默**：不再发「已取消输入模式」确认消息、不调用 clearQuestionInputs
  （决策 #4）。失效残留记录被静默清不计入返回，亦无任何消息。
- **有活取消**：取消消息已由 cancelPendingQuestionInputs 逐条发出（§14.9.2 步骤 2c），本分支
  不追加任何消息。
- `clearQuestionInputs`（registry/index.ts 500-520）**保留不删**（REG-301 仍测它），monitor
  **不再调用**——registry import 块中的 `clearQuestionInputs`（monitor.ts:92）由 Phase 1.2
  移除（避免 unused import；bun build 不报错，但按整洁移除）。

#### 14.9.4 rebuildQuestionState（Phase 1.2 冻结）

```ts
private rebuildQuestionState(
  record: SessionRecord,
  questions: Array<QuestionV2Info>,
): { draft: Array<Array<string>>; stage: number }
```

- 语义（与现有内联**逐字等价**，冻结）：
  ```ts
  const rawDraft = record.q_draft ?? [];
  const draft = questions.map((_, index) =>
    Array.isArray(rawDraft[index]) ? [...rawDraft[index]!] : [],
  );
  const stage =
    typeof record.q_stage === "number"
      ? Math.min(Math.max(record.q_stage, 0), questions.length) // 钳制 0..length（=length 总结阶段）
      : 0;
  return { draft, stage };
  ```
- **替换三处**：
  1. `handleQuestionCallback`（现 2953-2960：draft 2953-2956、stage 2957-2960）→
     `const { draft, stage } = this.rebuildQuestionState(record, questions);`（逐字等价，行为不变）；
  2. `handleQuestionTextInput`（现 2362-2365）→ `const { draft } = this.rebuildQuestionState(
     record, questions);`（该路径不用 stage，只解构 draft；等价重构）；
  3. `cancelPendingQuestionInputs` 重渲染（§14.9.2 步骤 2d，第三处使用）。
- 放置：handleQuestionCallback 近旁（q 辅助方法区，与 cancelPendingQuestionInputs 相邻）。

#### 14.9.5 测试编号与锚点契约（supersede §14.5/§14.8.7 新增编号，Phase 1.1/1.2 冻结）

测试文件 `tests/sessions-poller.test.mjs`（当前 3555 行）。

**测试 projectLabel 核验事实**：`root = join(baseDir, "project")`（100 行）→
`basename(root) = "project"` = monitor.projectLabel（monitor.ts:176 `basename(this.root) || this.root`）；
各扫描点 `basename(entry.path) || this.projectLabel` 亦恒为 `"project"`——**断言可硬编码字面量
`"project"`**。测试 import 区（第 21 行 `join` from node:path，未 import basename）**不改**
（避免两 phase 共改该行）。

**API-203-1/4 改判（Phase 1.1 独占，冻结）**：
- API-203-1（2556-2643）：Q1 questions **增加 `header` 字段**（如 `header: "补充说明头"`，label =
  header 直用）；弹窗断言（2587-2590）改为插值模板
  `请输入 project 的 补充说明头 答案，如果放弃输入请输入 /cancel`；提示行断言（2591-2594）改为含
  `✏️ 请输入 project 的 补充说明头 答案，如果放弃输入请输入 /cancel`；键盘保留断言（2595-2597）
  不变；draft/q_input/q_stage 落盘断言不变。改判于任务报告注明（§14.5 最小修正规则沿用）。
- API-203-4（2780-2822）：弹窗（2800-2805）与提示行（2807-2809）断言同 API-203-1 改判
  （custom 恒可用语义不变；questions 需加 header）。

**API-203-3 改写（Phase 1.2 独占，冻结，2709-2778）**：
- 保留：part 1「无输入态纯文本静默」（2736-2741：editCount===0、sent 为空）。
- 改写主链路：两条待输入记录（req-203c/req-203d，q_input 分别为 0/1，**各加 q_msg_id** 以断言
  重渲染；questions 无 header → label = 问题正文兜底短文本）→ /cancel → ① sent 收到 2 条取消消息，
  逐条为 `${projectLabel} 的 {label} 输入被取消`；② 两条 q_input 全清（盘上 findRecord 断言）；
  ③ ≥2 条 editMessageText 重渲染（text 不含输入提示行、keyboard 保留）；④ **再发一次 /cancel
  （现无 pending）→ 静默**（sent 不增长、editCount 不增）——无 pending 静默语义（决策 #4）。
- 移除：旧「已取消输入模式」确认断言（2768-2771）。

**API-208-1~4 新增（Phase 1.2 独占，冻结；锚点：文件尾 API-304 用例收尾 `);`（3547）之后、
`await rm(baseDir, ...)`（3549）之前，区块头 `// ---- Round 1 (API-208) ----`）**：

| 编号 | 场景 | 前置 | 断言 |
|---|---|---|---|
| API-208-1 | 多记录取消主链路（决策 #3/#7） | A：`{ q_input: 0, q_msg_id: 42 }`、question **无 header**（取消消息 label = 问题正文兜底短文本）；B：另一条待输入记录（带 q_msg_id） | 点 B 的 ✏️ Custom（runQCallback）→ ① dispose 后 sent 收到 A 的取消消息 `${projectLabel} 的 {A 问题正文} 输入被取消`；② A.q_input 清除（盘上）；③ fetches 含 A 的 editMessageText（message_id === A.q_msg_id、text 不含输入提示行、keyboard 保留）；④ B.q_input === 0（盘上）+ B 弹窗（answerCallbackQuery）为 `请输入 project 的 {B label} 答案，如果放弃输入请输入 /cancel` |
| API-208-2 | 失效静默（决策 #6） | A：`{ q_input: 0, resolved: true }`（残留）；B：正常待输入记录 | 点 B Custom → ① sent 为空（无取消消息，A 失效静默）；② A.q_input 清除（盘上）；③ B.q_input === 0 + B 弹窗新文案 |
| API-208-3 | 同记录幂等（决策 #5） | 单条记录（q_msg_id 有） | 连续两次点同一记录 Custom → ① sent 为空（exclude 自己不取消）；② q_input 不被清（两次后仍为原值）；③ 第二次仍发弹窗提示（answerCallbackQuery 恰 2 条） |
| API-208-4 | /cancel 无 pending 静默（决策 #4） | 一条 `resolved: true` 但 q_input 残留（失效）+ 一条无 q_input | /cancel → ① sent 为空、editCount === 0（无活取消静默）；② 失效残留 q_input 被静默清（盘上，不发消息不计入） |

用例纪律（§14.5 沿用）：自包含 + 终态（resolved=true / send=true）；不得遗留
q_answers/q_reject 未闭环记录；API-208 各用例 A/B 未到终态的在 finally 内 markSessionResolved 闭环。

#### 14.9.6 编辑区间分配（supersede §14.6/§14.8 本轮范围，冻结；行号参考，以函数名界定）

| Phase | 独占文件/区间（当前行号） | 内容 |
|---|---|---|
| 1.1 | `src/format/format.ts`（buildQuestionStageText 近旁 + 373-375） | 3 个新纯函数（§14.9.1）+ 提示行改用 promptText |
| 1.1 | `src/monitor.ts` import 块（49-88 区，字母序） | 追加 questionLabel / questionInputPromptText / questionInputCancelledText |
| 1.1 | `src/monitor.ts` custom 分支弹窗（3103-3107） | 文案改 questionInputPromptText + safeText 200 截断 |
| 1.1 | `tests/sessions-poller.test.mjs` API-203-1（2565-2594）/ API-203-4（2791-2809） | questions 加 header + 弹窗/提示行断言改判 |
| 1.2 | `src/monitor.ts` custom 分支前置（3096 setQuestionInput 之前） | `await this.cancelPendingQuestionInputs(requestID)` |
| 1.2 | `src/monitor.ts` q 辅助方法区（handleQuestionCallback 近旁） | cancelPendingQuestionInputs + rebuildQuestionState 新增 |
| 1.2 | `src/monitor.ts` handleQuestionCallback（2953-2960）/ handleQuestionTextInput（2362-2365） | 状态重建替换为 rebuildQuestionState 调用 |
| 1.2 | `src/monitor.ts` /cancel 分支（2291-2296） | 重写为逐条取消 + 无 pending 静默 |
| 1.2 | `src/monitor.ts` registry import 块（92） | 移除 clearQuestionInputs（不再调用） |
| 1.2 | `tests/sessions-poller.test.mjs` API-203-3（2709-2778）+ 文件尾（3547/3549 间） | API-203-3 改写 + API-208-1~4 新增 |

- 两 phase **严格顺序**（批次 A → 批次 B）：1.2 依赖 1.1 的 format.ts 新导出
  （questionInputCancelledText），须 1.1 合并后开始；顺序执行下无并发冲突。
- 交集说明：1.1 与 1.2 均触 monitor.ts custom 分支/import 块/tests，但编辑区间不同（1.1 只改
  3103-3107 弹窗与 49-88 import 字母序追加；1.2 改 3096 前置与 92 行移除）且顺序执行——无冲突。
- 约束：1.1 不得碰 /cancel、handleQuestionTextInput、registry、API-203-3/API-208 区块；1.2 不得碰
  format.ts、API-203-1/4 区块（1.1 地盘）。
- **不碰**：`src/registry/*`（clearQuestionInputs 保留）、`src/constants.ts`、`src/types.ts`、
  `src/telegram/*`、`src/format/redact.ts`、`src/format/html.ts`、根 `monitor.ts` 构建产物。

#### 14.9.7 明确不做（防过度实现）

- 不改纯文本捕获逻辑（handleQuestionTextInput 扫描条件与顺序）：单活语义下第一条 = 唯一条
  （决策 #8）。
- Custom 恒显示、键盘结构、向导其它状态机（选项/导航/submit/cancel 回调）均不动。
- 取消消息不加 emoji 前缀（按用户模板原文，决策 #8）。
- 不动 permission 链路（§13 全部）、不动消费端（§14.4）、不动发送端（§14.2.2）。
- 不做多实例取消竞态治理：mutate 幂等 + undefined 防御已覆盖（§14.7 同款）。

## 15. Round 5 扩展：Telegram 富文本消息编辑统一（probe gate 驱动的富文本 edit 契约）（冻结 2026-09-03）

> 计划: docs/todos/telegram-rich-message-edit.md（其 Round 1；本模块契约序列 Round 5）。
> 本章在 §13.5（permission 结果编辑）、§14.3.1（question 向导编辑）之上追加统一富文本编辑契约；
> **首次发送（§13.3 发送链 / sendMessage / sendMessageWithKeyboard）与全部按钮 callback 业务、
> 审批/回答语义零变化**。supersede 记录见 §11。
> **不做 API 形态虚构**：本章冻结的是「由 probe gate 选择、实现与测试必须一致」的判定契约；
> 具体 wire 方法名由编码 phase 首任务实测后按 §15.2 判定规则回填，dev-lead 终验时回写结论。

### 15.1 现状事实与动机（冻结）

- 首次发送 = **非官方**通道 `sendRichMessage` + `rich_message.html`（src/monitor.ts `sendMessage`
  3380-3386 / `sendMessageWithKeyboard` 3391-3426，`limitMessage` 已应用；real-keyboard-channel
  探针实证生产可用）。
- 三条**编辑**路径全部为**官方** `editMessageText` + 纯文本 `text`：
  - `editMenuMessage`（3332-3343）：`text = menuText()`——`menuText()` 本身是 HTML
    （`paragraph("📋 项目监控列表")` = `<p>…</p>`，src/format/format.ts 253-256）→ 纯文本编辑
    下 `<p>` 标签泄漏；
  - `editPermissionResultMessage`（3264-3295）：`text = originalText + 结果行`，originalText 由
    调用方传 `message.text ?? ""`（2764，= callback.message.text 纯文本视图）→ 富文本/表格丢失；
  - `editQuestionWizardMessage`（3305-3330）：`text = 完整重渲染 或 ${message.text ?? ""} + 结果行`
    （3010、3124、3142 三处终态编辑依赖 callback.message.text）→ 富文本/表格丢失。
- 实机症状（用户报告）：编辑刷新后表格/富文本丢失、menu 泄漏 `<p>`。修复必须**先经真实网关
  探测证实**可用形态，不得凭推断直接改代码。

### 15.2 探针契约（probe gate，冻结；Phase 1.1 首任务）

**探针文件**：`tests/e2e/real-rich-edit.test.mjs`（新建，入库）。
**纪律**（沿用 real-keyboard-channel.test.mjs / real-keyboard-channel-diag.test.mjs）：
读 `~/.otg/telegram.json` 真实凭据（botToken 打码输出、凭据不落盘不写入任何输出之外的介质）、
经 `telegramRequest` 统一传输入口（proxy 直连分支，测试进程内隧道不可用的既有结论）、
**禁止 getUpdates / answerCallbackQuery**（老插件持锁轮询中，并发 getUpdates 409 冲突）、
逐候选独立 try/catch 收口、退出码反映 HTTP 断言失败；测试进程退出即释放全部资源（单次请求
序列、无守卫生效）。**实机探针会真实推送消息到 chatId 会话**（历轮 real-* 测试既有授权约定）。

**流程（冻结）**：发送一条含 table + inline keyboard 的富文本消息（`sendRichMessage` +
`rich_message.html`）→ 取 message_id → 在**同一 message_id** 上依序执行候选编辑：

| 探针 ID | wire 形态（候选） | reply_markup | 验证点 |
|---|---|---|---|
| REAL-RICH-EDIT-001 | `sendRichMessage` + `rich_message.html`（**基线发送**，非编辑） | 含测试按钮 | message_id 数值；表格 + 键盘基线可用 |
| REAL-RICH-EDIT-002 | `editRichMessage` + `rich_message.html`（对称候选 **A**） | **携带** | 同 message_id 编辑后表格仍渲染 + 键盘保留 |
| REAL-RICH-EDIT-003 | `editRichMessage` + `rich_message.html`（对称候选 A） | **省略** | 键盘被移除（两态验证） |
| REAL-RICH-EDIT-004 | `editMessageText` + `rich_message.html`（候选 **B**） | 携带 | 表格 / 键盘行为 |
| REAL-RICH-EDIT-005 | `editMessageText` + `parse_mode: "HTML"`（候选 **C**） | 省略 | 表格 / 键盘行为 |

**判定规则（冻结，supersede 一切早稿形态）**：

1. 依候选 A → B → C 顺序评估；首个「HTTP 成功（envelope `ok` 且 result 含数值 message_id）
   **且**同一 message_id 编辑后表格仍按富文本渲染」的候选 = **赢家形态**。表格保留判定含
   人眼确认项（API 响应无法断言渲染本身，探针打印各步结果供人确认）。
2. 等价成立时**对称候选 A 优先**（与首次发送载体一致，最稳）。
3. 赢家形态 = **唯一**允许写进 `src/monitor.ts` 富文本编辑实现与单元测试断言的形态；
   编码工人不得偏离（§15.3 helper 内部 wire 形态即此结论）。
4. **全部候选失败（HTTP 失败，或仅成功但表格丢失）→ 不得假装修复**——不得用纯文本
   `editMessageText` 冒充富文本修复；Phase 1.1 如实上报【阻塞】，dev-lead 进入后续设计决策轮。
5. **键盘两态契约（与赢家形态无关，恒成立）**：编辑请求携带 reply_markup → 键盘保留；
   省略 reply_markup → 键盘移除。探针两态均须验证；单元测试两态断言与探针结论一致。
6. 探针结论（赢家形态 + 键盘行为）必须写入 Phase 1.1 任务报告；dev-lead 终验后回写本章
   判定结果占位（§15.2 结论行）。

**实测结论（2026-09-03，Phase 1.1）**：赢家为候选 B——`editMessageText` +
`rich_message: { html: limitMessage(text) }`。候选 A `editRichMessage` 返回 HTTP 404；候选 C
`editMessageText` + `parse_mode: "HTML"` 返回 `Unsupported start tag "p"`。候选 B 响应中的
`rich_message.blocks` 保留 `type: "table"`、`cells` 与 `is_compact: true`；携带
`reply_markup` 时键盘保留，省略时响应不含 `reply_markup`、键盘移除。实现与 API-301~304
单元断言均冻结为候选 B，不得回退为裸 `text`。

### 15.3 统一富文本编辑 helper（Phase 1.1 冻结）

新增 `src/monitor.ts` 私有方法（放 `editPermissionResultMessage` 近旁，3246-3343 helper 区内）：

```ts
private async richEditMessage(
  chatID: number | string,
  messageID: number,
  text: string,
  keyboard?: TelegramInlineKeyboard,
): Promise<void>
```

- **内部 wire 形态 = §15.2 探针赢家形态**（方法名与 body 载体字段由编码 phase 首任务按判定
  规则回填；实现与单元测试必须一致）。`telegramWithRetry(wireMethod, { chat_id, message_id,
  ...载体字段, ...(keyboard ? { reply_markup: keyboard } : {}) }, ctx)`。
- `text` 先经 `limitMessage`（与首次发送同款限长平价——现三条编辑路径未限长，统一后在 helper
  内补齐；行为只收窄不放大，终态文本/菜单文本均远低于上限，无截断风险）。
- `keyboard` 不传/undefined → **不携带 reply_markup**（键盘移除，§13.5 决策 #4 语义保持）；
  传入 → 原样携带。
- **错误语义（与现状三个 helper 一致，勿回退）**：失败 `await this.log("warn", …)`，error 经
  `errorCategory(error, { root, botToken })` 脱敏，**不抛错**（answer 已发出视为已处理；
  menu 编辑失败同样 logWarn 不中断调用链）。
- 三条编辑路径全部迁移到 `richEditMessage`，**各自外层语义零变化**：
  - `editPermissionResultMessage`：文本来源按 §15.4 修正；结果行文案 / 键盘移除 / 失败容忍不变；
  - `editQuestionWizardMessage`：text = 完整重渲染 或 服务器侧终态重建文本（§15.4）；keyboard
    有/无两态与既有冻结签名不变；
  - `editMenuMessage`：text = `menuText()`（HTML 载体承载，不泄漏字面 `<p>`），keyboard =
    `buildMenuKeyboard(registry)`。
- **首次发送 `sendMessage` / `sendMessageWithKeyboard`（3380-3426）零改动**（body 与语义冻结）。

### 15.4 终态文本来源（supersede §13.5 originalText / §14.3.1 结果行文本依赖，冻结）

**动机**：`callback.message.text` 是网关回传的纯文本视图（富文本丢失后用它编辑即损坏）。
终态文本一律改为**服务器侧重建**：

- **permission 结果编辑（supersede §13.5 第 6 步 originalText 来源）**：
  `editPermissionResultMessage` 调用点（2761-2766）不再传 `message.text ?? ""`；改为编辑前用
  `formatSessionRecordMessage(record, …)`（或等价服务器侧格式化输出）重建富文本原文，
  `text = 重建原文 + "\n" + 结果行`。结果行文案、键盘移除、失败容忍全部不变。
- **question 终态编辑（supersede §14.3.1 「原文本 + 结果行」的文本来源）**：submit /
  cancel / 单问题直接提交三处 `${message.text ?? ""}\n✅ Submitted / ❌ Cancelled`
  （3010、3124、3142）改为**当前阶段服务器侧重渲染文本 + 结果行**（复用
  renderQuestionStage / questionStageText 构建路径，与纯文本输入路径 2393-2401 同源）；
  单问题直接提交的 base = `questionStageText(record, projectLabel, questions, index, draft,
  false)`。结果行与键盘移除语义不变。
- **menu**：`menuText()` 本身就是服务器侧 HTML 文本，来源不变，仅载体改富文本编辑（§15.3）。
- **非终态 question 编辑**（选项 / 导航 / custom 刷新）已是完整重渲染（renderQuestionStage），
  仅载体变更，文本来源零改动。

### 15.5 测试编号与锚点契约（新增，supersede §13.9/§14.5 维护归属）

| 编号 | 定义 | 文件 | 维护 phase |
|---|---|---|---|
| REAL-RICH-EDIT-001~005 | §15.2 探针五步（基线发送 + 对称候选 A 键盘两态 + 候选 B + 候选 C） | `tests/e2e/real-rich-edit.test.mjs`（新建） | 1.1（首任务） |
| API-301 | question 向导编辑统一形态：next/prev/option/custom 刷新编辑 = 探针赢家形态（wire 方法名 + body 载体字段断言）且**键盘保留**；submit/cancel/单问题直接提交终态编辑 = 同形态 + **键盘移除** + 结果行；终态文本 = 服务器侧重建（构造 `callback.message.text = "PLAIN-LEAK"`，断言编辑 payload **不含**该原文、含富文本表格结构） | `tests/sessions-poller.test.mjs`（文件尾追加） | 1.1 |
| API-302 | permission 结果编辑：编辑 = 探针赢家形态；文本 = 记录重渲染富文本 + 结果行（不含 callback.message.text）；reply_markup 省略 → 键盘移除；失败 logWarn 不抛错 | 同上 | 1.1 |
| API-303 | menu 刷新（otg:refresh）：编辑 = 探针赢家形态；text 载体含 `<p>📋 项目监控列表</p>` 的 HTML（富文本载体承载标签，非纯文本 text 字段泄漏字面标签）；keyboard = buildMenuKeyboard 保留 | 同上 | 1.1 |
| API-304 | 首次发送形态回归：sendMessage / sendMessageWithKeyboard 仍 `sendRichMessage` + `rich_message.html` + `limitMessage`（body 零变化；既有 API-006/101/201 断言原样成立，本号显式覆盖） | 同上 | 1.1 |

- **既有断言最小改判（冻结）**：`tests/sessions-poller.test.mjs` 中所有以
  `call.url.includes("editMessageText")` 过滤编辑 payload 的断言（API-102 区 1389-1407、
  q 向导编辑断言 2044-2090 的 `edits`/`editCount` 辅助）随探针赢家形态**最小改判** wire 方法名
  （filter 与 body 载体断言），其余断言（文本 / 键盘 / answer 文案 / chat_id / message_id）
  零改动；改判清单写入任务报告。
- 用例纪律（§13.9/§14.5 沿用）：自包含 + 终态（resolved=true 或 send=true）；不得遗留
  q_answers/q_reject 未闭环记录。
- 本 phase 单 worker（批次 A），同文件多区块追加无并发冲突顾虑；锚点以「既有用例收尾 `);` +
  区块头注释」定位（沿用 §13.9 实测经验：同锚点追加 ⇒ CONFLICT，不同锚点 ⇒ 自动干净合并）。

### 15.6 编辑区间分配（冻结；单 phase，无 cross-phase 冲突）

| 文件 | 区间 | 内容 |
|---|---|---|
| `tests/e2e/real-rich-edit.test.mjs`（新建） | 全文件 | 探针五步（§15.2） |
| `src/monitor.ts` | 3246-3343 区（三个 edit helper + 相邻空白） | `richEditMessage` 新增 + 三路径迁移 |
| `src/monitor.ts` | 2761-2766（perm 编辑调用点）/ 3007-3011、3121-3125、3139-3143（q 终态编辑调用点） | 终态文本来源修正（§15.4） |
| `tests/sessions-poller.test.mjs` | `editMessageText` 过滤断言各点 + 文件尾 | 最小改判 + API-301~304 追加 |

- 行号为冻结时参考，以函数名/区块界定为准。
- **不得触碰**：`sendMessage`/`sendMessageWithKeyboard`（3380-3426，首次发送零改动）、
  `src/registry/*`、`src/format/*`（menuText 保持）、`src/constants.ts`、`src/types.ts`、
  `src/telegram/client.ts`（传输层）、根 `monitor.ts` 构建产物。

### 15.7 明确不做（防过度实现）

- 不改首次发送通道/body（`sendRichMessage` 沿用，保持生产可用现状）；不切换官方 `sendMessage`。
- 不改任何 callback 业务 / 审批 / 回答语义（§13/§14 全部行为冻结，仅编辑载体与终态文本来源变更）。
- 不新增 Telegram 方法封装进 `src/telegram/client.ts`（wire 调用继续走 `telegramWithRetry`
  泛型通道，`method` 为字符串参数，零传输层改动）。
- 不引入网关能力缓存/降级开关（赢家形态 HTTP 偶发失败沿用 `telegramWithRetry` 既有重试）。
- 不做权限/向导之外的富文本改造（/help 等 terminal 通知首次发送已达标，本轮不碰）。
- 不把探针结论提前写死为契约正文（§15.2 判定规则是契约；赢家形态是探针结果，由任务报告与
  dev-lead 回写）。
