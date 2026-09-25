# opencode v2 集成契约（冻结：2026-09-25，opencode v2.0.15）

> 本文件是 v2 集成层的**唯一权威契约**：03/04/05/06 的实现、测试与文档一律以本文件为准。
> 依据：`tools/v2-probe/FINDINGS.md` + `tools/v2-probe/evidence/**`（01 探针容器实测，
> opencode **v2.0.15**，镜像 `hipc/opencode2:latest`）；任务来源 `.scratch/opencode-v2-adaptation/`
> （spec/status/issues 01–06）。
> 探针证据强度标记沿用 FINDINGS：**[observed]** 运行时实测 / **[binary]** 二进制内嵌 JS 读取。
> 凡本文件未冻结的 v2 事实，均视为「证据不足」，见 §9 与附录 A；**不得**凭推测新增语义。
> 契约以本文档 commit SHA 定版；v1 侧事件名/reply API 的 supersede 记录见
> `docs/modules/sessions-relay.md` 头部行内标注与 §11。
> 关联：`docs/00-overview.md`（指针与总览）、`tools/v2-probe/FINDINGS.md`（证据原卷）。

> **修订 1（2026-09-25，r1）**：A.1/A.6 定案 —— form 回复通道与自然提问流证据见
> `tests/e2e/container/probe-a1/VERDICT.md` + `tests/e2e/container/evidence/probe-a1/**`
> （05 commit `2f29103`）；03 实现修订同步（bootstrap/reconcile/status 移除、无新超时包装，
> commit `0da0f3c`）；新增 subagent lineage（parentID）开放项（§9）。契约以本修订 commit 定版。
>
> **修订 2（2026-09-25，r2）**：§9 关闭 **subagent lineage / parentID** 开放项 — 父链
> **可观测**（`tests/e2e/container/probe-lineage/VERDICT.md` + `evidence/probe-lineage/**`，
> probe `4dddc8e`）；src 已消费（F1，`401e7c1`）；§2.1/§3.1 记录子会话
> `parentID?/agent?/model?` 实测形状，§3.3 冻结 resolved-reply 分类规则（F2，`401e7c1`）。
> 契约以本修订 commit 定版。
>
> **修订 3（2026-09-25，r3）**：实机事故修复（t09）——「触发一个 question 后连续重复推送」，
> 落地 commit `8c807377`：等待记录按 `request_id` 幂等（append 去重 / `markSessionSent`
> 全副本置位 / 扫描轮内去重）+ `sendMessageWithKeyboard` 改读**已解包响应顶层**
> `message_id`（relay `sessions-relay.md` §4.1/§4.2/§6.2/§14.8.3 行内 supersede）；
> §1.3 补多激活语义与 `setup()` pid/root 诊断行；§5.1 补双目录加载字段证据
> （本地 v2 实测 `~/.config/opencode/plugins/` 复数路径）。契约以本修订 commit 定版。
>
> **修订 4（2026-09-25，r4）**：实机事故修复（t10）——「TG 已显示 ✅ Submitted，opencode
> TUI 提问仍 pending」：① form 端点发现由 argv-only 扩展为优先级 argv `--port`/`--port=N`
> → state `service.json` → legacy `~/.config/opencode/service.json`（§A.1 原「端口发现（限制）」
> 段落作废；v2 `serve --service` 守护进程 argv 无 `--port`、env 无密码，旧路径不可发现）；
> ② 新增 apply 归属门——permission/question 两条回写路径在 apply 前先 `client.session.get`，
> 非宿主实例跳过且**不删除**记录，404/409 终态删除仅宿主实例生效（§3.3）。落地 commit
> `5453956`；容器证据 `tests/e2e/container/assert/t10-cross.mjs` + `evidence/t10-cross/**`
> （正控）与 `evidence/t10-cross-prefix/**`（修复前负控）。契约以本修订 commit 定版。
>
> **修订 5（2026-09-26，r5）**：实机事故修复（t12）——「一次 agent 完成推送数条不同项目
> 名的通知（同表内容），仅会话所属项目一条正确」。根因：v2 事件流每进程全局、插件按
> location 多激活，`handleEvent` 无归属过滤。修复 commit `ca5ad92`：① 冻结**事件归属门**
> （§2.0：带 `location.directory` 严格 resolve-equal；无 location 走 sessionID→directory
> 索引；不可归属即忽略 + 有界 dline）；② §1.3 进程级共享去重集合显式例外（同 root 重复
> 激活折叠）。容器证据 `tests/e2e/container/assert/t12-ownership.mjs` +
> `evidence/t12-ownership/**`（正控 8/8）与 `evidence/t12-ownership-prefix/**`
> （修复前负控 6/6，实机签名）。契约以本修订 commit 定版。

---

## 0. 冻结基线

- 目标 opencode：**v2.0.15**（`TARGET_OPENCODE_VERSION = "2.0.15"`，03 改写 `src/version.ts`）。
- 仓库主线切 v2-only；v1 用户继续使用已发布 0.6.x，**不做双兼容**（spec 决策 #1）。
- **禁止运行时兜底/降级路径**（项目铁律）：v2 面缺失能力时不得静默降级，必须暴露原因
  （issue 03/04 验收条件；本契约所有映射均不允许「try v2 失败后回退 v1 私货」）。
- v1 私有 transport（`(client as any)._client.post` 等）**不得依赖**（issue 04 明文）。
- 版本：`1.0.0`（破坏性：仅支持 opencode v2；spec 决策 #5；06 落地）。

---

## 1. 入口与生命周期（冻结）

### 1.1 导出形态：`{ id, setup }`（选择 setup，弃 effect）

探针 `[binary]`：定义 schema 恰好接受两种函数属性之一——`{id, effect}` 或 `{id, setup}`；
其它形态（含无 default 导出）加载失败：
`Plugin must export a default definition with an id and an effect or setup function`
（`evidence/variants/arm-*`；helper 文件即因此被拒）。

**冻结：采用 `{ id, setup }` 形态。** 理由（evidence-backed）：

- `[observed]` `setup(client)` 每次激活调用一次，参数是 **promise 返回包装**的 client
  （25 键 clientSurface，`evidence/load/events.jsonl`、`evidence/api/events.jsonl`），
  与现有异步实现风格一致；
- `[observed]` `effect(context)` 收到的是 **Effect 返回的宿主 context**（`arm-effect.jsonl`，
  `contextKeys`/`contextSurface`），且普通本地 TS 插件无法 import Effect 库——
  消费 Effect 语义在探针中未被验证；
- `effect` 返回语义（Effect 值如何被 host 执行/释放）**未冻结**（§9）。

`setup` 可返回 dispose 函数（§1.4）。

### 1.2 定义形态与接线（03 必须产出）

```ts
// src/index.ts（default export 唯一导出；其余文件不从此 re-export 任何类/函数）
export default {
  id: "telegram-session-monitor", // 插件自报 id（探针 id:"probe-main" 同型；加载器日志另用路径作 id，互不冲突）
  setup(client) {
    // client: V2Client（本地类型，§4）
    const root = client.location.directory; // §1.5
    // 镜像 v1 index.ts 流程：loadConfig(~/.otg/telegram.json) → registry 初始化
    // （失败仍写初始化错误进 tgdiag.log 并 return，同 v1 语义，不抛） →
    // const monitor = new TelegramSessionMonitor(client, config, root, registry);
    // monitor.initialize();
    const abort = new AbortController();
    void (async () => {
      try {
        for await (const event of client.event.subscribe()) monitor.accept(event);
      } catch (error) {
        // stream 结束（shutdown/reload）或异常：dline/console 记录，不吞不抛
      }
    })();
    return () => { abort.abort(); monitor.dispose(); }; // dispose 等价物（§1.4）
  },
};
```

- `[observed]` `client.event.subscribe()` 是**长活 async iterator**（B1/C2），存活到进程结束；
  `for await` 循环直到 `probe.event-stream.ended`（shutdown/reload 时结束）。
- `accept()` 输入 = **原始 v2 envelope**（冻结决策，§7.3）；monitor 内部在
  `parseRuntimeEvent` 把 `data` 归一化为内部 `properties`。
- 入口不得有其它命名导出（v1 事故纪律保留：`bundle-smoke` 断言 default 为含
  `id: string` + `setup: function` 的对象、且无其它导出）。

### 1.3 一次激活一次 setup（同一进程可多次激活）；模块状态在 reload 后重置

- `[observed]` `setup` 每次激活恰一次（`load`/`api`/`variants` 全部场景）。
- `[observed]` `opencode reload` 序列：`probe.dispose` → `probe.event-stream.ended` →
  **新 `probe.setup`（同 pid）**，新激活的模块级状态（seq 计数）从 1 重新开始——
  **插件模块被重新 import**（`evidence/api/events.jsonl` 搜 `probe.dispose`/`probe.setup`）。
- `[observed]` **多激活（field，t09，2026-09-25）**：本地 v2 同一进程内可多次加载同一插件
  （日志 `msg="loading plugin" id=/home/hipc/.config/opencode/plugins/monitor.ts` 单进程反复
  出现 ~6 次），每次加载对应一次 `setup` 激活；多进程共享 `~/.otg/projects.json` 亦同。
  **冻结要求**：等待记录的写入与发送必须跨激活/跨实例幂等——`appendSessionRecord` 按
  `request_id` 全局幂等、`markSessionSent` 一次置位全部副本、`scanSessionQueue` 轮内去重
  （`sessions-relay.md` §4.1/§4.2/§6.2 行内 supersede；commit `8c807377`）。
- **激活诊断（t09 新增，冻结）**：每次 `setup` 激活写一行
  `setup() pid=<pid> root=<client.location.directory>`（`dline`，纯诊断、无行为变化）——
  多加载/多进程重复记录的来源可据此定位（容器断言 D4.1）。

