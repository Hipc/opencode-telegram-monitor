# question 请求 TG 交互向导：选项按钮 + 自定义输入 + 持久化状态机

> 状态: in-progress
> 创建: 2026-09-02
> 当前轮次: Round 2（实机反馈修复轮）
> 关联文档: docs/modules/sessions-relay.md（§13 permission 闭环 + 本轮新增 §14 question 向导契约，doc-prep 冻结）

## 背景

question 记录目前只发 300 字符 JSON 节选、无按钮无回写。需求：TG 端渲染完整交互向导
（选项卡 + 自定义输入 + 导航），交互对齐 TUI；回答全程持久化到 projects.json（不靠内存，
重启不丢），最终确认后由拥有 session 的实例调 opencode question reply/reject API 回传。

## 已确认的关键决策（用户 grilling 确认，2026-09-02）

1. **多问题请求全支持**（多阶段向导）：答完 Q1 出 Q2，最后「问题+答案总结」确认。
2. **多选题**（multiple）：点选项 toggle ✓ + 「下一题」推进（TUI 同款）。
3. **自定义输入**（custom）：✏️ Custom 按钮 → 直接回复纯文本消息作为答案；`/cancel` 取消输入模式。
4. **取消 = 放弃整个向导 + 调 reject API**（与 Reject 合并为一个 ❌ 按钮，每阶段可用）。
5. **选项描述**：表格行（label + description），按钮只放 label。
6. **单问题请求**：点选项直接提交（无总结无导航，TUI 同款）；多问题：单选自动跳下一题。
7. **导航**：每题 [⬅️ 上一题] [➡️ 下一题] [❌ 取消]；Prev/Next 任意跳（答案保留）；
   **允许带未答题进总结，但 Submit 提示未答题号、不给提交**。
8. **向导状态全部持久化 projects.json**（每次回答/跳题写盘），进程重启后点旧按钮从盘上重建状态。
9. 自定义答案文本落盘 projects.json 可接受（与 permission reply 同架构）。

## 涉及范围

- **修改**:
  - `src/registry/index.ts`（SessionRecord 新增 6 个可选字段 + parse 白名单 + 5 个纯函数 + clearQuestionInputs）
  - `src/monitor.ts`（发送端 question 渲染/键盘、回调向导状态机、纯文本捕获、/cancel 命令、消费端扩展）
  - `src/format/format.ts`（question 阶段消息文本与键盘构建纯函数、OTG_Q_CB_PREFIX）
  - `tests/registry-sessions.test.mjs`（REG-301 追加）
  - `tests/sessions-poller.test.mjs`（API-201~205 追加；API-006-5/API-101-2 既有断言最小改判归 1.2）
- **依赖**: 无新外部依赖；SDK question reply/reject 扁平方法名由 1.4 工人按契约 §14.4.3
  核验（本机 `~/.opencode/node_modules/@opencode-ai/sdk`（dist/v2/gen，1.17.13）实证结论：
  root 扁平客户端无 question 方法、v2 为 class 方法 + 嵌套 body——扁平候选按命名约定推断）

## 上下文（探索结论）

- **SDK 类型（本机 v2 types.gen.d.ts 实证）**：`QuestionInfo/QuestionV2Info = { question, header,
  options: Array<{label, description}>, multiple?, custom? }`；事件 `question.asked`/
  `question.v2.asked` properties 含 `{ id, sessionID, questions: Array<...>, tool? }`。
- **回复 API**：v1 全局 `client.question.reply({ requestID, answers?: Array<QuestionAnswer> })`
  （`POST /question/{requestID}/reply`）；v2 会话级 `POST /api/session/{sessionID}/question/
  {requestID}/reply`，body `{ questionV2Reply: { answers: Array<Array<string>> } }`（**嵌套**——
  doc-prep 核验实证 `QuestionV2Reply = { answers: Array<Array<string>> }`，修正早稿「body
  `{ answers }`」表述）；reject 同构。插件 client 为扁平方法形态（permission 轮核验先例：
  `client.postSessionIdPermissionsPermissionId`），question 对应扁平方法名**须 1.4 工人核验**——
  已核验事实：本机装 `@opencode-ai/sdk@1.17.13` 的 root 扁平客户端**无任何 question 方法**
  （grep 实证，旧版）；`dist/v2/gen` 只有 class 方法（Question.reply({requestID, answers}) /
  Question2.reply({sessionID, requestID, questionV2Reply})）。候选扁平名与兜底形态见契约 §14.4.3。
- **插件现状**：question.asked/v2.asked → addWaiting(question) → **立即** persistWaitingRecord
  （无去抖）；scanSessionQueue 对 question 走 `sendMessage(formatSessionRecordMessage)` 原文节选、
  无键盘；发送条件 `send===false && resolved===false && reply==null`；消费端 scanReplyQueue 只处理
  permission 的 reply。resolveWaitingRecord 已处理 question.replied/rejected 事件（双路径之一保留）。
- **permission 闭环可复用**：sendMessageWithKeyboard（awaitable；**已核验现返回 void**，本轮 1.2
  按契约 §14.2.2 最小扩展为返回 message_id）、permissionEntryID/permShortMap 缩短方案
  （callback_data 64 字节）、handleCallback 前置分支模式、scanReplyQueue 消费模式、
  editPermissionResultMessage 编辑模式（不传 reply_markup 移除键盘）。
