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

### 1.3 一次激活一次 setup；模块状态在 reload 后重置

- `[observed]` `setup` 每次激活恰一次（`load`/`api`/`variants` 全部场景）。
- `[observed]` `opencode reload` 序列：`probe.dispose` → `probe.event-stream.ended` →
  **新 `probe.setup`（同 pid）**，新激活的模块级状态（seq 计数）从 1 重新开始——
  **插件模块被重新 import**（`evidence/api/events.jsonl` 搜 `probe.dispose`/`probe.setup`）。

**冻结推论：所有可变状态必须挂在 `TelegramSessionMonitor` 实例上**，禁止模块级可变状态
（常驻心跳用实例字段管理，dispose 清理）。v1 `monitor.dispose()` 已覆盖 timers/intervals/
锁/在途任务，平移即可；新增的 `event.subscribe` 迭代器也要在 dispose 中止（AbortController）。

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
构造签名冻结于 §7.2；构造完成后 `monitor.initialize()`（v1 语义：立即起 Telegram poller，
后台 bootstrap 对账）。**不在 index.ts 做任何事件归一化**——envelope 原样交给 `accept()`。

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
- 事件去重集合（`seenEventIDs`/`seenWaitingRequestIDs`/`terminalMessageIDs`，`MAX_EVENT_IDS`）
  机制保持；v2 envelope `id` 全局唯一（`evt_` 前缀），按原逻辑去重即可。

### 2.1 会话投影（session.created / deleted / execution.*）

| v2 事件 | 消费的 `data.*`（精确字段，observed） | 映射到 v1 内部语义 |
|---|---|---|
| `session.created` | `{sessionID, projectID?, location?, subpath?, slug?, title, version?, permissions?}`（`durable.seq:0`） | v1 读 `properties.info`(Session)；v2 无 info → **本地合成最小 SessionInfo**：`{id: data.sessionID, title: data.title ?? data.slug, projectID, location:{directory: data.location?.directory ?? root}}`；写 `sessionInfo` 并挂到 `projection.info`。**不**在 v1 的 `session.updated`（v2 不存在）上做。 |
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
reply API（§3、§7）。

### 2.6 等待记录：question = form.*（替代 question.asked）

- `[observed]` v1 `question.asked` 的 v2 替代是 **form 系统**（B3）：
  `form.created` / `form.replied` / `form.cancelled`。

| v2 事件 | 消费的 `data.*`（精确字段） | 映射 |
|---|---|---|
| `form.created` | `data.form:{id, sessionID, title, fields:[...]}`；`fields[]` 项 = `{key, title, type, options?:[{value, label, description?}], custom?:boolean, required?, hidden?, when?, format?, minLength?, maxLength?, pattern?, default?}`（`type in "string"|"number"|"integer"|"boolean"|"multiselect"|"external"`） | `addWaiting(sessionID, {requestID: data.form.id, type:"question", summary: safeText(data.form.title ?? fields[0]?.title ?? "OpenCode question", 120, ctx)})`。**完整 fields 数组随 `properties` 原样 JSON 落盘**（relay §4.2 message=完整 payload），供 TG 向导（relay §14）渲染：**每个 field = 一个向导 stage**（title=问题文案、type 映射 §14 题目类型、options=选项、custom=允许自定义输入、multiselect=多选）。 |
| `form.replied` | `{id, sessionID, answer:{key: value, ...}}` | 取消 question waiting（同 v1 question.replied 语义：`cancelWaitingNotify(requestID)` + `resolveWaitingRecord(requestID)`）。 |
| `form.cancelled` | `{id, sessionID}` | 取消 question waiting（同 v1 question.rejected 语义）。 |

- TG 向导按钮/纯文本捕获/状态机（relay §14.1–§14.9）机制与落盘结构保持；v2 只换
  「事件 ↔ 记录」两端的事件形状。**向导到 form 的字段形态映射以本表为唯一输入**，
  04 不得发明 `questions: [{header, question}]` 之外的 v1 形状。