**冻结推论：所有可变状态必须挂在 `TelegramSessionMonitor` 实例上**，禁止模块级可变状态
（常驻心跳用实例字段管理，dispose 清理）。v1 `monitor.dispose()` 已覆盖 timers/intervals/
锁/在途任务，平移即可；新增的 `event.subscribe` 迭代器也要在 dispose 中止（AbortController）。

**显式例外（r5/t12 冻结）：进程级共享事件去重集合。** 唯一被允许的跨激活/跨实例可变
状态是 `rememberEvent` 使用的**进程级 seen-event 集合**：

- 目的：v2 事件流每进程全局（归属门见 §2.0）；同一进程内同一 root 的重复激活（reload
  换挡窗口、双订阅）会各自收到同一 envelope，实例字段无法跨激活去重，共享集合保证
  同一事件**只被处理一次**。
- 载体/key：`globalThis[Symbol.for("opencode-telegram-monitor/seen-events")]`
  （`src/monitor.ts` `SEEN_EVENTS_SYMBOL`）；`Symbol.for` 使模块重新 import（reload）后
  仍指向同一集合。
- 容量：`MAX_EVENT_IDS`（`2_000`，`rememberBounded` 淘汰最旧），与 v1 去重集合同界。
- 标记时机：**只在事件归属门通过后**标记——非宿主/不可归属事件不占用 id。
- 归属索引（`sessionDirectories`）与其它所有状态仍是**实例字段**（每实例自建、不跨实例
  共享）；本例外不改变 dispose 语义。

### 1.4 dispose / reload 语义（v1 `dispose` 的等价物）

- `[observed]` `setup` 返回 `() => { clearInterval(heartbeat); record("probe.dispose", ...) }`；
  shutdown 与 reload 都会执行 dispose（`evidence/load/events.jsonl` 尾部、
  `evidence/api/events.jsonl` reload 序列）。
- **冻结：`setup` 返回 dispose 函数**，内做：abort 订阅迭代 + `monitor.dispose()`。
  `monitor.dispose()` 语义保持 v1（幂等、清空全部定时器/interval、释放 poller.lock、
  await 在途任务）；**不得**顺手清理用户配置/注册表（项目注册表属跨进程共享数据）。

### 1.5 root / directory 来源

- `[observed]` `client.location`（`evidence/load/events.jsonl`、`evidence/api/events.jsonl`；
  事件 envelope 上也带 `event.location`）：

```json
{"directory": "/tmp",
 "project": {"id": "470c8549...", "directory": "/tmp", "canonical": "/tmp"},
 "workspaceID": undefined}
```

- **冻结：插件 root = `client.location.directory`**（v1 的 `directory`/`worktree` 插件参数
  不存在了；`location.workspaceID` 常规目录运行下是 `undefined`，不得当 root 用）。
- `client.worktree` 命名空间是 git worktree 管理用的（list/create/remove/refresh），**不消费**。
- `[observed]` `client.app` = `{"name":"cli","version":"2.0.15","channel":"latest"}`——纯元数据，
  **没有 `log` 方法**（C2 日志段落；console.log 不进服务器日志文件）。

### 1.6 monitor 类构造位置

`TelegramSessionMonitor` 在 `setup(client)` 内构造（config/registry 就绪后），
构造签名冻结于 §7.2；构造完成后 `monitor.initialize()`（poller 先起；**实现修订（03，r1）**：
v2 client 无 `session.list/status`，原 v1 的 bootstrap/reconcile 对账已移除，会话状态完全
事件驱动，见 §3.3）。**不在 index.ts 做任何事件归一化**——envelope 原样交给 `accept()`。

---

## 2. 事件 → 内部语义映射表（核心，冻结）

### 2.0 envelope 与归一化

`[observed]`（B1）每条插件事件：

```json
{"id":"evt_0d42377ef001...","created":1790265489391,"type":"session.inbox.enqueued",
 "durable":{"aggregateID":"ses_...","seq":1,"version":1},
 "location":{"directory":"/tmp"},
 "data":{ ...type-specific... }}
```

- `durable` 仅 durable/aggregate 事件携带（`session.created/deleted/execution.*/step.*/
  tool.*/inbox.*` 等）；ephemeral 事件（`permission.asked/replied`、`form.*`、
  `session.usage.updated`、`session.text.*`、`session.reasoning.*`、`session.tool.progress`）**无**
  `durable`。
- ID 前缀：`ses_`/`msg_`/`prt_`/`per_`/`frm_`/`evt_`/`sh_`/`call_`。
- **冻结：`accept(envelope)` 原样收；`parseRuntimeEvent` 改为从 `envelope.data` 取
  `properties`，`envelope.id` 继续作为去重键（`rememberEvent` 语义不动）。**
  `data` 缺失/非对象 → 该事件丢弃（同 v1 parse 失败返回 undefined 语义）。

**事件归属门（r5/t12，冻结）**

- **背景**（实机事故）：v2 事件流是**每进程全局**的——一个 `opencode serve --service`
  进程按 location/root 多次激活同一插件，每个 monitor 都订阅同一条全局事件流。
  `handleEvent` 若无归属过滤，同一会话会被每个实例各自终态化并各发一条以自身 `root`
  basename 标注的通知（实机：一次完成推了数条不同项目名的消息，仅一条正确）。
- **冻结规则**（`isOwnedEvent`，在**任何状态变更之前**执行：不建投影、不写 sessionInfo、
  不落盘、不去抖、不通知、不清理记录）。判定是**通用规则**（不按事件类型白名单）：
  1. envelope 带 `location.directory` → `resolve(directory)` 与本实例 `this.root`
     （构造时 `resolve(root)`）**严格相等**才放行；带 location 的事件同时把
     `sessionID → resolve(directory)` 记入**实例**索引（非宿主也记录，供无 location
     事件对称判定）。
  2. envelope 无 `location.directory` → 用事件 `sessionID` 查该索引（`form.created`
     的 sessionID 在 `data.form.sessionID`，§2.6）；索引命中且等于 `this.root` 才放行。
  3. 既无 location 且 sessionID 缺失/未知/属于其它目录 → **忽略**（含 `server.connected`
     等非会话事件）。
  4. 跳过诊断（dline，每实例有界、不刷屏）：非宿主目录 → **每目录一次**
     `event skipped: location not owned by this instance directory=<dir> type=<type>`；
     无 location 不可归属 → **每（原因,事件类型）一次**
     `event skipped: <reason> type=<type>`（reason = `no location, not session-scoped` /
     `no location and session not attributed`）。
- **位置形态实测表**（扫描全部容器证据 `tests/e2e/container/evidence/**` 的
  `sse-raw.txt`/`*.jsonl`：probe-a1 / probe-lineage / harness / t12-ownership；
  opencode v2.0.15；仅列消费面事件族，其它带 location 的忽略面事件同规则处理）：

| envelope location | 事件类型（实测） |
|---|---|
| 带 `location.directory` | `session.created`、`session.step.*`、`session.text.*`、`session.reasoning.*`、`session.tool.*`、`session.inbox.*`、`form.*`（`form.created`/`form.replied` 实测）、`permission.asked` |
| 无 `location` | `session.execution.started/succeeded/failed`、`session.usage.updated`、`permission.replied`、`server.connected` |

- **已知行为（有意设计，无兜底）**：晚激活实例（在该会话全部带 location 事件之后才
  激活）没有该会话的索引条目 → 该会话的无 location 事件（execution.* / usage.updated /
  permission.replied）被跳过；**宁可漏、不可错挂**，不新增回填/兜底通道。
- 索引上限 `MAX_EVENT_IDS`（超出淘汰最旧条目）。
- 事件去重（r5 修订，supersede 原「`seenEventIDs` 机制保持」）：`seenEventIDs` 由实例
  集合改为**进程级共享**集合（§1.3 显式例外；
  `Symbol.for("opencode-telegram-monitor/seen-events")`，上限 `MAX_EVENT_IDS`），且
  **只在归属门通过后标记**——同 root 重复激活折叠为一次处理，非宿主事件不占 id；
  `seenWaitingRequestIDs`/`terminalMessageIDs` 仍为实例集合不变。v2 envelope `id`
  全局唯一（`evt_` 前缀）。

### 2.1 会话投影（session.created / deleted / execution.*）

| v2 事件 | 消费的 `data.*`（精确字段，observed） | 映射到 v1 内部语义 |
|---|---|---|
| `session.created` | `{sessionID, projectID?, location?, subpath?, parentID?, slug?, title, agent?, model?, version?, permissions?}`（`durable.seq:0`；`parentID?` **r2**：子会话数据携带、根会话无此键；`agent?`/`model?` 仅子会话 spawn 指定时出现，可选 — probe-lineage 实测） | v1 读 `properties.info`(Session)；v2 无 info → **本地合成最小 SessionInfo**：`{id: data.sessionID, title: data.title ?? data.slug, projectID, parentID, location:{directory: data.location?.directory ?? root}}`；写 `sessionInfo` 并挂到 `projection.info`；`ensureSessionInfo` 缓存 `session.get` 结果含 `parentID` 键（F1/`401e7c1`）。**不**在 v1 的 `session.updated`（v2 不存在）上做。 |
| `session.deleted` | `{sessionID}`（`durable` 有值） | 同 v1（~597-627）：按 `data.sessionID` 取消 waiting 通知、清 projection/`sessionInfo`、`cleanupSessionRecords(id)`（Round 6 §16 path ②）、父/根会话 idle 补齐。 |
| `session.execution.started` | `{sessionID}` | 替代 v1 `session.status` 非 idle 分支：`applyStatus(session, {type:"busy"}, true)`——**本轮 turn +1 的唯一入口**（`!observedRunning -> turn+=1`，重置换 key 字段）。 |
| `session.execution.succeeded` | `{sessionID}` | 替代 v1 `session.idle`：`applyStatus(session, {type:"idle"}, true)` → `scheduleIdleFinalization`（去抖/终态流程保持）。outcome 判定：`commitIdleOutcome` 无 error → `completed`。 |
| `session.execution.failed` | `{sessionID, error:{type, message}}`（`evidence/session-error`：`{type:"provider.no-route", message:"Model unavailable: ..."}`） | 替代 v1 `session.error` + idle 组合：`projection.pendingError = summarizeError(data.error, ctx)`；随后 `applyStatus(idle, true)` → 终态 `failed`。 |
| `session.execution.interrupted` | `{sessionID, reason}`（observed `reason:"user"`） | 终态 `cancelled`：置 `pendingError = {name: reason 或 "interrupted", cancelled: true}`（走 v1 cancelled 分支语义：取消 waiting 通知、清 `waitingByRequestID`、`cleanupSessionRecords`、`applyStatus(idle, true)` → 终态 `cancelled`）。reason 透传不映射（脱敏后用于日志）。 |