- **handleTelegramUpdate**（monitor.ts:1872+）：目前纯文本非命令消息被忽略（`if (!match) return;`）
  ——自定义输入捕获在**命令正则不匹配分支**扩展（纯文本才捕获；`/cancel` 走命令 switch）；
  `/cancel` 不在 PLANNED_COMMANDS（constants.ts:26-33 实证含 start/sessions/use/status/todo/usage），可注册。
- **测试锚点现状（doc-prep 核验）**：`tests/sessions-poller.test.mjs` 现 1058 行——Round 2 的
  API-103/104 区块已占用「API-006-2 收尾后」、API-101/102 区块已占用「API-006-5 收尾后」；
  本轮锚点修正见契约 §14.5（1.2 → Phase 1.2 区块尾 905/907 间；1.3 → 文件尾；1.4 → Phase 1.3
  区块尾 369/372 间 + fakeClient 44-66 扩展）。
- 分支 `main`；`.worktrees/` 已 gitignore（.gitignore 第 20-21 行实证）。

## 最终验证测试任务

> 由 dev-lead 维护，每轮整体测试前更新，**累计维护**（含历轮所有对外面，保证回归）。

### 外部接口测试

**本轮新增：**

- [REG-301] registry 新字段往返容错（q_draft/q_stage/q_input/q_answers/q_reject/**q_msg_id**：
  缺失/null/合法/非法丢记录不抛错）+ 5 个纯函数 + clearQuestionInputs 三态（全局 request_id
  匹配、无匹配 undefined、幂等原引用、只改目标字段）。来源：决策 #8。
- [API-201] question 发送渲染：初始消息单张表格（Type/Session/Question m/n/Header/问题文本/
  选项行 label+description）+ 键盘（选项按钮；多题含 ⬅️/➡️/❌；custom 题含 ✏️；单问题请求无导航
  直接提交形态）；发送条件防御（q_answers!=null 或 q_reject=true 的未发送记录不发送）。
  来源：决策 #1/#5/#6。
- [API-202] 向导回调：单选自动跳下一题；多选 toggle ✓ 落盘；prev/next 跳转；带未答题进总结但
  Submit 拒绝并提示未答题号；全答完 Submit → q_answers 写入 + 消息编辑；单问题请求点选项直接
  q_answers 提交；已 resolved/不存在记录 → 失效提示；**单问题多选 Submit 路径（API-202-8，
  Phase 1.5）**；向导状态盘上重建（API-202-7）。来源：决策 #2/#6/#7。
- [API-203] 自定义输入：✏️ Custom → q_input 落盘 → 纯文本消息写入该题草稿并推进（单问题直接
  提交）；/cancel 清除 q_input。来源：决策 #3。
- [API-204] 取消：任意阶段 ❌ → q_reject 落盘 + answer 提示 + 消息编辑（键盘移除）。来源：决策 #4。
- [API-205] 消费端：q_answers → reply API 透传（sessionID/requestID/answers）→ resolved=true；
  q_reject → reject API → resolved=true；失败不置位下轮重试；已 resolved 跳过。
  来源：决策 #8。
- [API-206] 消费端通道修复（Round 2）：分层策略命中通道②（stub `_client.post` 断言
  url/path/body 顶层 `{answers}`）；404 → resolved 终态不重试；非 404 失败仍重试；reject
  同构（无 body）；一层扁平方法存在时直用。来源：实机反馈 #3。
- [API-207] 交互修复（Round 2）：任意题键盘恒含 ✏️ Custom（payload 无 custom 字段也含）；
  汇总页导航含 ⬅️ Prev 且点击回最后一题；自定义输入后无 q_msg_id → 发新消息兜底
  （多问题含键盘 / 单问题 ✅ Submitted 终态无键盘）；API-203-4 改判（custom 恒可用）。
  来源：实机反馈 #1/#2/#4。

**历轮回归（必须全绿）：**

- [API-001~005] behavior；[API-006/101~106] sessions-poller（含 permission 单表渲染/真实路径）；
  [REDACT-001~003] redact-keep-paths；[REG-101/201] registry-sessions；[LOCK-001~005]；
  [BUILD-001/002]

### 界面（UI）测试

- 无（TG 向导由 stub 断言覆盖；真实端到端由用户按部署清单人工冒烟）。

### 本轮回归重点（修复轮次填写）

- （Round 1 首轮，暂无）
- Round 2（修复轮）：① API-205 改判后语义回归（透传/重试/跳过断言改 `_client.post`
  形态后全绿）；② API-203-4 改判后全绿；③ **实机冒烟为最终验收**（部署清单 5 步：
  TUI 侧 question toolcall 真实收到答案；tgdiag.log 无「方法不存在」类错误）。
  另注意 16:24 实机失败教训：**所有 opencode 窗口必须重启**才能加载新插件产物。

## Round 1

### Phase 1.1: registry 向导状态字段 + 纯函数 ✅

**目标**: SessionRecord 新增 6 个可选字段（严格白名单容错）+ 5 个纯函数 + clearQuestionInputs
（向导状态读写全走 registry，不靠内存）。
**契约**: docs/modules/sessions-relay.md §14.1（doc-prep 冻结字段名与函数签名）
**并行组**: 批次 A（先行；1.2/1.3/1.4 全部依赖）
**触碰范围**: `src/registry/index.ts`（SessionRecord 类型、parseSessionRecord 白名单、纯函数区
setSessionReply 之后新增）；`tests/registry-sessions.test.mjs`（尾部追加 REG-301）。**不碰** monitor.ts/format.ts/
其它测试文件。
**分支**: `phase-r1-p1.1`　**worktree**: `.worktrees/phase-r1-p1.1`
**任务**:

- [ ] SessionRecord 新增可选字段（语义，命名以契约冻结为准）：
      草稿答案 `q_draft?: Array<Array<string>>`（长度=questions 数，未答=空数组）、
      当前题索引 `q_stage?: number`（0-based，=questions.length 表示总结阶段）、
      待自定义输入题索引 `q_input?: number | null`、最终提交 `q_answers?: Array<Array<string>>`
      （消费端 reply 触发器）、放弃标记 `q_reject?: boolean`（消费端 reject 触发器）、
      向导消息 message_id `q_msg_id?: number`（poller 发送成功后回写，供后续编辑）
- [ ] parseSessionRecord 白名单扩展：各字段缺失→键不存在（旧文件往返不新增键）、null（q_input）
      →null、类型不符→丢整条记录（严格风格，不抛错）；q_stage 只做 typeof number（范围钳制在
      回调重建处，契约 §14.1.2）
- [ ] 纯函数（全部：全局 request_id 精确匹配、无匹配 undefined、幂等原引用、只改目标字段）：
      `setQuestionDraft(reg, requestID, draft, stage)`、`setQuestionInput(reg, requestID, index|null)`、
      `submitQuestionAnswers(reg, requestID, answers)`、`rejectQuestion(reg, requestID)`、
      `setQuestionMessageID(reg, requestID, messageID)`；辅助 `clearQuestionInputs(reg)`
      （/cancel 批量清除，无变更原引用，不返回 undefined）
- [ ] REG-301 用例（往返容错 + 三态 + 批量断言）

**验收标准**:

- [ ] `bun tests/registry-sessions.test.mjs` 全绿（REG-301 新增 + REG-101/201 回归）+ LOCK 回归
- [ ] `node scripts/build.mjs` exit 0

**实现记录**（2026-09-02，分支 `phase-r1-p1.1`，SHA `f1856bb`，merge `e130d0e`）：
- 全部验收达成：registry-sessions 20/20（REG-301×5 + 回归 15）+ LOCK 5/5 + 构建 exit 0。
- 细节决定：clearQuestionInputs 采用**删除 q_input 键**（回缺失态，与写入端初始不设 q_* 键一致）；submitQuestionAnswers/setQuestionDraft 幂等用引用相等（数组无深度比较，内容同引用异最多多写盘一次，安全）。
- 共用私有 helper updateQuestionField（全局匹配/无匹配 undefined/幂等原引用/只改目标字段）。

### Phase 1.2: 发送端 question 渲染 + 键盘构建 ✅

**目标**: question 记录初始消息结构化渲染（Q1 阶段）+ 阶段文本/键盘构建纯函数（format.ts，
供 1.3 回调复用）+ 发送条件防御。
**契约**: docs/modules/sessions-relay.md §14.2
**并行组**: 批次 B（依赖 1.1 合并；与 1.4 同批并发——monitor.ts 不同区域 + 测试文件不同锚点）
**触碰范围**: `src/format/format.ts`（新增 OTG_Q_CB_PREFIX、buildQuestionStageText、
buildQuestionKeyboard；不碰 buildSessionPermissionKeyboard）；`src/monitor.ts`（import 区追加
导出名；scanSessionQueue 的 question 分支 + sendMessageWithKeyboard 返回 message_id +
qShortMap/questionEntryID 新成员；**formatSessionRecordMessage 零改动**——question 渲染完全由
scanSessionQueue 分支接管）；`tests/sessions-poller.test.mjs`（Phase 1.2 区块尾部追加 API-201
区块 + API-006-5/API-101-2 既有断言最小改判 + makeMonitor 的 sendMessageWithKeyboard stub 改返回
message_id）。**不碰** handleCallback/handleTelegramUpdate/scanReplyQueue（1.3/1.4 地盘）。
**分支**: `phase-r1-p1.2`　**worktree**: `.worktrees/phase-r1-p1.2`
**任务**:

- [ ] format.ts：`buildQuestionStageText(projectLabel, type, sessionLabel, questions, stage, draft,
      inputPending?)`——单张 fieldTable（Type/Session/Question m/n/Header/问题文本/选项行
      label+description，多选题已选项标注 ✓；总结阶段改为每题 Q&A 行，未答标注）；文本经
      safeText/safeTextKeepPaths（问题文本含路径时显示真实路径，沿用上轮决策）
- [ ] format.ts：`buildQuestionKeyboard(entryID, questions, stage, draft)`——选项按钮（多选 ✓ 前缀；
      callback_data `otg:q:<entryID>:o<idx>`）+ custom 题 [✏️ Custom]（`:custom`）+ 多题导航行
      [⬅️ Prev](:prev) [➡️ Next](:next) [❌ Cancel](:cancel)；总结阶段 [✅ Submit](:submit)
      [❌ Cancel]；**单问题请求只放选项 + ❌ Cancel**（直接提交形态）；entryID 由 monitor 保证
      callback_data ≤64 字节
- [ ] monitor.ts scanSessionQueue：question 记录解析 message JSON → buildQuestionStageText(Q1) +
      buildQuestionKeyboard → sendMessageWithKeyboard；发送成功后 mutate setQuestionMessageID
      （**已核验：sendMessageWithKeyboard 现返回 void**，按契约 §14.2.2 最小扩展为
      `Promise<number | undefined>`——响应 `result.message_id`，无则 undefined 跳过回写不中断）；
      permission 记录路径零改动；message JSON 解析失败/无 questions → 退化原文节选发送（防御）
- [ ] 发送条件追加防御：`q_answers == null && q_reject !== true`（在既有 send/resolved/reply 之上）
- [ ] questionEntryID + qShortMap（仿 permissionEntryID/permShortMap，前缀 otg:q:）
- [ ] API-201 用例（渲染断言 + 键盘结构断言 + 防御断言）

**验收标准**:

- [ ] `HOME=$(mktemp -d) bun tests/sessions-poller.test.mjs` 全绿（API-201 新增 + 既有回归）
- [ ] `node scripts/build.mjs` exit 0

**实现记录**（2026-09-02，分支 `phase-r1-p1.2`，SHA `3809a3b`，merge `2606db4`）：
- 全部验收达成：sessions-poller 24/24（API-201-1~4 新增 + 全回归）+ 构建 exit 0。
- **API-006-5/API-101-2 未改判**：其 question message 无 questions 字段，命中宽松防御「questions 非数组 → 退化原文节选无键盘」，断言原样成立。
- 实现细节：question 发送抽为私有 sendQuestionRecord（scanSessionQueue 之后）；退化路径复用 formatSessionRecordMessage question 节选；空 questions 数组也计入退化防御；formatSessionRecordMessage 函数体零改动（question 分支为不走的防御 dead code）。

### Phase 1.3: 回调向导状态机 + 自定义输入捕获 ✅

**目标**: handleCallback q 分支全状态机（选项/导航/总结/提交/取消，每步读写 registry）+
纯文本自定义捕获 + /cancel 命令。
**契约**: docs/modules/sessions-relay.md §14.3
**并行组**: 批次 C（依赖 1.1 + 1.2 合并；单 phase）
**触碰范围**: `src/monitor.ts`（handleCallback/answerCallback 区新增 q 前置分支；handleTelegramUpdate
纯文本捕获 + /cancel 命令分支；q 分支辅助私有方法放 handleCallback 近旁）；`tests/sessions-poller.test.mjs`
（锚点：API-106 收尾之后/文件尾部追加 API-202/203/204 区块）。**不碰** scanSessionQueue/
scanReplyQueue/format.ts/registry。
**分支**: `phase-r1-p1.3`　**worktree**: `.worktrees/phase-r1-p1.3`
**任务**:

- [ ] handleCallback 在 perm 分支后新增 q 分支（正则 `^otg:q:(.+):(o\d+|prev|next|cancel|custom|submit)$`）：
      还原 requestID（qShortMap 兜底）→ registry.read 全局找记录 → 失效（不存在/resolved/
      q_answers 已设）→ answer「记录不存在或已失效」；否则从 record.message 解析 questions、
      q_draft/q_stage 重建状态（无则初始化）按动作分派
- [ ] `o<idx>`：单选题 → draft[stage]=[label]，单问题请求直接 submitQuestionAnswers+编辑 ✅，
      多问题 stage+1 落盘并编辑下一题；多选题 → toggle 落盘并编辑（✓ 刷新）
- [ ] `prev`/`next`：stage 越界钳制（next 上限=总结阶段）→ 落盘 → 编辑
- [ ] `custom`：setQuestionInput(stage) → answer 提示「直接回复文本作为答案，/cancel 取消」→
      编辑消息（输入模式提示）
- [ ] `submit`（总结）：校验 draft 全部非空，未答 → answer 提示未答题号不给提交；全答 →
      submitQuestionAnswers(draft) → 编辑 ✅ Submitted（键盘移除）
- [ ] `cancel`：rejectQuestion → answer「已取消」→ 编辑 ❌ Cancelled（键盘移除）
- [ ] handleTelegramUpdate：**命令正则不匹配分支**（纯文本才捕获；`/cancel` 走命令 switch）——
      registry.read() 全局找 `q_input != null && resolved=false && q_answers==null` 的 question
      记录（跨全部条目第一条）→ 文本写入 draft[q_input]、清 q_input（setQuestionInput null）、
      推进（多问题 stage+1/单问题直接 submitQuestionAnswers）→ 回复确认文案
      「已记录第 {n} 题答案」；`/cancel` 命令 → `case "cancel":` → clearQuestionInputs → 确认文案
- [ ] 编辑原消息 messageID：回调路径 `record.q_msg_id ?? callback.message.message_id`；
      纯文本路径仅 `record.q_msg_id`（缺失 logWarn 跳过编辑，答案已落盘不受影响）；
      编辑失败 logWarn 不中断
- [ ] API-202/203/204 用例

**验收标准**:

- [ ] `HOME=$(mktemp -d) bun tests/sessions-poller.test.mjs` 全绿（API-202/203/204 + 既有回归）
- [ ] `node scripts/build.mjs` exit 0
- [ ] 向导每步状态变化都落盘（断言 registry 内容，非内存）

**实现记录**（2026-09-02，分支 `phase-r1-p1.3`，SHA `1b6ad57`，merge `dda72f7`）：
- 全部验收达成：sessions-poller 40/40（API-202×7 / API-203×4 / API-204×2 新增 + 既有回归）+ 构建 exit 0。
- handleQuestionCallback 状态机全走盘上重建（无内存状态）；编辑辅助 editQuestionWizardMessage + parseQuestionPayload/questionStageText/renderQuestionStage。
- registry 导入块（90-104 区）追加 5 个 q 纯函数导入（非 1.2 的格式导入块，无区间冲突）。
- 偏差（已接受）：单问题纯文本提交的终态编辑 = 重建该题阶段文本 + ✅ Submitted（纯文本路径无 callback.message 原文），API-203-2 覆盖。
- **暴露死角（Phase 1.5 修复）**：单问题 + multiple 键盘无 Submit 且不自动提交 → 永远无法提交。

### Phase 1.4: 消费端 answers/reject 应用 ✅

**目标**: 每实例扫描自己条目，q_answers/q_reject 的 question 记录调 SDK reply/reject API，
成功置 resolved=true。
**契约**: docs/modules/sessions-relay.md §14.4
**并行组**: 批次 B（依赖 1.1 合并；与 1.2 同批并发）
**触碰范围**: `src/monitor.ts`（scanReplyQueue/applySessionReply 区扩展 + 新增
applyQuestionReply/applyQuestionReject；fakeClient stub 注释同步）；`tests/sessions-poller.test.mjs`
（Phase 1.3 区块尾部追加 API-205 区块 + fakeClient 44-66 区 question reply/reject stub）。**不碰**
scanSessionQueue/handleCallback/format.ts。
**分支**: `phase-r1-p1.4`　**worktree**: `.worktrees/phase-r1-p1.4`
**任务**:

- [ ] **SDK 签名核验（先行）**：按契约 §14.4.3——doc-prep 已核验本机 sdk@1.17.13：
      root 扁平客户端无 question 方法、v2 为 class 方法（Question.reply({requestID, answers}) /
      Question2.reply({sessionID, requestID, questionV2Reply})）、body 为**嵌套**
      `{ questionV2Reply: { answers } }`（修正早稿）；候选扁平名
      `postApiSessionSessionIDQuestionRequestIDReply({ path:{sessionID,requestID},
      body:{questionV2Reply:{answers}} })` / `postQuestionRequestIDReply({ path:{requestID},
      body:{answers} })`（reject 同构）；核验运行时 1.18.23（实机冒烟兜底），结果写入任务报告，
      无法核验时按契约兜底形态实现并标注推测
- [ ] scanReplyQueue 筛选扩展：`type==="question" && resolved===false &&
      (q_answers!=null || q_reject===true)` 逐条串行 apply（单条异常不中断）
- [ ] applyQuestionReply：answers 原样透传 → 成功 mutate markSessionResolved；失败 logWarn
      （token 脱敏）不置位下轮重试；applyQuestionReject 同构（reject API）
- [ ] API-205 用例（透传断言 + 置位 + 失败重试 + 已 resolved 跳过）

**验收标准**:

- [ ] `HOME=$(mktemp -d) bun tests/sessions-poller.test.mjs` 全绿（API-205 + 既有回归）
- [ ] `node scripts/build.mjs` exit 0

**实现记录**（2026-09-02，分支 `phase-r1-p1.4`，SHA `c42afb4`，merge `d2c63e2`）：
- 全部验收达成：sessions-poller 23/23（API-205×3 + 全回归）+ 构建 exit 0。
- **SDK 核验结论（实证）**：本机三处 SDK 均 1.17.13；root 扁平客户端 grep question 零命中（无 question 方法）；v2 class 精确签名实证（Question/Question2 reply/reject，reject 无 body，body 嵌套 `{ questionV2Reply: { answers } }`）。按契约兜底实现 `postApiSessionSessionIDQuestionRequestIDReply/...Reject`（扁平命名与路由推导吻合，**1.18.23 运行时无法本机核验，标注推测**）；实机冒烟（部署清单第 5 步）为最终确认，若签名不同仅需改 monitor.ts 两处调用 + fakeClient 两个 stub 名。

### Phase 1.5: 单问题多选提交死角修复 ✅

**目标**: 单问题 + multiple 请求键盘无提交路径的死角修复（TUI 对齐：多选 = toggle + 确认提交）。
**并行组**: 批次 D（基于 1.3 分支拉出，追加修复）
**触碰范围**: `src/format/format.ts`（buildQuestionKeyboard 单问题多选形态）、`src/monitor.ts`（handleQuestionCallback submit 守卫）、`tests/sessions-poller.test.mjs`（API-202-4 修正 + API-202-8 新增）。
**分支**: `phase-r1-p5.1`　**worktree**: `.worktrees/phase-r1-p5.1`
**任务**:

- [x] buildQuestionKeyboard：单问题且 multiple → 选项 toggle 行 + [✅ Submit](:submit) + [❌ Cancel]（custom 行照常）；单问题单选/多问题形态不变
- [x] handleQuestionCallback submit：删除「非总结阶段 → Unknown action」守卫，任意 stage 可提交（draft 全答校验保持，未答提示题号）
- [x] API-202-8：单问题多选键盘含 Submit；空选提交被拒；toggle A+B → Submit → q_answers=[[A,B]] 终态闭环

**验收标准**:

- [x] sessions-poller 41/41 + 构建 exit 0

**实现记录**（2026-09-02，分支 `phase-r1-p5.1`，SHA `1e01ff4`，merge `786984f`，基于 1.3 后代）：
- 全部验收达成：41/41；契约 §14.2.1/§14.3.1/§14.3.3 修订要点已同步回契约文档。

### Round 1 整体测试记录

- 测试结论：【通过】（2026-09-02，main @ `786984f`）
- 80 用例全绿：behavior 8/8 + sessions-poller 41/41（API-201×4 / API-202×8 含单问题多选 Submit /
  API-203×4 / API-204×2 / API-205×3 + 全部既有回归）+ registry-sessions 20/20（REG-301×5）+
  registry-concurrency 5/5 + redact-keep-paths 3/3；BUILD-001 exit 0（136.1KB）+ BUILD-002 3/3。
- 失败摘要与根因归属：无失败。
- 残余风险：**SDK question reply/reject 扁平方法名为推测**（本机 SDK 1.17.13 无 root 扁平
  question 方法，1.18.23 运行时无法本机核验；兜底 `postApiSessionSessionIDQuestionRequestIDReply/
  ...Reject` 与路由推导吻合）——实机冒烟为最终确认，签名不同仅需改 monitor.ts 两处调用 +
  fakeClient 两个 stub 名；真实 TG 端到端由用户按部署清单人工冒烟。

## Round 2（实机反馈修复轮，2026-09-02 用户真实测试后）

### 根因诊断（代码 + 实机数据实证）

1. **无自定义输入按钮**：真实 question payload **从不带 `custom: true`**（projects.json 全部
   真实记录零条有此字段），而 ✏️ Custom 仅在 `custom === true` 时渲染 → 永不出现。
2. **汇总页无法返回上一题**：总结阶段键盘只有 [✅ Submit] [❌ Cancel]，缺 Prev（回调逻辑
   本身支持 prev 从 stage=length 回最后一题，纯键盘遗漏）。
3. **提交后 TUI 不动（双根因）**：
   - **代码层实锤**：运行时扁平客户端（最新 npm + 本机 SDK 核验）**没有任何 question
     reply/reject 方法**（仅 permission 一个扁平方法 `postSessionIdPermissionsPermissionId`），
     Phase 1.4 的推测方法名必然抛 not-a-function。question 路由只在 v2 API：
     `POST /api/session/{sessionID}/question/{requestID}/reply`（body `{answers}`，已核验
     v2 gen 内部即 `client.post({url, path, body})`）与 `/question/{requestID}/reject`。
     可行通道：`(client as any)._client.post({url, path, body, throwOnError})`（与生成方法
     同一 transport，自动继承 baseUrl/auth）。
   - **部署层**：16:24 测试记录 q_answers 已写但 resolved=false 卡住、tgdiag.log 零 apply
     告警 → 持有该 session 的 opencode 窗口（proxymonitor）在跑旧插件（无 question 消费）。
     向导能用是因为 poller 进程（新插件）处理回调。**修复后必须重启所有 opencode 窗口**。
4. **隐藏缺陷（顺带修）**：`sendRichMessage`（非官方通道）响应无 `message_id` → 所有记录
   `q_msg_id` 缺失 → 自定义输入纯文本路径无法编辑向导消息（回调路径靠
   `callback.message.message_id` 兜底才正常）。

### 已确认决策（用户 2026-09-02）

1. ✏️ Custom **恒显示**（不依赖 payload custom 标志）；custom 动作「该题不支持自定义输入」防御移除。
2. 消费端 404（问题/session 已不存在）→ **置 resolved=true 终态**（防每秒重试日志噪音）；
   其它错误仍重试。
3. 自定义输入后无法编辑原消息（q_msg_id 缺失）→ **发新向导消息（带键盘）继续**，旧消息
   按钮仍可用（状态在盘上）；另对 sendRichMessage 响应做防御性多形态 message_id 解析 +
   诊断日志。

### Phase 2.1: 消费端 API 通道修复 ⬜

**目标**: applyQuestionReply/applyQuestionReject 改走可达通道（分层策略），404 终态，
q_msg_id 响应解析。
**契约**: docs/modules/sessions-relay.md §14.8.1（分层通道，supersede §14.4.3 兜底形态）/
§14.8.2（404 终态）/ §14.8.3（message_id 防御解析）/ §14.8.7（API-206 测试契约）
**并行组**: 批次 A（与 2.2 并发——monitor.ts 不同区域 + 测试不同锚点）
**触碰范围**: `src/monitor.ts`（applyQuestionReply/applyQuestionReject 方法体（1731-1811）+
sendMessageWithKeyboard 返回值解析（3209-3224，含首次 dline 诊断））；
`tests/sessions-poller.test.mjs`（**fakeClient 55-93 区 stub 调整**：删除两个扁平 question
stub + questionReplyCalls/questionRejectCalls/questionReplyError/questionRejectError 四个成员，
新增 `_client.post` stub（postCalls/postError）——运行时实证无扁平方法，typeof 检查必须走
失败分支；**API-205 三个用例（399-657 区）断言最小改判**为 `_client.post` 形态
（url/path/body 顶层 `{answers}` 断言），改判于任务报告注明；锚点：API-205 区块 657 行 `);`
之后、`// API-006-3` 注释之前追加 API-206 区块）。**不碰** format.ts/
handleQuestionCallback/handleQuestionTextInput/scanSessionQueue。
**分支**: `phase-r2-p2.1`　**worktree**: `.worktrees/phase-r2-p2.1`
**任务**:

- [ ] applyQuestionReply 分层调用策略（每次按序尝试，任一成功即用；实例级缓存已成功策略
      `private questionApplyChannel?: 1 | 2 | 3 | undefined`——缓存存在先试缓存通道，仍按序
      降级）：① 扁平方法（typeof 检查，未来版本若有则直用）；② `(client as any)._client.post(
      { url: "/api/session/{sessionID}/question/{requestID}/reply", path: {sessionID,
      requestID}, body: { answers: record.q_answers }, headers: {"Content-Type":
      "application/json"}, throwOnError: true })`；③ v2 全局路由 `/question/{requestID}/reply`
      （path requestID + query { directory: this.root } + body 同②）
- [ ] applyQuestionReject 同构（reject 无 body，路由 .../reject）
- [ ] 404 终态：某通道抛错且判定为「不存在」（404/QuestionNotFound/SessionNotFound）→
      **立即终态**（不再尝试后续通道）：`mutate(markSessionResolved)` + log info
      「question no longer exists; marking resolved」+ **不 rethrow**，下轮 ticker 读到
      resolved=true 自然跳过；其它错误维持 logWarn + rethrow + 下轮重试（并在 ② 失败时
      尝试 ③）
- [ ] sendMessageWithKeyboard 返回值防御性解析：`result?.message_id ?? result?.message?
      .message_id ?? result?.messageId`；首次发送时 dline 记录响应键名形态（仅键名，
      不含内容，天然脱敏）供诊断
- [ ] fakeClient question stub 调整（见触碰范围）+ API-205 三个用例断言最小改判
- [ ] API-206 用例：分层策略命中通道②（stub _client.post 断言 url/path/body 顶层
      `{answers}` 且**不含 questionV2Reply 嵌套**）；404 → resolved 终态不重试；非 404
      失败仍重试（且尝试通道③后失败）；reject 同构（无 body）；「ch ① 扁平方法存在时
      直用」用例（用例内临时挂扁平方法断言命中）

**验收标准**:

- [ ] `HOME=$(mktemp -d) bun tests/sessions-poller.test.mjs` 全绿（API-206 + API-205 改判 + 既有回归）
- [ ] `node scripts/build.mjs` exit 0

**实现记录**: （待填）

### Phase 2.2: 交互修复（Custom 恒显示 + 汇总 Prev + 输入兜底） ⬜

**目标**: ✏️ Custom 每题恒显示；总结阶段加 ⬅️ Prev；自定义输入后无 q_msg_id 时发新向导消息。
**契约**: docs/modules/sessions-relay.md §14.8.4（Custom 恒显示，supersede §14.2.1 custom 行
条件 + §14.3.1 custom 防御 + §14.3.3 文案行）/ §14.8.5（汇总 Prev，修订 §14.2.1 导航行）/
§14.8.6（输入兜底，修订 §14.3.2 第 5 步）/ §14.8.7（API-207 测试契约）
**并行组**: 批次 A（与 2.1 并发）
**触碰范围**: `src/format/format.ts`（buildQuestionKeyboard 409-491：custom 行条件移除恒显示、
总结阶段导航行加 [⬅️ Prev]）；`src/monitor.ts`（handleQuestionCallback custom 动作防御移除
（2888-2919 区）+ handleQuestionTextInput 无 q_msg_id 兜底发新消息（2224-2358 区，
2316-2322 / 2349-2355 两处 logWarn 分支替换））；`tests/sessions-poller.test.mjs`
（**API-203-4（2437-2458 区）最小改判**为「custom 恒可用 → 进入输入模式」语义并在任务报告
注明；锚点：文件尾 2682 后追加 API-207 区块）。
**分支**: `phase-r2-p2.2`　**worktree**: `.worktrees/phase-r2-p2.2`
**任务**:

- [ ] buildQuestionKeyboard：✏️ Custom 行**恒显示**（移除 `custom === true` 条件，
      有 current 即渲染）；总结阶段（stage===questions.length）导航行改为
      [⬅️ Prev] [✅ Submit] [❌ Cancel]
- [ ] handleQuestionCallback：custom 动作移除「该题不支持自定义输入」防御（恒可用；
      current 判空保留为失效防御）
- [ ] handleQuestionTextInput：写答案推进后，q_msg_id 缺失时不再 logWarn 跳过——改为
      **发送一条新的当前阶段向导消息**（多问题：buildQuestionStageText(newStage) +
      buildQuestionKeyboard + sendMessageWithKeyboard 含键盘；发送成功后
      `mutate(setQuestionMessageID)` 回写新消息 id，后续编辑指向新消息；entryID
      undefined 超限兜底 → 退化为无键盘文本发送），旧消息不动（按钮仍可用，状态在盘上）；
      单问题直接提交路径同样兜底（新消息含 ✅ Submitted 终态文本，无键盘）；
      新消息发送失败 → logWarn（答案已落盘，不影响正确性）
- [ ] API-203-4 改判（custom 恒可用语义）
- [ ] API-207 用例：任意题键盘含 ✏️ Custom（payload 无 custom 字段也含）；汇总页含 ⬅️ Prev
      且点击回最后一题（q_stage=length → prev → 最后一题）；自定义输入后无 q_msg_id →
      新消息断言（sendMessageWithKeyboard stub 捕获新文本与键盘 + 新消息 id 回写）；
      单问题直接提交路径新消息 ✅ Submitted 断言

**验收标准**:

- [ ] `HOME=$(mktemp -d) bun tests/sessions-poller.test.mjs` 全绿（API-207 + API-203-4 改判 + 既有回归）
- [ ] `node scripts/build.mjs` exit 0

**实现记录**: （待填）

### Round 2 整体测试记录

- 测试结论：（待填）
- 失败摘要与根因归属：（待填）

### 部署清单（Round 2 修复后，用户手工执行——重点变化）

1. `node scripts/build.mjs` 重新构建
2. **关闭并重启所有 opencode 窗口**（不只 poller 所在窗口——消费端跑在 session 所属实例上，
   旧插件实例永远不会应用答案；本轮 16:24 卡住的记录即此原因）
3. 产物 `monitor.ts` 复制到 `~/.config/opencode/plugins/telegram-session-monitor.ts`
4. 确认 tgdiag.log 无 409（单 poller）
5. 实机冒烟：触发 question → 选选项/自定义输入 → 提交 → **TUI 侧 question 工具真实收到答案
   并继续执行**；若仍不动，看 tgdiag.log 的「Question reply apply failed」告警内容回报

## 断点记录（运输层错误续传用）

- 流程坑（历轮记录，继续有效）：phase 分支可能存在历史残留空壳——签出前
  `git branch -f <branch> main` 重置；worktree add 注意 `-b` 兜底分支抢先。
- 本轮暂无断点。

## 部署清单（Round 1 交付时版本，已被 Round 2 版本取代）

1. `node scripts/build.mjs` 重新构建
2. 停止旧插件进程（tgdiag.log 中旧版 PID），关闭多余 opencode 窗口
3. 产物 `monitor.ts` 复制到 `~/.config/opencode/plugins/telegram-session-monitor.ts`
4. 重启 opencode，确认只剩一个 poller（tgdiag.log 无 409）
5. 触发一次真实 question 请求，肉眼验证：初始消息（表格+选项按钮）→ 单选自动跳/多选 toggle →
   自定义输入 → 总结确认提交 → TUI 侧 question toolcall 真实收到答案；取消链路 → agent 收到 rejected

## 交付总结

- **轮次**：1 轮完成（文档先行 → A[1.1] → B[1.2‖1.4 并发] → C[1.3 + 1.5 死角修复] → 合并 → 整体测试【通过】）。
- **提交链**：`8e466a8`（docs 冻结）→ `f1856bb`/`e130d0e`（1.1）→ `3809a3b`/`2606db4`（1.2）→
  `c42afb4`/`d2c63e2`（1.4）→ `1b6ad57`/`dda72f7`（1.3）→ `1e01ff4`/`786984f`（1.5，最终 HEAD）。
- **改动文件**：
  - `src/registry/index.ts`：SessionRecord 6 个 q_* 可选字段（草稿/阶段/输入态/最终答案/放弃/消息
    id）+ parse 白名单容错 + 6 个纯函数（setQuestionDraft/Input、submitQuestionAnswers、
    rejectQuestion、setQuestionMessageID、clearQuestionInputs）
  - `src/format/format.ts`：OTG_Q_CB_PREFIX + buildQuestionStageText（单表渲染：Question m/n/
    Header/问题文本/选项行，总结阶段 Q&A 行）+ buildQuestionKeyboard（选项 toggle/✏️ Custom/
    ⬅️➡️❌ 导航/✅ Submit；单问题单选直接提交形态；单问题多选 Submit 形态——1.5）
  - `src/monitor.ts`：发送端 sendQuestionRecord（Q1 渲染 + 键盘 + q_msg_id 回写 + 发送条件防御）、
    qShortMap/questionEntryID、sendMessageWithKeyboard 返回 message_id、handleQuestionCallback
    状态机（无内存全盘上重建）、editQuestionWizardMessage、handleQuestionTextInput 纯文本捕获、
    /cancel 命令、消费端 applyQuestionReply/applyQuestionReject（scanReplyQueue 双分支）
  - 测试：REG-301×5、API-201~205（含 API-202-8）共 26 个新用例
  - 契约：docs/modules/sessions-relay.md §14（+ Phase 1.5 修订）
- **最终整体测试**：80 用例 + 构建断言全绿（详见 Round 1 整体测试记录）。
- **待用户执行**：部署清单 5 步（重点第 5 步实机冒烟——**question reply/reject SDK 扁平方法名
  为推测标注**，若点击提交后 agent 未收到答案且 tgdiag.log 出现方法不存在类错误，按 Phase 1.4
  实现记录的「两处调用 + stub 名」同步修正）。
- **遗留事项**：① SDK 签名实机确认（上述）；② 向导无超时回收（记录未答永远挂在盘上，TUI 侧
  仍可答——双路径保留）；③ 3 个 real-*.test.mjs 诊断测试未入库（维持历轮决策）。