- **form 回复的「应用」通道未冻结**（客户端 surface 无 form 命名空间），见附录 A.1——
  04 不得使用 v1 `_client.post` 私货猜测通道。

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
- **open mapping**：真实模型提问自然流（question tool → ?）在探针中未触发（附录 A.6）；
  若 05 e2e 发现自然流是 `inbox.user steer` 而非 `form.created`，回看本表 §2.6/§2.7
  是否需新增 waiting 来源——届时由 dev-lead 决议，本契约不预先发明。

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
| `client.session.get({sessionID})` | — | 会话对象（直接返回，非 `{data}` 包装）：`{id, projectID, cost, tokens:{input,output,reasoning,cache:{read,write}}, time:{created,updated}, title, location:{directory}}`（C2，`probe.session.get`） | `ensureSessionInfo`（title 兜底）与 reconciliation 的唯一会话查询；**替代** v1 `session.get({path})` 包装形态。 |
| `client.session.create({title})` | — | 同 get 形状 | 探针验证可用；主插件**不消费**（冻结：不创建会话）。 |
| `client.session.context({sessionID})` | — | 消息数组（compaction 后）；新会话 `[]`（C2） | 诊断可选；**不消费**到投影（v1 reconcile 的 messages/todo 已移除，§2.1/§2.4）。 |

### 3.2 明确不使用的 API（状态决策，冻结）

