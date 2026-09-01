# sessions-relay 模块契约（等待状态落盘 + poller 扫描中继）

> 冻结: 2026-09-02（Round 1 / sessions-tg-relay）　文件: `src/registry/index.ts`（记录类型与纯函数）、
> `src/monitor.ts`（写入端 Phase 1.2 / 扫描端 Phase 1.3）、`src/constants.ts`（扫描间隔常量，仅 Phase 1.3）
> 计划: docs/todos/sessions-tg-relay.md
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

## 12. 变更记录

- 2026-09-02 冻结（Round 1 / sessions-tg-relay）：SessionRecord 类型、RegistryEntry.sessions、
  parse/serialize 扩展容错、append/mark 纯函数、1.2 写入端与 1.3 扫描端边界、编辑区间、
  API/REG/LOCK/BUILD 归属、SESSIONS_SCAN_INTERVAL_MS 常量归属。