**终态判定（冻结）**：`completed` ← execution.succeeded；`failed` ← execution.failed（或
step.failed 的 error 落 `pendingError`）；`cancelled` ← execution.interrupted。三者都是
**execution 终态**，取代 v1 的 `message.updated` error 判定路径（v1 `commitIdleOutcome`
读 `currentMessage?.error`；v2 改为读 `pendingError`——step.failed/interrupted/failed
自动写入）。

**子会话形状（r2，probe-lineage 实测）**：模型 `subagent` 工具产出的子会话
`session.created` 数据实测为 `{sessionID, projectID, location, subpath,
parentID:"ses_<父>", slug, title, agent?, model?, version}`（`agent`/`model` 仅在
spawn 指定时出现，可选 — `tests/e2e/container/probe-lineage/VERDICT.md` 原样引用）；
`client.session.get` 对子会话多返回 `parentID`（键集 `['id','parentID','projectID',
'agent','cost','tokens','time','title','location']`），根会话无 `parentID` 键。
fork 不是 parentID 子链：forked 会话 `parentID=null` 且带 `fork:{sessionID,boundary}`，
只发 `session.forked`（§9 已关，勿当子会话消费）。

### 2.2 step / text / reasoning（替代 v1 message.updated / message.part.updated）

| v2 事件 | 消费的 `data.*`（精确字段） | 映射到 v1 内部语义 |
|---|---|---|
| `session.step.started` | `{sessionID, assistantMessageID, agent, model:{id, providerID}, started}` | 替代 v1 `message.updated` 的 turn 内消息定位：`currentAssistantMessageID = data.assistantMessageID`；`projection.agent = safeText(data.agent, 80, ctx)`。**不**动 turn 计数（turn 只在 execution.started 递增，§2.1）。 |
| `session.step.streamed` | `{sessionID, assistantMessageID}` | 无状态变化（流式中间态）；记录即可（**不**触发通知）。 |
| `session.step.ended` | `{sessionID, assistantMessageID, finish, rawFinish, cost, tokens:{input, output, reasoning, cache:{read, write}}}` | **token/cost 聚合更新**（见 §2.4；绝对赋值，非累加）。`finish` observed `"stop"`——仅作诊断日志，不驱动状态（终态由 execution.* 驱动）。 |
| `session.step.failed` | `{sessionID, assistantMessageID, error:{...}}` | `projection.pendingError = summarizeError(data.error, ctx)`；同轮后续 execution.failed 若到时以它为准覆盖。 |
| `session.text.started/delta/ended` | `{sessionID, assistantMessageID, ordinal, delta?/text?}` | **不消费**（忽略，§2.8）：v1 读消息文本仅用于 `terminalMessageID` 去重与 error 判定，二者 v2 分别由 `currentAssistantMessageID`（step.started）与 `pendingError`（step.failed/execution.*）取代；通知/向导无任何文案来自 assistant 文本。 |
| `session.reasoning.*` | — | **忽略**（v1 无 reasoning 投影）。 |

### 2.3 工具投影（替代 v1 session.next.tool.* 与 part 工具投影）

| v2 事件 | 消费的 `data.*`（精确字段） | 投射（`upsertTool` 语义保持） |
|---|---|---|
| `session.tool.input.started` | `{sessionID, assistantMessageID, id, name}` | `callID=id`，`state:"pending"`，`tool=name`。 |
| `session.tool.input.ended` | `{sessionID, assistantMessageID, id, text:"{\"command\": ...}"}` | 解析 `text` JSON（shell 的输入）；`target=safeToolTarget(name, parsedInput, ctx)`。解析失败 target 缺省，**不抛**。 |
| `session.tool.called` | `{sessionID, assistantMessageID, id, input:{command}, executed}` | `state:"running"`，`target=safeToolTarget(name, input, ctx)`。`executed` 字段**不消费**（探针中成功与失败场景均为 false，语义存疑，不属于契约输入）。 |
| `session.tool.progress`（ephemeral） | `{sessionID, assistantMessageID, id, metadata:{shellID}}` | `progress = metadata.shellID`（或无则跳过；v1 的 structured/content 在 v2 无对应）。 |
| `session.tool.success` | `{sessionID, assistantMessageID, id, content:[{type:"text", text}], metadata:{status, truncated, exit}, executed}` | `state:"completed"`。content/metadata 仅诊断（**不**消费到消息）。 |
| `session.tool.failed` | `{sessionID, assistantMessageID, id, error:{type, message}, metadata, executed}` | `state:"error"`；error 归 `pendingError` 候选（供终态判定；透出脱敏）。 |

`session.shell.*`、`shell.created/exited/deleted`：**忽略**（shell 生命周期事件；失败已由
`session.tool.failed` 携带 `error.type:"aborted"` 等覆盖，无须另建投影）。

### 2.4 用量（token / cost）

- `[observed]` `session.usage.updated`（ephemeral）：`{sessionID, cost, tokens:{input,
  output, reasoning, cache:{read, write}}}`（`evidence/load/events.jsonl`、`evidence/api/`）。
- `[observed]` `session.step.ended` 同款 `cost`/`tokens`（累计值，与 usage.updated 同刻等同）。
- **冻结：两者都按「绝对聚合值」赋值**到 `projection.tokens`（TokenTotals 映射：
  `input/output/reasoning/cacheRead/cacheWrite/cost/hasCost=cost!=null`）——**不是增量累加**
  （探针两事件同刻 identical；v1 `recalculateTokens` 逐 part 累加语义被取代）。
  先到先得、后到覆盖均可（同值）；**不**引入计时器去抖。
- `session.usage.recorded`：**未冻结**（§9；[binary] durable 目录存在但探针未触发）。

### 2.5 等待记录：permission

| v2 事件 | 消费的 `data.*`（精确字段） | 映射 |
|---|---|---|
| `permission.asked` | `{id, sessionID, action, resources, save?, source?}`（API 创建的无 save/source；真实工具调用含 `save:["echo *"]`、`source:{type:"tool", messageID, id:"call_..."}`） | `addWaiting(sessionID, {requestID: data.id, type:"permission", summary: \`${safeText(data.action,80,ctx)} permission\`, toolCallID: data.source?.id ?? undefined}, properties)`。结构化渲染（relay §13.11/§13.12）字段源：`parsed.action` → Permission 行、`parsed.resources` → Pattern 行（保持 §13.12 单表渲染）。 |
| `permission.replied` | `{sessionID, requestID, reply}`（`reply:"once"` observed；`reply in "once"|"always"|"reject"`） | 同 v1：去抖窗口内 `cancelWaitingNotify`；窗口外 `resolveWaitingRecord(requestID)`（Round 6 §16：删除记录）。`reply` 值透传（不回写记录，仅事件语义；按钮回写走 §3 + relay §13/§14 落盘 `reply` 字段）。 |
| `permission.updated` | — | **未在 v2 流上观测到**（B2 只捕获 asked/replied；B4 v1-compat 清单不含它）→ **不得依赖**，列入附录 A.5。 |

权限通知去抖（`WAITING_NOTIFY_DEBOUNCE_MS`）机制、三按钮回调、消费端 apply、
404 终态、Round 6 删除语义：**全部保持**（relay 契约 §13/§14/§16），仅换 v2 事件名与
reply API（§3、§7）。**（t13）** permission 记录同样落 `host_pid` 印章（§2.6 同款）——
`permission.asked` → `addWaiting` 写 `host_pid: process.pid`（创建进程 = 宿主）；apply 前按
`host_pid` 判定归属（`waitingRecordOwnedByThisInstance`，§3.3），缺失旧记录过渡期走
`client.session.get`（共享存储 fail open，P4）。

### 2.6 等待记录：question = form.*（替代 question.asked）

- `[observed]` v1 `question.asked` 的 v2 替代是 **form 系统**（B3）：
  `form.created` / `form.replied` / `form.cancelled`。

| v2 事件 | 消费的 `data.*`（精确字段） | 映射 |
|---|---|---|
| `form.created` | `data.form:{id, sessionID, title, metadata?, fields:[...]}`；`metadata?`：可选（实测仅在自然提问流出现，见下方注意）；`fields[]` 项 = `{key, title, type, options?:[{value, label, description?}], custom?:boolean, required?, hidden?, when?, format?, minLength?, maxLength?, pattern?, default?}`（`type in "string"|"number"|"integer"|"boolean"|"multiselect"|"external"`） | `addWaiting(sessionID, {requestID: data.form.id, type:"question", summary: safeText(data.form.title ?? fields[0]?.title ?? "OpenCode question", 120, ctx)})`。**完整 fields 数组随 `properties` 原样 JSON 落盘**（relay §4.2 message=完整 payload），供 TG 向导（relay §14）渲染：**每个 field = 一个向导 stage**（title=问题文案、type 映射 §14 题目类型、options=选项、custom=允许自定义输入、multiselect=多选）。 |
| `form.replied` | `{id, sessionID, answer:{key: value, ...}}` | 取消 question waiting（同 v1 question.replied 语义：`cancelWaitingNotify(requestID)` + `resolveWaitingRecord(requestID)`）。 |
| `form.cancelled` | `{id, sessionID}` | 取消 question waiting（同 v1 question.rejected 语义）。 |

