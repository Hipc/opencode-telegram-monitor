# sessions-relay 模块契约（等待状态落盘 + poller 扫描中继）

> 冻结: 2026-09-02（Round 1 / sessions-tg-relay；**Round 2 / tg-permission-buttons 扩展见 §13**；
> Round 2.1 / 结构化渲染修订见 §13.11；**Round 3 / 单表渲染修订见 §13.12**）
> 文件: `src/registry/index.ts`（记录类型与纯函数）、
> `src/monitor.ts`（写入端 Phase 1.2 / 扫描端 Phase 1.3）、`src/constants.ts`（扫描间隔常量，仅 Phase 1.3）
> 计划: docs/todos/sessions-tg-relay.md（Round 1）、docs/todos/tg-permission-buttons.md（Round 2）
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
