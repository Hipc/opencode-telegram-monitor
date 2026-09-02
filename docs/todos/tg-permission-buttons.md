# TG permission 按钮 + 回写应用闭环（round 2）

> 状态: planning
> 创建: 2026-09-02
> 当前轮次: Round 1
> 关联文档: docs/modules/sessions-relay.md（上轮冻结契约，本轮多处 supersede）、docs/todos/sessions-tg-relay.md（上轮交付）

## 背景

上轮已交付：permission/question 等待记录落盘 `projects.json`（sessions 数组），poller.lock
持有者每秒扫描发送 TG，resolved 由 replied 事件置位（只读设计）。

本轮：permission 类型的 TG 消息渲染**三个按钮**（Allow once / Allow always / Deny）；
用户点击 → 主进程把值写入记录新增的 `reply` 字段 → **拥有该 session 的 opencode 进程**
每秒扫描自己项目的 sessions，发现新 reply → 调 opencode permission reply API 应用到
真实 session → 应用成功后置 `resolved=true`。本轮只做 permission（question 后续）。

**注意：本轮打破「绝不代答」只读设计**（README / docs/00-overview.md 有此声明）——
用户明确要求，须同步修订文档并做 supersede 记录。

## 已确认的关键决策（用户 grilling 确认，2026-09-02）

1. `reply` 字段：**可选**，默认 `null`；取值 `"once" | "always" | "reject"`
   （opencode 官方回复枚举，消费端直接透传不映射）。
2. 按钮**只加在 `type === "permission"`** 的记录消息上；question 记录本轮不变（无按钮）。
   发送通道复用现成 `sendMessageWithKeyboard` + `reply_markup`（/menu 键盘同款生产通道）。
3. callback_data：沿用 `otg:` 前缀风格，新格式 `otg:perm:<requestID>:<once|always|reject>`。
   ⚠️ Telegram callback_data 上限 64 字节——实现时核验 requestID 实际长度，超限时需缩短方案
   （如 hash 映射），不得静默截断。
4. 点击处理（主进程 `handleCallback` 新分支）：校验 `from.id === chatId` →
   `mutate(setSessionReply(requestID, value))` → `answerCallbackQuery` 提示（如「已允许一次」）→
   **编辑原消息移除按钮 + 追加结果行**（如 ✅ Allowed once / ❌ Rejected），防重复点击。
5. 消费端：**每个 opencode 实例**跑 1s 扫描器（`initialize()` 挂载、`dispose()` 清理 timer），
   只扫自己 root（`findRegistryEntry(reg, this.root)`）条目；筛选
   `reply != null && resolved == false` 的 permission 记录 → 调 opencode reply API 应用 →
   **应用成功后** `mutate` 置 `resolved=true`；失败 logWarn 下轮重试。
6. **resolved 双路径并存**：TG 回写由应用成功置 true；TUI 处理仍由 `permission.replied`
   事件即时置 true（上轮 `resolveWaitingRecord` 逻辑保留，先到先得，另一方发现已 resolved 跳过）。
   poller 发送条件更新为 `send === false && resolved === false && reply == null`（防御）。
7. SDK 签名核验：官方通道 `POST /session/{id}/permissions/{permissionId}/reply`，body
   once/always/reject（GitHub issue #41325 经 SDK 源码核验；SDK 文档列
   `postSessionByIdPermissionsByPermissionId({path, body})`）。**实现时必须从本机 opencode
   1.18.23 安装里读 `@opencode-ai` SDK 类型（types.gen.d.ts）核验精确签名**；无法核验时按
   #41325 形态实现并在返回报告标注。
8. registry：`reply` 进 parse 白名单（**可选字段**，兼容旧文件无此字段/为 null/非法值丢记录不抛错）；
   新增 `setSessionReply(reg, requestID, reply)` 纯函数（现有 `markSessionFlag` 只能置 true，
   不复用）；无匹配返回 undefined 走 mutate 不写盘，幂等。
9. 扫描间隔复用 `SESSIONS_SCAN_INTERVAL_MS = 1_000`（constants.ts 不新增常量）。
10. 并发消费防重：同项目多实例同时扫到同一 reply → 都会尝试 apply；opencode 端对已决
    permission 的二次 reply 会失败被捕获（logWarn），随后仍置 resolved=true 幂等兜底——容忍此
    竞态，不引入认领机制（保持简单）。

## 涉及范围