- TG 向导按钮/纯文本捕获/状态机（relay §14.1–§14.9）机制与落盘结构保持；v2 只换
  「事件 ↔ 记录」两端的事件形状。**向导到 form 的字段形态映射以本表为唯一输入**，
  04 不得发明 `questions: [{header, question}]` 之外的 v1 形状。
- **`data.form.metadata?`（r1 增补）**：`{kind:"question", tool:{messageID, id:"call_..."}}`——
  **可选，实测仅在自然提问流出现**（API 创建的控制表单无；05 probe-a1，
  `tests/e2e/container/evidence/probe-a1/probe-a1.jsonl` + `sse-raw.txt`）；
  不参与 waiting 记录判定，仅标记形态。
- **自然提问流实测（05 probe-a1，§A.6 关闭）**：模型 question tool → `form.created`
  （`metadata.kind="question"`），`questions[] -> fields[]`（键 `q0..qN`、`title=header`、
  `description=question`、`options=[{value:label, label, description}]`、`custom:true`）。
  选项回写必须提交 `option.value`（字符串），**不是** label（VERDICT.md）。
- **form 回复的「应用」通道已定案**（§9/A.1）：客户端 surface 无 form 命名空间（05 实测
  `client.rpc` 仅 `["register"]`、`client.session` 无 form/inbox 方法），唯一通道是
  **进程内 HTTP Basic 回写**（§3.2 + 附录 A.1）；仍**禁止** v1 `_client.post` 私货。
- **归属印章（t13，relay §14.10）**：`form.created` → `addWaiting` 写 `requestID=form.id`
  并随记录落 `host_pid: process.pid`（创建进程 = 宿主该 session）；form 回写 apply 前按
  `host_pid` 判定归属（`waitingRecordOwnedByThisInstance`），缺失旧记录过渡期走
  `client.session.get`（共享存储下 fail open，P4）。共享多 server 拓扑下，非宿主**绝不会**
  应用/删除该 form 的回写记录（t13-shared-cross 正控 17/17）。

### 2.7 等待记录与状态：inbox（不产生 waiting 记录，仅 busy 守卫）

`[observed]`（B3/D4）inbox 是 durable 提示队列：`item.type in "user"|"synthetic"|
"compaction"|"move"`，`delivery in "steer"|"queue"`。

| v2 事件 | 消费的 `data.*` | 映射 |
|---|---|---|
| `session.inbox.enqueued` | `{sessionID, inboxID, item:{type, payload:{text, files?}, delivery}}` | **不创建 waiting 记录**（v1 只有 permission/question 两类等待）。若 `item.delivery === "steer"`：置会话「awaitingInput」标记（新增投影位，默认 false）——参与 idle 终态守卫：存在未交付 steer 项时**不**让该轮 finalize（execution.* 终态到来后若有 steer 未清，推迟 `scheduleIdleFinalization` 至 `delivered`/`cancelled`/`delivery.changed`）。`item.type` 仅日志。 |
| `session.inbox.delivered` | `{sessionID, inboxID}` | 清除该 inboxID 的 awaitingInput；若该会话 steer 集清空 → 走正常 idle 终态路径。 |
| `session.inbox.cancelled` | `{sessionID, inboxID}` | 同上（取消 = 不再等待）。 |
| `session.inbox.delivery.changed` | `{sessionID, inboxID, delivery}` | 更新该 inboxID 的 delivery；据此重算 awaitingInput。 |

- `awaitingInput` 是**新增内部状态位**（`SessionProjection` 增可选字段，03 落地；
  03 必须保证旧投影无该字段时按 false 处理）。
- 该守卫只影响 idle 终态时机，**不**影响 permission/question 记录（两者照常落盘/发送）。
- **自然提问流已定案（05 probe-a1，§A.6 关闭）**：模型 question tool 产生的是
  `form.created`（`metadata.kind="question"`），**不是** `inbox.user steer` —— §2.6
  假设成立，本表**不**新增 waiting 来源；`inbox` 仍只做 busy 守卫（delivery="steer"）。
  唯一观察到的 steer 相关行为是 headless `opencode run` 对 question form 的自动取消
  （`form.cancelled` → tool.failed `aborted` → `execution.interrupted`），与插件无关。

### 2.8 忽略事件（out of scope，及理由）

| 事件族 | 理由 |
|---|---|
| `session.instructions.updated` | 环境/指令摘要元数据，无投影消费（B2 全程出现，忽略）。 |
| `session.text.*`、`session.reasoning.*` | v1 读消息文本仅服务 `terminalMessageID` 去重与 error 判定，v2 已有等价物（§2.2）；无其它消费方。 |
| `session.shell.*`、`shell.*` | 生命周期细节，已被 `session.tool.failed` 覆盖（§2.3）。 |
| `session.usage.recorded` | 未触发（§9）。 |
| `session.compaction.*` | 未触发（§9）；若 e2e 长会话触发且影响幂等/去重，另行决议。 |
| 环境事件：`provider.updated`、`model.updated`、`agent.updated`、`command.updated`、`skill.updated`、`websearch.updated`、`reference.updated`、`integration.updated`、`plugin.updated`、`models-dev.refreshed`、`location.shutdown` | v1 不消费任何环境事件（B2 全程出现，保持忽略）。`location.shutdown` 在 dispose 前后出现，不参与业务。 |
| v1-compat 事件：`session.updated`、`message.updated`、`message.part.updated`、`message.part.delta`、`session.idle`、`session.error`、`todo.*` | `[observed]` 4+ 完整运行（含模型回合/工具调用）与原始 SSE（`evidence/api/sse-raw.txt`）**均未出现**；`[binary]` v2 有 compat schema/迁移表但不发布到插件事件总线（B4/B5）。**一律不得接线**。 |
| `server.connected` | 仅 HTTP SSE 流有（B1）；插件 `client.event.subscribe()` 上无。 |

---

## 3. client API 用法子集（冻结）

### 3.1 允许调用的方法（精确签名，全部 observed）

| 方法 | 参数形状 | 返回（observed） | 用途 |
|---|---|---|---|
| `client.event.subscribe()` | — | async iterable of Envelope（§2.0） | 事件流（入口唯一事件源）。 |
| `client.location` | — | `{directory, workspaceID?, project}` | root 解析（§1.5）。 |
| `client.permission.reply({sessionID, requestID, decision, message?})` | `decision in "once"|"always"|"reject"` | resolve `undefined`；服务端发 `permission.replied {reply}`（C2，`evidence/api` `probe.permission.reply.result`） | **TG 三按钮回写的唯一通道**（relay §13.6 apply 改用它；`message?` 未在探针使用，保留透传不校验）。**替代** v1 `postSessionIdPermissionsPermissionId({path, body:{response}})`。 |
| `client.permission.list({sessionID})` | — | pending 请求数组 `[{id, sessionID, action, resources, save?, source?}]` | 04 诊断/按钮刷新可选（不强制）；不可用于代替事件。 |
| `client.permission.get({sessionID, requestID})` | — | 同 list 项；不存在 → error | 同上（诊断可选）。 |
| `client.session.get({sessionID})` | — | 会话对象（直接返回，非 `{data}` 包装）：`{id, projectID, cost, tokens:{input,output,reasoning,cache:{read,write}}, time:{created,updated}, title, location:{directory}}`（C2，`probe.session.get`）；**r2**：子会话额外含 `parentID` 可选键（根会话无 — probe-lineage 实测） | `ensureSessionInfo`/`primarySession` 的唯一会话查询（03 落地，§3.3）；结果**原样缓存**（含 `parentID` 键），恢复 v1 父/根投影（F1/`401e7c1`）；**替代** v1 `session.get({path})` 包装形态。 |
| `client.session.create({title})` | — | 同 get 形状 | 探针验证可用；主插件**不消费**（冻结：不创建会话）。 |
| `client.session.context({sessionID})` | — | 消息数组（compaction 后）；新会话 `[]`（C2） | 诊断可选；**不消费**到投影（v1 reconcile 的 messages/todo 已移除，§2.1/§2.4）。 |

### 3.2 明确不使用的 API（状态决策，冻结）