| API / 能力 | 决策 | 理由 |
|---|---|---|
| `client.storage.*`（get/set/remove/scan，key 按 `plugin:<hex-id>:` 命名空间） | **不使用** | 自有 `~/.otg/` 落盘（telegram.json/projects.json/tgdiag.log/*.lock）v1 语义已 116 用例覆盖；迁移到 v2 storage 无收益且有既有数据兼容成本（spec 决策：全量功能对齐，落盘语义不动）。 |
| `client.app.log` | **不存在**（app 仅元数据） | 日志走既有 `dline`/console 路径：`monitor.log()` 方法改为 dline/console（保留现 fallback；无 app.log 时永不抛）。 |
| `client.session.list` / `session.messages` / `session.todo` | **不存在**（C3） | bootstrap/reconcile 相应移除；HTTP API 有等价物（`GET /api/session`、`/api/session/:id/message`），第三方测试可用，插件内**不**引入 fetch 通道（除附录 A.1 未决项）。 |
| `client.tui` | **不存在** | v1 亦仅 v1 TUI 用。 |
| `(client as any)._client.post` 及任何扁平 question/reply 私货 | **禁止**（issue 04） | v1 实机修复轮的私货通道；v2 契约面明确（permission.reply）或未决（form 应用通道，附录 A.1）。 |
| HTTP `fetch` 到自身 server | 默认**不使用**；仅当附录 A.1 证据齐备且 dev-lead 决议后才允许 | 保持插件只依赖 client 契约面；不入 SSE/HTTP 竞态。 |

### 3.3 幂等/事务/超时/事件顺序语义（适用项冻结，不适用项注明）

- **幂等**：`permission.reply` 对已决请求 404（`[observed]` `evidence/tool-permission/commands.txt`）→
  保持 relay §14.8.2 的 404 终态语义（删除记录、不重试）。reply 重试由扫描 ticker 驱动
  （每次重试都重新 `permission.reply`，opencode 侧幂等——已决即 404 终态）。
- **事务**：落盘仍走 `registry.mutate`（SharedFileStore 短临界区读写，既有契约不动；
  projects-registry.md §3/§4 零改动）。
- **超时/重试**：client 方法若挂起，沿用 `withTimeout` 8s 守卫 + 退避重试（bootstrap 现状保留）；
  Telegram 侧 `telegramWithRetry` 不变。
- **事件顺序**：v2 envelope 按 emit 顺序到达插件流（SSE/总线保序，B1）；plugin 内
  `handleEvent` 逐条 `await`（现有 `track` 包装保留）。durable `seq` 仅供诊断，**不**做
  投影重放。
- **兼容迁移**：v1 的 `~/.otg/projects.json` 记录无需迁移（record 结构不变）；仅事件名/
  调用面换，`SessionRecord` 结构与 parse 白名单零改动。

---

## 4. 类型策略（冻结）

### 4.1 本地类型定义，零运行时 `@opencode-ai/*` 依赖

- 探针事实：本地 `.ts` 插件由 Bun 二进制直接编译加载（A2），无 node_modules、无 `.d.ts`
  类型来源可依赖；未验证（也不承诺）本地插件可 `import "@opencode-ai/*"`。
- **冻结：v2 类型全部本地定义**，新文件 `src/v2/types.ts`：
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

### 7.2 主类构造签名（冻结，03 起生效）

```ts
new TelegramSessionMonitor(
  client: V2Client,                 // 本地类型（§4.1），替代 PluginInput["client"]
  config: TelegramConfig,           // 不变
  root: string,                     // 传入 client.location.directory（§1.5）
  registry: ProjectRegistryStore,   // 不变
)
```

参数顺序/arity 不变；`initialize()` 行为不变（poller 先起 + 后台 bootstrap）。

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
| **04**（等待/审批适配） | 02 + 03 合入 | `src/**`（基于 03 合入后的新基线）、`tests/sessions-poller.test.mjs`、`tests/poller-loop.test.mjs` | 同文件串行（`src/monitor.ts`/`index.ts`/`types.ts` 与 03 冲突面）；permission 去抖/回写、inbox/form 向导、`permission.reply` 通道。 |
| **06**（发布元数据 + 文档） | 03 + 04 合入 | `README.md`、`package.json`、`docs/00-overview.md` | 版本 1.0.0；README 移除 Todo 特性；00-overview 终态同步（02 先写契约指针版，06 做行为终态版，无提交冲突——03/04 不触碰 docs）。 |

**批次间依赖说明**：03 与 05 并行（文件零交集）；04 严格等 03（同文件）；
06 严格等 03+04（需描述最终行为）。05 的 e2e 编写可先行（对探针/桩插件验证机制），
对最终插件的 green-run 等 03/04。

**唯一集成测试编写所有者**：05（容器 e2e 断言 ≥ 生命周期 1 条 / 等待记录 1 条 /
回写闭环 1 条，issue 05 验收）。

---

## 9. 未冻结（证据不足，明确开放）

| 项 | 状态 | 处置 |
|---|---|---|
| `session.usage.recorded`（durable） | `[binary]` 目录存在，**探针未触发** | 03/04 不得接线；若 e2e 出现，按 §2.4 同形状处理并向 dev-lead 报告。 |
| `session.compaction.*` | 目录存在，**未触发**（长会话才可能） | 05 e2e 长会话若触发，评估对消息/上下文投影影响；本契约不含其语义。 |
| `effect` 返回语义 | effect 形态加载成功但 Effect 值消费未验证 | 冻结用 `setup`；effect 形态不承诺。 |
| `permission.updated`（v2） | 未在事件流观测 | 不接线（§2.5）；05 若观测到再决议。 |
| **form/inbox 的插件内回复通道**（A.1） | client surface 无 form/inbox 命名空间；HTTP `session.form.reply` 存在但**插件内调用方式未验证** | 04 阻塞项；证据见附录 A.1。 |
| 真实模型提问自然流（question tool → form? inbox?） | 探针未用模型自然触发提问 | 05 必测项；若与 §2.6 假设不符，dev-lead 决议。 |

---

## 附录 A：open mapping items（需要的精确证据）

### A.1 form 答案回写通道（04 最大未决项）

- 事实：插件 client surface **无 form 命名空间**（C1）；HTTP API 有
  `session.form.list/create/get/reply/cancel`、`session.inbox.list/cancel/update`（B3，
  `[binary]` + `opencode api` 实测：`session.form.reply --param sessionID=... --param
  formID=... -d '{"answer":{"key":"value"}}'`，`evidence/api/commands.txt`）。
- 未验证：插件进程内如何带认证调该 HTTP（`OPENCODE_SERVER_PASSWORD` /
  `OPENCODE_PASSWORD` 环境变量是否对插件可见；serve 未设密码时行为）。
- **需要的证据**（05/04 补充探针）：在插件 `setup` 内 `fetch("/api/session/:id/form/:id/reply")`
  对比 `client.permission.reply` 的认证形态（探针已证明 permission 有 client 方法，
  form 没有）；记录成功/失败及必要 header。证据齐备后由 dev-lead 决议通道选型并修订本契约；
  **在此之前 04 不得实现 question→form 回写**（TG 向导的「回复应用」步骤保持未接线，
  通知与记录照常，属范围截断而非降级路径）。

### A.2 `session.usage.recorded`（见 §9）

### A.3 `session.compaction.*`（见 §9）

### A.4 `effect` 返回语义（见 §9）

### A.5 `permission.updated`（见 §9）

### A.6 自然提问流验证（05 必做）

- 需要证据：容器内用真实模型（`hipc/opencode2:latest` 免费模型）触发一次「模型向用户提问」
  （如让模型用 question 工具或要求澄清），记录原始事件序列。若为 `form.created`（预期）→
  §2.6 生效；若为 `session.inbox.enqueued {item.type:"user", delivery:"steer"}` 无 form →
  dev-lead 决议是否把 steer 提问升级为 waiting 记录（本契约当前冻结为不产生，§2.7）。

---

## 变更记录

- 2026-09-25 冻结（Ticket 02）：本文档建立。依据 01 探针证据（`tools/v2-probe/FINDINGS.md` +
  `evidence/**`）；supersede 记入 sessions-relay.md 头部行内标注 + §11；
  docs/00-overview.md 同步指针与目标版本。
- Tickets 依据：`.scratch/opencode-v2-adaptation/issues/02-freeze-v2-contract.md`。