- **新增**: 无新文件（测试扩展现有文件）
- **修改**:
  - `src/registry/index.ts`（SessionRecord.reply、parse 白名单、setSessionReply）
  - `src/monitor.ts`（发送端按钮 + handleCallback perm 分支 + 每实例 reply 消费扫描器 + initialize/dispose）
  - `src/format/format.ts`（permission 记录键盘构建函数，复用 TelegramInlineButton 类型）
  - `src/types.ts`（TelegramCallbackQuery.message 追加 text?: string，供 perm 分支编辑原消息）
  - `tests/registry-sessions.test.mjs`（REG-201）、`tests/sessions-poller.test.mjs`（API-101~104）
- **文档修订**: docs/00-overview.md（已完成，本轮）、docs/modules/sessions-relay.md（已完成，§13 + supersede）、
  **README.md 只读声明（doc-prep 无 docs/ 外写权限，移交 dev-lead 另行指派——见断点记录）**
- **依赖**: 上轮 sessions 机制（已交付）；两把锁语义不变；opencode 1.18.23 本机安装（SDK 核验）

## 上下文（探索结论）

- **opencode 回复枚举**：`once` / `always` / `reject`（opencode.ai/docs/permissions +
  assistant-ui 集成层一致；TUI 快捷键 a=allow、A=allow for session、d=deny 对应）。
- **SDK 通道**：`POST /session/{sessionID}/permission/{requestID}/reply`（issue #41325，经
  monorepo 实际 schema 核验）；SDK 文档列 `postSessionByIdPermissionsByPermissionId({path, body})`
  返回 boolean。精确 TS 签名本地不可得（peerDep 无 node_modules），**须核验本机安装**。
- **Telegram 发送**：`telegramRequest` body 原样透传（client.ts:50-102）；
  `sendMessageWithKeyboard(text, replyMarkup)`（monitor.ts:1969-1979）已支持 reply_markup；
  `enqueueMessageWithKeyboard`（1949-1959，sendTail 串行）。⚠️ `sendRichMessage` 非官方 Bot API
  方法名——但 /menu 键盘经此通道生产可用（部署环境事实），本轮沿用。
- **callback_query**：getUpdates `allowed_updates: ["message","callback_query"]` 已开启
  （monitor.ts:1448-1459）；`handleTelegramUpdate`（1608-1650）→ `handleCallback`（1833-1899，
  正则 `/^otg:([a-z]+)(?::([0-9a-f]{12}))?(?::([01]))?$/`——**新 perm 动作需新正则分支**，
  requestID 是长串不匹配现有正则）；`answerCallback`（1901-1911，answerCallbackQuery）。
  编辑消息：现有 `editMenuMessage` 可参考（editMessageText 通道）。
- **scanSessionQueue**（monitor.ts:1534-1578）：registry.read → 遍历全部条目 sessions →
  筛选发送 → `sendMessage(formatSessionRecordMessage(...))`（1587-1606，纯 string）。
  加按钮需改为 `sendMessageWithKeyboard` + 键盘构建。
- **registry**：`SessionRecord`（index.ts:23-32，8 字段）、`parseSessionRecord` 严格白名单
  （90-117）、`markSessionFlag`（254-280，只置 true）、`appendSessionRecord`（209-226）、
  mutate 锁语义（357-416，不变）。
- **每实例挂载点**：`initialize()`（158-169）挂 runTelegram/bootstrap/scheduleRegistration/
  scheduleSelfUpdate；`scheduleRegistration`（458-473）setTimeout 链式自排可仿；
  `dispose()`（412-443）统一清 timer——新扫描器 timer 必须补清理；
  `scanSessionQueue` 的 in-flight 守卫（1499-1516）可复用模式。
- **消费点现状**：`resolveWaitingRecord`（上轮新增，约 990 行）在 permission.replied 等事件
  置 resolved——保留（双路径之一）。
- 测试基建：bun 无框架、HOME 隔离、stub sendMessage/monitor 方法直接驱动内部方法
  （sessions-poller.test.mjs 已有先例）；registry 测试临时目录 + 独立 store 实例。

## 最终验证测试任务

> 累计维护（含上轮全部对外面，保证回归）。

### 外部接口测试

**本轮新增：**
- [API-101] 按钮渲染：permission 记录发送时消息带 inline_keyboard 三按钮（Allow once /
  Allow always / Deny），callback_data 格式 `otg:perm:<requestID>:<once|always|reject>`；
  question 记录发送时**无**键盘。来源：决策 #1/#2。
- [API-102] 回调写入：模拟 callback_query（合法 chatId）点击 → 记录 `reply` 被写为对应值
  （once/always/reject 三值各验）；answerCallbackQuery 被调用；原消息被编辑（按钮移除+结果行）；
  非法 chatId 拒绝。来源：决策 #3/#4。