| API / 能力 | 决策 | 理由 |
|---|---|---|
| `client.storage.*`（get/set/remove/scan，key 按 `plugin:<hex-id>:` 命名空间） | **不使用** | 自有 `~/.otg/` 落盘（telegram.json/projects.json/tgdiag.log/*.lock）v1 语义已 116 用例覆盖；迁移到 v2 storage 无收益且有既有数据兼容成本（spec 决策：全量功能对齐，落盘语义不动）。 |
| `client.app.log` | **不存在**（app 仅元数据） | 日志走既有 `dline`/console 路径：`monitor.log()` 方法改为 dline/console（保留现 fallback；无 app.log 时永不抛）。 |
| `client.session.list` / `session.messages` / `session.todo` | **不存在**（C3） | bootstrap/reconcile 相应移除（§3.3 实现修订）；HTTP API 有等价物（`GET /api/session`、`/api/session/:id/message`），第三方测试可用，插件内**不**引入 fetch 通道（唯一例外：form 回复通道，见下两行）。 |
| `client.tui` | **不存在** | v1 亦仅 v1 TUI 用。 |
| `(client as any)._client.post` 及任何扁平 question/reply 私货 | **禁止**（issue 04） | v1 实机修复轮的私货通道；v2 契约面明确（permission.reply），form 应用通道已定案为 HTTP 回写（附录 A.1）。 |
| HTTP `fetch` 到自身 server | **仅限 form 回复通道**（05 定案，附录 A.1）；其它场景一律**不使用** | `POST /api/session/:id/form/:id/reply`（Basic auth，见 A.1）；端点发现按 A.1 修订优先级（argv → state service.json → legacy），不可发现/请求失败时**显式失败**（记录原因日志），**不做任何兜底**（VERDICT.md 的 argv-only 端口发现限制已被 r4 §A.1 supersede）；不参与事件消费/轮询竞态。 |

### 3.3 幂等/事务/超时/事件顺序语义（适用项冻结，不适用项注明）

- **实现修订（03，r1）**：v2 client 无 `session.list/status`（§3.2）→ v1 的
  bootstrap/reconcile 对账整体移除（`initialize()` 不再做回核对账），poller-first 语义保持
  （poller 先起、注册/自更新/replyScan 后台启动，§7.2）；`withTimeout` 8s 守卫随之删除，
  **不新增**任何超时/重试包装（避免新增降级路径，issue 03 铁律）——04 的 waiting/回写
  代码同样不得引入新的守卫包装。
- **幂等**：`permission.reply` 对已决请求 404（`[observed]` `evidence/tool-permission/commands.txt`）→
  保持 relay §14.8.2 的终态语义（删除记录、不重试）。reply 重试由扫描 ticker 驱动
  （每次重试都重新 `permission.reply`，opencode 侧幂等——已决即 404 终态）。
  同理，form 回写遇 `409 FormAlreadySettledError`（t13-probe P2）即已定案 → 删除记录、不重试。
  **（t13 修订，supersede 上两句的「404 终态」表述）**：form reply/cancel 的 **HTTP 404
  不再视为终态**——t13-probe P2 实测非宿主对 pending form 与宿主对已决 form 的
  get/reply/cancel **全部 404**（`FormNotFoundError`），404 无法区分「非本实例持有」与
  「form 不存在」；**仅 409 `FormAlreadySettledError` 是确认已决终态** → 删除记录、不重试，
  404 一律保留记录下轮重试（绝不删除共享记录）。permission 侧 `PermissionNotFoundError` 仅对
  **归属已确认**（`host_pid` 匹配的门先于调用运行）的宿主实例上是终态。以上终态删除**仅对
  归属门（`waitingRecordOwnedByThisInstance`，host_pid 匹配）通过的宿主实例生效**（见下条）。
- **apply 归属门（t13 修订 supersede r4 的 `session.get` 门，冻结）**：`scanReplyQueue` 在
  `applySessionReply` / `applyQuestionReply` / `applyQuestionReject` 之前，先
  `await this.waitingRecordOwnedByThisInstance(record)` 按记录 **`host_pid` 印章**确认归属
  （`host_pid === process.pid` 才 apply）；**非本实例 → 本轮跳过该记录**（不 apply、不删除、
  不置终态，下轮重试），并按 `request_id` 每实例只记一次 dline（info 级）：
  `reply scan: apply skipped: waiting record owned by another instance request=<id> session=<id> host_pid=<pid> pid=<pid>`。
  `host_pid` 缺失（旧版本记录）→ 过渡期沿用 r4 的 `client.session.get` 门
  （`sessionHostedByThisInstance`）——**共享存储拓扑下该门 fail open**（t13-probe P4：
  两进程 `session.get` 载荷逐字节相同），属已知过渡限制，待旧记录自然清空。
  目的：共享注册表（多个 server 指向同一 registry 根）下，非宿主 server 不得把回写打到
  自身并以自身 404 误删记录；终态（上条）只属于真正的宿主实例。**宿主印章 = 创建记录时收到
  asked 事件的进程 pid**（t13-probe P1：非宿主收到 0 个 session/form/permission 事件）。
  绝不用异常结果猜测归属；绝不按 pid 之外的条件删除记录。
- **resolved-reply 分类（r2，冻结）**：v2 client 对**已决**请求再 `permission.reply`
  抛的是**普通 `Error`** —— `name="Error"`、`message="Permission request not found:
  per_<id>"`、无 `status`/`statusCode`/`_tag`、无自有属性（实测
  `tests/e2e/container/evidence/harness-resolved-reply/reply-error-shape.json`；
  HTTP 层原始 404 body `{"_tag":"PermissionNotFoundError",...}` 见同目录
  `api-resolved-reply-http.json`）。**分类规则（F2/`401e7c1`，冻结）**：仅按该
  **精确文本** `^Permission request not found: per_` 归类终态 → 删除记录、不重试
  （relay §14.8.2 语义保持）；其它 Error 一律走可重试路径并记录原因日志——**不得**
  用宽泛子串放大终态面。status/statusCode===404 与 error name 含 404/NotFound 的
  既有分支继续有效。**（t13 限定）**：上述 404 终态判定**仅对归属门（`host_pid` 匹配，
   §3.3）已确认的宿主实例生效**——非宿主对 pending permission 也会返回
   `PermissionNotFoundError`（t13-probe P3，与宿主已决形态不可区分），但门先于调用运行，
   非宿主根本不会走到 `permission.reply`，故不会误删。
- **事务**：落盘仍走 `registry.mutate`（SharedFileStore 短临界区读写，既有契约不动；
  projects-registry.md §3/§4 零改动）。
- **超时/重试**：**不新增** client 超时包装（见上实现修订）；`permission.reply` 与 form
  回写的重试由扫描 ticker 自然驱动（幂等语义见上）；Telegram 侧 `telegramWithRetry` 不变
  **（t13：`telegramWithRetry` 永久 HTTP 400 不再重试——`answerCallbackQuery` 的
  "query is too old" 类重试必然同样失败；401 亦立即抛出；429/5xx/网络继续重试，见 relay
  §14.10.4）**。
- **事件顺序**：v2 envelope 按 emit 顺序到达插件流（SSE/总线保序，B1）；plugin 内
  `handleEvent` 逐条 `await`（现有 `track` 包装保留）。durable `seq` 仅供诊断，**不**做
  投影重放。
- **兼容迁移**：v1 的 `~/.otg/projects.json` 记录无需迁移（旧记录结构照常解析）；仅事件名/
  调用面换。**（t13 例外）**：`SessionRecord` 追加可选 `host_pid?: number`（strict parse：
  缺失 → 不含键、正整数 → 保留、其它 → 丢弃整条记录），因而 parse 白名单有一处**向后兼容**
  增项——旧记录（无 `host_pid`）解析为「缺印章」形态，消费端走 t10 `session.get` 过渡门
  （§3.3），不迁移、不重打印章，待旧记录 7 天 TTL 自然清空（relay §14.10.2/§14.10.5）。

---

## 4. 类型策略（冻结）

### 4.1 本地类型定义，零运行时 `@opencode-ai/*` 依赖

- 探针事实：本地 `.ts` 插件由 Bun 二进制直接编译加载（A2），无 node_modules、无 `.d.ts`
  类型来源可依赖；未验证（也不承诺）本地插件可 `import "@opencode-ai/*"`。
- **冻结：v2 类型全部本地定义**，新文件 `src/v2/types.ts`（03 已落地）：
  - `V2Client`（§3 方法子集的类型化面，含 `event.subscribe(): AsyncIterable<V2EventEnvelope>`）；
  - `V2EventEnvelope`（§2.0 形状）；
  - 各事件族 `data` 类型（`PermissionAskedData`、`FormCreatedData`、
    `InboxEnqueuedData`、`StepEndedData`、`ExecutionFailedData` 等，严格按 §2 表字段）；
  - `V2SessionInfo`/`V2PermissionRequest`（client API 返回形状）。
- `src/types.ts` 删除 `@opencode-ai/sdk`/`@opencode-ai/plugin` **类型 import**
  （`Todo`/`Session`/`AssistantMessage` 依赖随之移除；`SessionProjection.info` 改本地
  `V2SessionInfo`-equivalent 最小形状：`{id, title, projectID?, location?}`）；
  `PluginInput["client"]` 改 `V2Client`。
- `src/monitor.ts`：`import type { Session, AssistantMessage, Todo, Part, ToolPart } from
  "@opencode-ai/sdk"` 全部移除，改用本地类型；`isTodo` helper 删除（§6）。

### 4.2 对 `scripts/build.mjs` 的影响

- externals 调整：**移除 `--external @opencode-ai/plugin` 与 `--external @opencode-ai/sdk`**
  （不再有运行时 import；保留无害但会误导「宿主提供 SDK」的假设，03 一并删除）。
- `--define PLUGIN_VERSION` 注入流程**不变**（version-injection.md 契约不动）。
- **bundle 仍是单文件** `monitor.ts`（npm 分发路径不变，§5）；本地多文件开发不走 bundle。

---

## 5. 加载与分发（冻结）

### 5.1 配置数组与本地加载规则（探针实测，A2）

| 形态 | 结果 |
|---|---|
| `"plugin": ["/abs/path/plugin.ts"]`（绝对**文件**） | **拒绝**：日志 `configured plugin path must be a directory`；不加载；无事件（`evidence/file-path/`，events.jsonl 0 字节）。 |
| `"plugin": ["/abs/plugin-package"]`（绝对**目录**，`package.json` + `index.ts`） | **加载成功**：`loading plugin id=/abs/plugin-package entrypoint=file:///abs/plugin-package/index.ts`（`evidence/package-dir/`）。 |
| `<configDir>/plugin/*.ts` 自动发现（无需配置项） | **加载成功**；同时扫 `<configDir>/plugin/` 与 `<configDir>/plugins/`；该目录下**每个** `.ts`/`.js` 文件和每个子目录都当作插件（helper 放里面会被拒：`failed to load plugin ... Missing key at ["default"]`，`evidence/variants/arm-helper-in-plugin-server.txt`）。 |

- `[observed]` **双目录字段证据（t09，2026-09-25）**：本地 v2 实测从
  `<configDir>/plugins/monitor.ts`（**复数**目录）自动加载成功（日志
  `loading plugin id=/home/hipc/.config/opencode/plugins/monitor.ts`）；探针 A2 已证
  `<configDir>/plugin/`（单数）同样自动发现。**两目录均被扫描**；同一插件只放一处
  （README 安装章节同口径），避免重复安装混淆。
- 配置键：`"plugin"`（legacy，string 或 `[package, options]`）与 `"plugins"`
  （v2，string 或 `{package, options}`）都接受（A2）；裸名按包名解析。
- TS 由二进制内嵌 Bun 编译；`./x` 与 `./x.ts` 两种相对导入都实测可用（A2，
  `evidence/load`、`evidence/variants/arm-extless.jsonl`）；每个插件文件有各自的
  共享依赖模块实例（reload 后重置）。
- **冻结本地开发与发布形态**：
  - **本地手工安装**：把构建产物 `monitor.ts` 复制为 `<configDir>/plugin/telegram-session-monitor.ts`
    （或 `plugins/` 子目录内）。**单文件、无 helper 需求**——避开「helper 会被当插件」的坑。
  - **npm 包形态**：`package.json`（main→`monitor.ts`，`files` 含单文件 bundle）作为
    **目录包**被配置引用（裸包名或目录路径）；或解包后按本地单文件方式放置。
    06 文档化确切步骤；本契约只冻结「单文件 bundle 可被两种方式加载」这一事实。
  - **不得**把 `src/**` 多文件树作为插件目录直接配置（index.ts 依赖相对导入，
    目录包 entrypoint 也可工作，但 npm 分发仍以单文件为准，03 不额外承诺多文件形态）。

### 5.2 03 必须产出 / 06 必须文档化

- 03：`src/index.ts` 默认导出 `{id, setup}`（§1.2）；构建产物 `monitor.ts` 可被
  `<configDir>/plugin/` 自动发现加载（容器内探针配方验证，05 复用）；`bundle-smoke`
  断言 default 形状 + 无多余导出。
- 06：README 安装章节按 §5.1 重写（v2 本地路径、目录包形态、v1 用户留 0.6.x）；
  `package.json` 版本 1.0.0、peerDependencies 处理（v2 无运行时 SDK 依赖——
  移除 `@opencode-ai/plugin`/`@opencode-ai/sdk` peerDeps 或按 06 研判定）；自更新
  （npm 缓存路径，`OPENCODE_CACHE_MARKERS`）语义保持——替换的是被 npm 安装的目录包
  所在目录，与 v1 相同。

---

## 6. todo 移除（冻结；用户决策 2026-09-25）

探针 **4 路验证**（B5）：(a) client key/method 枚举无 todo；(b) `tool.list()` 60 工具无
todo 工具；(c) 全事件 + 原始 SSE 无 `todo.*`；(d) 二进制字符串搜索仅 migration SQL
（`todo` DB 表存在但无发布路径）→ **v2.0.15 todo 数据不可观测**。用户决议：**移除
todo 投影/命令相关代码与测试；README/文档不再宣称 Todo projection**（spec 决策 #7）。

### 6.1 代码/测试移除清单（03 执行，grep 无残留引用）

| 位置 | 移除内容 |
|---|---|
| `src/constants.ts` | `PLANNED_COMMANDS` 删除 `"todo"`（保留其它 planned 命令）。 |
| `src/types.ts` | 删除 `@opencode-ai/sdk` import（`Todo`）；`SessionProjection.todos` 字段（第 76 行）；`TodoCounts` 类型（128–134）及其注释（135）。 |
| `src/monitor.ts` | `todo.updated` case（715–721）；`reconcileSession` 的 todos 分支与 `todosReconciled`（1275/1306–1314，返回对象去掉 todos 键）；projection 初始化 `todos: []`（1403）；`isTodo`（3710–3715）；`formatTodos` import 与 `/todo` 命令 handler（2783 区）。 |
| `src/format/format.ts` | `TodoCounts` import（29）；`todoCounts`（124–132）；`todoSummary`（134–136）；`formatTodos`（737–785）；会话渲染中的 Todo 行（606–619、670–690）；helpText `/todo` 行（581）。 |
| 测试 | `tests/behavior.test.mjs`、`tests/sessions-poller.test.mjs`、`tests/poller-loop.test.mjs` 内若构造含 `todos` 字段的 projection/fakeClient → 一并删除字段；`bundle-smoke` 断言不变（不涉及 todo）。 |
| 文档 | `docs/00-overview.md`（**02 本轮改**）；README（06 改）。 |

### 6.2 Supersede 声明

- README 简介（"reports session lifecycle, token usage, todos and waiting
  permissions/questions"）与 `docs/00-overview.md` 中的 todo 描述 → 全部移除（06/02）。
- `src/format/format.ts` 的 `todoCounts/todoSummary/formatTodos` 删除即彻底移除，不做保留兜底
  （**禁止死代码保留**；v1 用户用的 0.6.x 是已发布产物，与主线无关）。

---

## 7. 测试替身形状（冻结，供 03/04/05）

### 7.1 fake v2 client（冻结接口）

```ts
// tests 共享（03 起在 behavior.test.mjs 冻结样板；04 在 sessions-poller 复用并扩展）
const fakeClient = {
  app: { name: "cli", version: "2.0.15", channel: "latest" }, // 纯元数据，无 log
  location: {
    directory: "/tmp",
    workspaceID: undefined,
    project: { id: "proj-test", directory: "/tmp", canonical: "/tmp" },
  },
  event: { subscribe: async () => [] }, // 测试不走 subscribe（05 才真订阅）；形状占位
  permission: {
    reply: async ({ sessionID, requestID, decision, message }) => {
      fakeClient.replyCalls.push({ sessionID, requestID, decision, message });
      // 可选故障注入：fakeClient.replyError 非空则 throw
    },
    list: async ({ sessionID }) => [],
    get: async ({ sessionID, requestID }) => ({ id: requestID, sessionID, action: "shell", resources: [] }),
  },
  session: {
    get: async ({ sessionID }) => ({
      id: sessionID, projectID: "proj-test",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, updated: 0 },
      title: "Test session",
      location: { directory: "/tmp" },
    }),
    create: async ({ title }) => ({ id: "ses-test", /* 同 get 形状 */ }),
    context: async ({ sessionID }) => [],
  },
};
```

- 方法返回**直接对象**（v2 client 不是 `{data: ...}` 包装；`session.get` 等直接返回对象，
  见 C2）。v1 测试里的 `{ data: ... }` 断言全部改。
- `fakeClient.replyCalls` 断言 04 的按钮回写：`permission.reply` 被调且参数精确
  `{sessionID, requestID, decision}`（decision = record.reply 原样透传 `"once"|"always"|"reject"`）。
- 04 删除 `postSessionIdPermissionsPermissionId` stub 与 `_client.post` stub（二者 v2 禁止）。
- 04 增 form 回写替身：`fakeClient.formReply` 或等价可注入的 HTTP 回写函数（按附录 A.1
  通道形状：`(sessionID, formID, answer)` → 204/401/400/404/409 可注入），断言 04 的
  `q_answers` 消费端用 `option.value` 组装 `{"answer": ...}`。

### 7.2 主类构造签名（冻结，03 起生效）

```ts
new TelegramSessionMonitor(
  client: V2Client,                 // 本地类型（§4.1），替代 PluginInput["client"]
  config: TelegramConfig,           // 不变
  root: string,                     // 传入 client.location.directory（§1.5）
  registry: ProjectRegistryStore,   // 不变
)
```

参数顺序/arity 不变；`initialize()`（**03 修订，r1**）：poller 先起 + 注册/自更新/
replyScan 后台启动；bootstrap/reconcile 已移除（v2 client 无 `session.list/status`，§3.3）。

### 7.3 `accept()` 输入决策（冻结）：**原始 v2 envelope**

- 决策：`accept(event: V2EventEnvelope)`——接收 `client.event.subscribe()` 原样产出的
  envelope（`{id, created, type, durable?, location?, data}`），由 `parseRuntimeEvent`
  在 monitor 内部把 `data` 归一化为现 `RuntimeEvent.properties`。
- 理由：contract-faithful（测试与真实流同形状，杜绝 index.ts 归一化层漂移）；
  复用 `rememberEvent(id)` 去重；`parseRuntimeEvent` 只改取值路径。
- 测试影响：v1 测试 `monitor.accept({id, type, properties})` 全部改为
  `monitor.accept({id, type, data})`（03 批量改写 behavior.test.mjs；04 改
  sessions-poller/poller-loop）。

---

## 8. 文件所有权与批次边界（冻结，批次内零交集）

| 批次 | 就绪条件 | 文件所有权 | 说明 |
|---|---|---|---|
| **03**（src 核心 + todo 移除） | 02 合入 | `src/**`、`tests/behavior.test.mjs`、`tests/e2e/bundle-smoke.test.mjs` | 入口/生命周期/会话与用量/todo 移除/类型策略落地；容器内可加载（探针配方）。 |
| **05**（容器 e2e + 真实 TG 冒烟） | 02 合入（与 03 同时就绪） | `tests/e2e/container/**`、新脚本（`scripts/*.sh` 或 `tools/*`，复用 `run-probe.sh` 基座） | 与 03/04 的 `src`/`tests/*.test.mjs` **零交集**；对适配后插件的 green-run 在 03/04 合入后由编排器调度。 |
| **04**（等待/审批适配） | 02 + 03 合入 | `src/**`（基于 03 合入后的新基线）、`tests/sessions-poller.test.mjs`、`tests/poller-loop.test.mjs` | 同文件串行（`src/monitor.ts`/`index.ts`/`types.ts` 与 03 冲突面）；permission 去抖/回写、inbox/form 向导、`permission.reply` 通道 + `q_answers` HTTP 回写（§3.2/A.1）。 |
| **06**（发布元数据 + 文档） | 03 + 04 合入 | `README.md`、`package.json`、`docs/00-overview.md` | 版本 1.0.0；README 移除 Todo 特性；00-overview 终态同步（02 先写契约指针版，06 做行为终态版，无提交冲突——03/04 不触碰 docs）。 |

**批次间依赖说明**：03 与 05 并行（文件零交集）；04 严格等 03（同文件）；
06 严格等 03+04（需描述最终行为）。05 的 e2e 编写可先行（对探针/桩插件验证机制），
对最终插件的 green-run 等 03/04。

**唯一集成测试编写所有者**：05（容器 e2e 断言 ≥ 生命周期 1 条 / 等待记录 1 条 /
回写闭环 1 条，issue 05 验收）。

**修订 1（2026-09-25）批次状态**：03 已合入 `0da0f3c`（src 核心 + todo 移除 + 本地 v2 类型）；
05 已合入 `2f29103`（容器 e2e harness + probe-a1 form 回复证据 + real-TG 只读配方）；
04 为下一就绪批次（同文件串行，基于 03 新基线）；06 仍等 03+04。05 对适配后插件的
green-run（含 harness 的 form 回写 P2b 与 A.6 类自然流 re-dispatch probe，§9）由编排器在
04 合入后调度。

---

## 9. 未冻结（证据不足，明确开放）

| 项 | 状态 | 处置 |
|---|---|---|
| `session.usage.recorded`（durable） | `[binary]` 目录存在，**探针未触发** | 03/04 不得接线；若 e2e 出现，按 §2.4 同形状处理并向 dev-lead 报告。 |
| `session.compaction.*` | 目录存在，**未触发**（长会话才可能） | 05 e2e 长会话若触发，评估对消息/上下文投影影响；本契约不含其语义。 |
| `effect` 返回语义 | effect 形态加载成功但 Effect 值消费未验证 | 冻结用 `setup`；effect 形态不承诺。 |
| `permission.updated`（v2） | 未在事件流观测 | 不接线（§2.5）；05 若观测到再决议。 |
| **form 回复通道**（原 A.1） | **已定案（05 probe-a1）**：进程内 HTTP Basic 回写（`POST /api/session/:id/form/:id/reply`，204），端口 argv 发现、密码双 env；`run --standalone` 端口不可发现 | 04 按 A.1/§3.2 实现；端口不可发现**显式失败、无兜底**。 |
| 真实模型提问自然流 | **已定案（05 probe-a1，§A.6 关闭）**：question tool → `form.created`（`metadata.kind="question"`），§2.6 成立 | 已并入 §2.6/§2.7。 |
**已关闭（r2，subagent lineage / parentID）**：父链接口**可观测** —— 子会话
`session.created` 数据与 `session.get` 结果均携带 `parentID`（根会话无此键；fork 走
`session.forked` + `parentID=null`，不属子链）。证据
`tests/e2e/container/probe-lineage/VERDICT.md` + `evidence/probe-lineage/**`
（probe `4dddc8e`）。src 已消费（F1，`401e7c1`：`src/monitor.ts` 合成 SessionInfo 写
`parentID`、`ensureSessionInfo` 缓存 `session.get` 原样结果；`src/v2/types.ts` 增
`SessionCreatedData.parentID?`），**恢复** v1 投影逻辑：`primarySession` /
`childSessions` / `synchronizeIdleDescendants` 根过滤与 `aggregateTokens` 子会话
token 聚合；无「永不填充」降级面。形状入 §2.1/§3.1。仍开放的项：
`session.usage.recorded` / `session.compaction.*` / `effect` 返回语义 /
`permission.updated`，处置如上表。

---

## 附录 A：open mapping items（需要的精确证据）

### A.1 form 答案回写通道（**已定案 05 probe-a1**，原 04 最大未决项）

- **通道（冻结）**：插件进程内对自身 server 的 loopback HTTP 回写——
  `POST http://127.0.0.1:<port>/api/session/<sessionID>/form/<formID>/reply`，
  `authorization: Basic base64("opencode:" + <password>)`、`content-type: application/json`、
  body `{"answer": {"<fieldKey>": <value>, ...}}` → **204**（form settled，`form.replied`
  在插件流与 `GET /api/event` 均可见）。
- **认证**：用户名固定 `opencode`（Basic challenge `realm="Secure Area"`）；密码取
  `process.env.OPENCODE_SERVER_PASSWORD`（serve 侧）或 `process.env.OPENCODE_PASSWORD`
  （client env）——**两者在插件进程内都可见**（05 实测 `probe.setup.envPresence`）。
  缺密码/错凭据 → 401（**Bearer 不接受**）；`400 FormInvalidAnswerError|InvalidRequestError`、
  `404 SessionNotFoundError|FormNotFoundError`、`409 FormAlreadySettledError`。
- **answer 值类型**（OpenAPI `Form.Value`）：string | number | boolean | array-of-string
  （multiselect）；选项字段提交 `option.value`（字符串），**不是** label。
- **补充 API**：`GET /openapi.json`（需认证，完整 OpenAPI 3.1，250037 字节）；
  `session.form.cancel` = `DELETE /api/session/<sid>/form/<fid>`；全局列表 `GET /api/form`
  —— 插件主流程只用 `reply`；`cancel`/列表留给诊断/向导可选，不强制。
- **端点发现（r4 修订，supersede 原「端口发现（限制，冻结）：`<port>` 仅从 `process.argv`
  解析；`opencode run --standalone`（`serve --stdio --port 0`）不可发现」段落）**：
  `resolveFormEndpoint()` 按下列优先级解析**本进程自身 server** 的回写端点；任一环节
  不完整即**显式失败**（记录原因日志；`q_answers`/`q_reject` 保持未应用，下轮 ticker 重试），
  **不得发明兜底**；`permission.reply` 的 client 通道不受影响：
  - **(a) argv `--port N` 或 `--port=N`**：端口 = N，密码取 `OPENCODE_SERVER_PASSWORD` /
    `OPENCODE_PASSWORD`。**argv 端口存在但 env 密码缺失 → 显式失败，不回落 service.json**
    （那多半属于另一个 server）；`--port 0`/非法值 → 显式失败（`run --standalone` 的
    随机端口不可发现）。
  - **(b) argv 无 `--port` 标志 → state `service.json`**：`$XDG_STATE_HOME` |
    `~/.local/state` + `/opencode/service.json`（v2 `serve --service` 注册
    `{id, version, url, pid, password}`，0600；legacy 形态 `{port, password}` 不在此路径）；
    多个 `service*.json` → 优先 `pid === process.pid` 的条目，否则默认 `service.json`；
    port 从 `url` 解析、password 取 `password` 字段；**`url` 必须为 loopback + http**
    （127.0.0.1 / localhost / [::1]，无凭据、无路径/查询串），否则拒绝——绝不把密码发往
    非本机地址。
  - **(c) legacy `~/.config/opencode/service.json`**：`{port, password}` 端口 + 密码对
    （port 必须正整数、password 非空；url 由插件固定按 `127.0.0.1` 构造）。
  - **(d) 均不完整 → 显式失败**，原因列出全部尝试过的来源。
  - 文件**每次尝试重新读**（不缓存；mtime 缓存可接受）；任何路径都绝不把密码写进日志。
  - `~` 解析优先运行时 `$HOME`、缺失才回落 `os.homedir()`（bun 的 `homedir()` 进程内缓存，
    不随 env 变化；不构成端点发现降级）。
- **证据**：`tests/e2e/container/probe-a1/VERDICT.md`（裁定 + 证据矩阵）；
  `tests/e2e/container/evidence/probe-a1/probe-a1.jsonl`（`probe.reply.http.attempt` 三次
  auth 尝试、`form.replied`）、`sse-raw.txt`；`probe.setup.*` 显示 `client.rpc` 仅
  `["register"]`、`client.session` 无 form/inbox 方法。
- **r4 证据（t10 实机修复，commit `5453956`）**：容器场景 `tests/e2e/container/assert/t10-cross.mjs`
  + `evidence/t10-cross/**`——A = `opencode serve --service`（argv 无 `--port`、env 无
  `OPENCODE_SERVER_PASSWORD`）经 state `service.json` pid 匹配发现自身端点并 apply 一次
  （204 → `form.replied` → 记录删除）；B = `serve --port 20000` + env 密码、共享注册表但
  非宿主 → 归属门 `client.session.get` `Session.NotFoundError` → skip（无删除，dline
  `apply skipped` 见 `tgdiag-after-b-skip.txt`）；负控 `evidence/t10-cross-prefix/**`
  复现修复前「非宿主 404 删记录、owner 无 `form.replied`」。
- **t13 共享多 server 拓扑（commit `2c95891c`，`tests/e2e/container/t13-probe/VERDICT.md`）**：
  `session.get` **fail-open 证据（P4）**：同一共享 DB 下 A/B 两进程 `GET /api/session/<sid>`
  载荷**逐字节相同**（`evidence/t13-probe/p4-session-get-a.json` vs `-b.json`；`p4-*.status`），
  故 t10 的 `session.get` 归属门在该拓扑 fail open；**宿主判定改走创建期 `host_pid` 印章**
  （relay §14.10 / §3.3），非宿主不删除、不 apply（t13-shared-cross 正控）。**路由语义表（P2/P3）**：

  | 调用 | owner pending | non-owner pending | owner settled | non-owner settled |
  |---|---|---|---|---|
  | `session.form.get`（`GET …/form/<fid>`） | **200** `state=pending` | **404** `FormNotFoundError` | 200 `state=answered` | **404** |
  | `session.form.reply`（`POST …/reply`） | **204** | **404** `FormNotFoundError` | **409** `FormAlreadySettledError` | **404** |
  | `session.form.cancel`（`DELETE …/<fid>`） | **204** | **404** `FormNotFoundError` | **409** `FormAlreadySettledError` | **404** |
  | `session.permission.get` | **200** | **404** `PermissionNotFoundError` | — | — |
  | `session.permission.reply` | **204** | **404** `PermissionNotFoundError` | 404 `PermissionNotFoundError` | 404 |

  → **409 是唯一确认已决终态**（owner-settled 的 reply/cancel 均 409）；**404 对 form 不可判终态**
  （non-owner pending 与 non-owner settled SAME shape，与 owner settled 的 409 区分）；permission
  的 `PermissionNotFoundError`（owner-settled 与 non-owner 均 404）**无 owner 侧判别**——`session.permission.get`
  是唯一 owner/non-owner 可区分的 permission 判别 API（owner 200 / non-owner 404，§A.1 补充 API），
  但本插件以 `host_pid` 门（先于调用运行）替代，无需该补充调用。P3 结论：非宿主**无法 settle**
  permission；宿主判定必须在 reply 调用**之前**完成（门先于调用）。证据
  `evidence/t13-probe/p2-*.status/p2-*.json`、`p3-*.json/status`；P5 `type:"multiselect"`
  round-trips（`p5-*.json`）验证 wizard `multiple = field.type === "multiselect"` 映射无 Bug。
- **harness 接口（05 e2e 契约，04 必须匹配）**：TG 向导最终提交 = 记录字段
  `q_answers: Array<Array<string>>`（relay §14 冻结字段；每题 = label/文本数组，按
  fields[] 顺序）。harness 以完全相同的外部写入注入：`inject_json_field "$FRMID"
  q_answers '[["A"]]'`（`tests/e2e/container/harness/scenario.sh` P2b）→ 断言记录删除 +
  `form.replied` 上线（`tests/e2e/container/assert/harness.mjs` H3.4/H3.5）。04 消费端：
  label → `option.value` → `{"answer":{fieldKey: value}}`（单选取首个、multiselect 取数组；
  与 `tests/e2e/container/harness/plugins/harness-stub.ts` 的 `buildAnswer` 行为一致）。
  如 04 改动字段名/语义，**必须同步更新 harness 与断言**。

### A.2 `session.usage.recorded`（见 §9）

### A.3 `session.compaction.*`（见 §9）

### A.4 `effect` 返回语义（见 §9）

### A.5 `permission.updated`（见 §9）

### A.6 自然提问流验证（**已关闭 05 probe-a1**）

- **结论**：question tool → `form.created`（`metadata.kind="question"`，
  `tool:{messageID, id:"call_..."}`），§2.6 生效；**不是** `inbox.user steer`。
  `questions[] -> fields[]` 键 `q0..qN`（`title=header`、`description=question`、
  `options=[{value:label, label, description}]`、`custom:true`）；插件经 A.1 通道回写 →
  `form.replied` → `session.tool.success` → `session.execution.succeeded`。
- 附带观察（headless）：`opencode run` 无 UI 呈现 form → 立即自动取消
  （`form.cancelled` → `session.tool.failed {type:"aborted"}` → `session.execution.interrupted
  {reason:"shutdown"}`）；`opencode serve` 下 form 保持 pending（TG 向导可服务的形态）。
- 证据：`tests/e2e/container/probe-a1/VERDICT.md` §A.6 + `tests/e2e/container/evidence/probe-a1/`
  （`probe-a1.jsonl` seq 38 form.created、seq 44 tool.success）、`api-natural-prompt.json`。

---

## 变更记录

- 2026-09-26 修订 6（contract revision r6，t13 field-fix 回写）：实机事故「TUI
  question/wizard/permission 对话框永不 resolved，宿主永不 apply」——两台 opencode server 共享
  `~/.otg/projects.json` 与 storage（`serve --service` 宿主 + 另一台 `serve`），NON-HOST 把 TG
  回写打到自身端点 → HTTP 404 → 旧代码判「已 settle」删共享记录 → 宿主永不 apply；t10
  `session.get` 归属门该拓扑 fail open（t13-probe P4：`p4-session-get-a/b.json` 逐字节相同）。
  修复（commit `2c95891c`）：① §3.3 归属门 supersede——记录落 `host_pid` 印章（创建进程 = 宿主，
  §2.6），apply 按 `waitingRecordOwnedByThisInstance`（`host_pid===pid`）判定；缺失旧记录过渡期
  走 t10 `session.get` 门；② §3.3 幂等/§A.1 终态分类——form reply/cancel **404 不再终态**
  （t13-probe P2 路由语义表：non-owner pending 与 settled 均 404、无 409），**唯 409
  `FormAlreadySettledError` 终态删记录**；permission `PermissionNotFoundError` 仅宿主（门先于
  调用）终态；§A.1 记录 t13 路由语义表 + P4/P2/P3 证据；③ §3.3 传输语义——`telegramWithRetry`
  永久 HTTP 400 不重试、401 立即、429/5xx/网络重试；callback catch 分支 400 不二次
  `answerCallbackQuery`（relay §14.10.4）。证据：`tests/e2e/container/assert/t13-probe.mjs` +
  `evidence/t13-probe/**`（P1–P5）、`assert/t13-shared-cross.mjs` + `evidence/t13-shared-cross/**`
  （正控 17/17）+ `evidence/t13-shared-cross-prefix/**`（负控 10/10 复现修复前误删）。
- 2026-09-26 修订 5（contract revision r5，t12 实机事故修复回写）：实机事故「一次 agent
  完成推送数条不同项目名的 Telegram 通知（同表内容），仅会话所属项目一条正确」——
  根因：v2 事件流每进程全局 + 插件按 location 多激活，`handleEvent` 无归属过滤。修复
  （commit `ca5ad92`）：① §2.0 冻结事件归属门（带 `location.directory` 严格
  resolve-equal；无 location 走 sessionID→directory 索引，`form.created` 取
  `data.form.sessionID`；不可归属即忽略 + 每目录/每（原因,类型）一次 dline；晚激活
  设计行为入契约）；② §1.3 进程级共享去重集合显式例外
  （`Symbol.for("opencode-telegram-monitor/seen-events")`、`MAX_EVENT_IDS`、归属门
  通过后才标记 → 同 root 重复激活折叠为一次）；§2.0 去重条目同步 supersede。证据：
  `tests/e2e/container/assert/t12-ownership.mjs` + `evidence/t12-ownership/**`
  （正控 8/8：同进程两 root → 恰一条 A 标注通知、B 记录 skip 诊断）+
  `evidence/t12-ownership-prefix/**`（负控 6/6：修复前同会话 2 条、A/B 两种标注
  ——实机签名）；行为断言 OWNERSHIP-001/002/003（`tests/behavior.test.mjs`）。
- 2026-09-25 修订 4（contract revision r4，t10 实机事故修复回写）：实机事故「TG 已显示
  ✅ Submitted，opencode TUI 提问仍 pending」——用户环境为 v2 `serve --service` 守护进程
  （argv 无 `--port`、env 无密码，旧 argv-only 发现不可用）+ 非宿主 ad-hoc server（同
  registry 根、不同进程）先 apply → HTTP 404 误判终态删记录、真宿主永不 apply。修复
  （commit `5453956`）：① §A.1 端点发现优先级（argv `--port N`/`--port=N` + env 密码，
  有端口无密码显式失败不回落 → state `service.json`（`$XDG_STATE_HOME|~/.local/state`，
  pid 匹配优先，url 必须 loopback http，0600 `{id, version, url, pid, password}` 实测形态）
  → legacy `~/.config/opencode/service.json` `{port, password}`；每次尝试重新读文件，
  密码永不入日志）；② §3.3 apply 归属门（`client.session.get` 失败 → 跳过不删除，
  `apply skipped` dline 每 request_id 每实例一次；404/409 终态删除仅宿主实例）；
  §3.2 同步指针。证据：`tests/e2e/container/assert/t10-cross.mjs` + `evidence/t10-cross/**`
  （正控：服务守护进程 apply 一次、非宿主 skip 无删除）+ `evidence/t10-cross-prefix/**`
  （修复前负控）。
- 2026-09-25 修订 3（contract revision r3，t09 实机事故修复回写）：§1.3 补多激活语义
  （同进程多次加载/激活）与 `setup() pid/root` 诊断行；§5.1 补双目录（`plugin/`/`plugins/`）
  加载字段证据；等待记录 `request_id` 幂等与 message_id 解包修正指向 relay
  `sessions-relay.md` §4.1/§4.2/§6.2/§14.8.3 行内 supersede（commit `8c807377`）。
- 2026-09-25 修订 2（contract revision r2，doc-prep follow-up）：§9 关闭 subagent
  lineage（parentID）开放项（probe-lineage VERDICT + evidence，`4dddc8e`；src 消费
  `401e7c1` F1）；§2.1/§3.1 记录子会话 `parentID?/agent?/model?` 实测形状；§3.3 冻结
  resolved-reply 分类规则（F2 精确文本终态，证据 `evidence/harness-resolved-reply/**`）；
  README 同步已修复 statements 与检查计数。
- 2026-09-25 修订 1（doc-prep follow-up，Ticket 03/05 落地后）：§9/A.1 + §A.6 定案
  （form 回复通道 = 进程内 HTTP Basic 回写，证据 `tests/e2e/container/probe-a1/VERDICT.md`
  + `evidence/probe-a1/**`，05 `2f29103`）；03 实现修订同步（§1.6/§3.1/§3.3/§7.2/§8：
  bootstrap/reconcile/status 移除、无新超时包装）；§2.6 增 `form.metadata?`；§2.7 自然流
  定案；§9 新增 subagent lineage（parentID）开放项；§7.1 增 form 回写替身；§8 批次状态更新。
- 2026-09-25 冻结（Ticket 02）：本文档建立。依据 01 探针证据（`tools/v2-probe/FINDINGS.md` +
  `evidence/**`）；supersede 记入 sessions-relay.md 头部行内标注 + §11；
  docs/00-overview.md 同步指针与目标版本。
- Tickets 依据：`.scratch/opencode-v2-adaptation/issues/02-freeze-v2-contract.md`。