- [API-103] 回写应用：记录 `reply=once/always/reject` 且 `resolved=false` → 所属实例扫描器
  调 opencode reply API（stub 断言 sessionID/requestID/response 透传正确）→ 成功后
  `resolved=true`；`reply=null` 或已 resolved 的记录不触发调用。来源：决策 #5/#6。
- [API-104] 双路径与重试：① 消费时 apply 失败 → resolved 保持 false，下轮重试成功；
  ② 记录已被 replied 事件置 resolved=true（TUI 路径）→ 扫描器跳过不调用 API；
  ③ poller 对 `reply != null` 的未发送记录不发送（防御条件）。来源：决策 #5/#6。
- [REG-201] registry reply 往返：parse/serialize 保留 reply（null/缺失/合法值/非法值容错）；
  setSessionReply 按 request_id 精确匹配写入、无匹配返回 undefined、幂等。来源：决策 #8。

**上轮回归（必须全绿）：**
- [API-001~005] behavior.test.mjs（写入/去抖/resolved 回写/并发）
- [API-006] sessions-poller.test.mjs（扫描发送语义——注意发送条件新增 reply==null 防御后的兼容）
- [REG-101] registry-sessions.test.mjs（sessions 往返）
- [LOCK-001~005] registry-concurrency.test.mjs
- [BUILD-001] `node scripts/build.mjs` exit 0
- [BUILD-002] `bun tests/e2e/bundle-smoke.test.mjs`（default 导出形态约束）

### 界面（UI）测试

- 无（TG 按钮行为由 API-101/102 stub 断言覆盖）。

### 本轮回归重点（修复轮次填写）

- （Round 1 首轮，暂无）

## Round 1

### Phase 1.1: registry reply 字段 ⬜

**目标**: SessionRecord 增加 reply 可选字段（白名单兼容）、新增 setSessionReply 纯函数。
**契约**: docs/modules/sessions-relay.md §13.1/§13.2（reply 字段语义与 parse 容错、setSessionReply 三态签名——照此实现）
**并行组**: 批次 A（先行，1.2/1.3 依赖）
**触碰范围**: `src/registry/index.ts`（SessionRecord 类型 23-32、parseSessionRecord 90-117、
导出纯函数区新增 setSessionReply）；`tests/registry-sessions.test.mjs`（追加 REG-201 用例）。
**不改** mutate/锁/既有纯函数语义。**分支**: `phase-r2-p1.1`　**worktree**: `.worktrees/phase-r2-p1.1`
**任务**:

- [ ] `SessionRecord` 增加 `reply?: "once" | "always" | "reject" | null`（语义：null/缺失=未回复；三值=待应用/已写入，透传不映射）
- [ ] `parseSessionRecord` 白名单扩展：reply 缺失→键不存在（serialize 自动省略，旧文件往返不新增键）、null→null、合法三值→原样、其它非法值→丢该记录（与现有严格白名单风格一致，不抛错）
- [ ] 新增导出纯函数 `setSessionReply(reg, requestID, reply): ProjectRegistry | undefined`：**全局 request_id 精确匹配**（与 markSessionResolved 同风格，跨全部条目找第一条）；写入 reply 值；无匹配返回 undefined（mutate 不写盘）；幂等（同值返回原引用）；仅改 reply 字段、不读/不改 send/resolved。**不复用 markSessionFlag**（只能置 true boolean）
- [ ] `tests/registry-sessions.test.mjs` 追加 REG-201 用例（往返/null 兼容/非法值容错/setSessionReply 三态）

**验收标准**:

- [ ] REG-201 全绿；REG-101 与 LOCK-001~005 回归全绿
- [ ] 旧格式 projects.json（无 reply 键）解析往返不新增键、不丢记录
- [ ] `node scripts/build.mjs` exit 0

### Phase 1.2: 发送端按钮 + 回调写入 ⬜

**目标**: permission 记录的 TG 消息带三按钮；点击回调写入 reply 字段 + answer + 编辑消息。
**契约**: docs/modules/sessions-relay.md §13.3~§13.5/§13.7/§13.9（键盘构建、发送通道、callback_data 与
64 字节核验、handleCallback perm 分支序列、编辑区间、测试锚点——照此实现）
**并行组**: 批次 B（依赖 1.1 合并；与 1.3 同批并发——同文件不同区域）
**触碰范围**: `src/monitor.ts`（**scanSessionQueue 区（1534-1578）+ handleCallback/answerCallback 区
（1833-1911）+ format import 区（48-60）**；**不得触碰** initialize/dispose/字段区（140-169/412-443）与
stopSessionsScan~scanSessionQueue 之间空白区（1524-1526，1.3 地盘））；
`src/format/format.ts`（新增 buildSessionPermissionKeyboard，复用 TelegramInlineButton 类型，
不放 monitor.ts 以免与 1.3 冲突）；`src/types.ts`（TelegramCallbackQuery.message 追加 text?: string）；
`tests/sessions-poller.test.mjs`（追加 API-101/102，**锚点在 API-006-5 用例收尾 `);` 之后**，见契约 §13.9）。
**分支**: `phase-r2-p1.2`　**worktree**: `.worktrees/phase-r2-p1.2`
**任务**:

- [ ] `src/format/format.ts` 新增导出 `PERM_CB_PREFIX = "otg:perm:"` 与 `buildSessionPermissionKeyboard(entryID)`：
      一行三按钮 Allow once/Allow always/Deny，callback_data `otg:perm:<entryID>:<once|always|reject>`；
      **entryID 由 monitor 侧保证 callback_data ≤64 字节**（monitor 新增 `permissionEntryID(requestID)` +
      `permShortMap: Map<shortID, requestID>`，超限截 44 字符 + 登记映射；禁止静默截断；多字节仍超限 → logError
      且该记录不发按钮）。实测 requestID 长度写入任务报告
- [ ] `scanSessionQueue`：permission 记录改 `await this.sendMessageWithKeyboard(text, keyboard)`（**awaitable，
      成功判定/置位语义与 §6.2 不变**；question 记录维持 `await this.sendMessage` 无键盘）；**不用
      enqueueMessageWithKeyboard**（fire-and-forget，无法维持 markSessionSent 时机）；发送条件更新为
      `send === false && resolved === false && reply == null`（决策 #6 防御）；formatSessionRecordMessage 零改动
- [ ] `handleCallback` 在通用正则（1837）**之前**新增 perm 判定（`startsWith(PERM_CB_PREFIX)`，正则
      `/^otg:perm:(.+):(once|always|reject)$/`）：还原 requestID（permShortMap 兜底 raw）→
      `mutate(setSessionReply(requestID, value))`（undefined → answer「记录不存在或已失效」(alert) + logWarn +
      不编辑消息）→ `answerCallback`（once「已允许一次」/ always「已允许总是」/ reject「已拒绝」）→
      **编辑原消息**（新增私有 `editPermissionResultMessage(chatID, messageID, originalText, value)`：
      editMessageText 原文 + 结果行 ✅ Allowed once / ✅ Allowed always / ❌ Rejected，**不传 reply_markup
      移除键盘**）；编辑失败 logWarn 不中断；**不落入末尾 editMenuMessage 菜单刷新**
- [ ] `src/types.ts`：`TelegramCallbackQuery.message`（88-96）追加 `text?: string`
- [ ] `tests/sessions-poller.test.mjs` 追加：API-101（permission 三按钮/question 无键盘，stub
      sendMessageWithKeyboard 断言 keyboard 结构）、API-102（三值写入 + answer 文案 + 编辑断言 +
      非法 chatId 拒绝 + 无匹配记录失败分支）；**区块插在 API-006-5 用例收尾 `);` 之后**（契约 §13.9）

**验收标准**:

- [ ] API-101/102 全绿；API-006 既有用例回归全绿（发送条件变更后兼容）
- [ ] `node scripts/build.mjs` exit 0

### Phase 1.3: 每实例 reply 消费扫描器 ⬜

**目标**: 每个 opencode 实例 1s 扫描自己项目的 sessions，发现新 reply 调 opencode reply API
应用，成功后置 resolved=true。
**契约**: docs/modules/sessions-relay.md §13.6~§13.9（消费端扫描器、编辑区间、SDK 核验、测试锚点——照此实现）
**并行组**: 批次 B（依赖 1.1 合并；与 1.2 同批并发——同文件不同区域）
**触碰范围**: `src/monitor.ts`（**字段区 140-146 新增 replyScanTimer/replyScanInFlight；initialize()
158-169 末尾挂载 startReplyScan()；dispose() 412-443 追加清理；stopSessionsScan 之后、
scanSessionQueue JSDoc 之前的空白区（1524-1526）新增 startReplyScan/stopReplyScan/scanReplyQueue/
applySessionReply**；**不得触碰** scanSessionQueue 函数体（1534-1578）/handleCallback（1833-1911）/
format import 区（1.2 地盘））；`tests/sessions-poller.test.mjs`（追加 API-103/104 + fakeClient reply
stub——**区块插在 API-006-2 用例收尾 `);` 之后**，与 1.2 尾部区块不同锚点，契约 §13.9）。
**分支**: `phase-r2-p1.3`　**worktree**: `.worktrees/phase-r2-p1.3`
**任务**:

- [ ] **SDK 签名核验（先行）**：本机安装存在（`~/.opencode/bin/opencode`、`~/.cache/opencode`）——定位
      `@opencode-ai/sdk` 的 types.gen.d.ts / sdk.gen.ts，确认 permission reply 精确方法名与参数形状
      （path.id / path.permissionId / body.response vs reply）；核验结果写入任务报告。无法核验 → 按
      `client.session.postSessionByIdPermissionsByPermissionId({ path: { id: sessionID,
      permissionId: requestID }, body: { response: "once"|"always"|"reject" } })` 实现并标注推测
- [ ] 新增私有 `startReplyScan()`/`stopReplyScan()`：1s ticker（SESSIONS_SCAN_INTERVAL_MS 复用，
      constants.ts 零新增），仿 startSessionsScan 模式（in-flight 守卫 + track + try/finally）；
      **与 poller.lock 无关**（每实例独立）；disposed 守卫
- [ ] 新增私有 `scanReplyQueue(): Promise<number>`：`registry.read()` → `findRegistryEntry(reg, this.root)`
      只看自己条目 → 筛选 `type === "permission" && reply != null && resolved == false` →
      逐条串行 `applySessionReply`（单条异常不中断整轮）；返回成功条数
- [ ] `applySessionReply(record)`：调 opencode reply API（sessionID=record.session_id、
      requestID=record.request_id、response=record.reply **原样透传**）→ 成功
      `mutate(markSessionResolved(requestID))`；失败/抛错 logWarn 不置位（下轮重试）；
      已 resolved 记录跳过（双路径：TUI replied 事件先置位）；竞态收敛见契约 §13.6（失败不强制置位，
      不引入认领机制）
- [ ] `initialize()` 末尾挂载 `this.startReplyScan()`；`dispose()` 追加 `clearInterval(replyScanTimer)`
      （验收：dispose 后无残留 interval）
- [ ] `tests/sessions-poller.test.mjs` 追加：API-103（stub client 回复 API 断言透传 + resolved 置位 +
      reply=null/已 resolved 跳过）、API-104（apply 失败重试成功 + TUI 先置位跳过 +
      poller 对 reply!=null 未发送记录不发送）；**区块插在 API-006-2 用例收尾 `);` 之后**；
      fakeClient（44-51 区）追加 reply stub 方法（契约 §13.9）

**验收标准**:

- [ ] API-103/104 全绿
- [ ] dispose 后无残留 interval（代码可证：timer 在 dispose 清理列表）
- [ ] `node scripts/build.mjs` exit 0

### Round 1 整体测试记录

- 测试结论：【通过】/【不通过】（待填）
- 失败摘要与根因归属：（待填）

## 断点记录（运输层错误续传用）

- 流程坑（上轮记录，继续有效）：phase 分支可能存在历史残留空壳——签出前 `git branch -f <branch> main` 重置；
  worktree add 注意 `-b` 兜底分支抢先（确认实际检出分支名）。
- **合并实证（2026-09-02，doc-prep 冻结前用 scratch 仓库验证）**：两个分支在**同一锚点**（如同为文件尾）
  追加不同内容 → git 3-way 合并 **必冲突**（`CONFLICT (content)`）；在**不同锚点**追加 → **自动干净合并**
  （两个区块顺序保留）。因此测试文件追加规则（契约 §13.9）：1.2 区块锚定 API-006-5 之后、1.3 区块锚定
  API-006-2 之后（两区块间保留至少一个既有用例）；worktree-merge 若遇尾部冲突，按分节注释拼接两区块即可
  （纯追加、测试 ID 唯一、顺序无关）。
- **README.md 修订移交（2026-09-02）**：dev-lead 要求本轮修订 README「只读」声明，但 doc-prep 系统级
  写权限仅放行 `docs/**` 与 `.gitignore`（README.md 不在其中，edit 被守卫拒绝，不可绕过）。修订内容已冻结在
  docs/modules/sessions-relay.md §11（README 行）——**由 dev-lead 另行指派**（design-driven-impl 或手工）执行：
  第 3/5 行、Features「Read-only bot」条目、Security notes 第 173 行，表述改为「2026-09-02 起 permission
  支持 TG 三按钮回写（仅显式点击触发），其余仍只读」。未修订前 README 与实现存在临时性表述偏差（cosmetic）。

## 交付总结

- （待填）
