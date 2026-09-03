# question Custom 输入提示增强：单活输入模式 + 提示带项目/问题标识

> 状态: completed
> 创建: 2026-09-03
> 当前轮次: Round 1（已完成）
> 关联文档: docs/modules/sessions-relay.md §14（本轮新增 §14.9 修订，doc-prep 冻结）

## 背景

question 向导的 ✏️ Custom 自定义输入交互两点增强（用户 grilling 确认，2026-09-03）：

1. **提示带标识**：点 Custom 后的提示（弹窗 toast + 向导消息提示行两处）现为写死文案
   「直接回复文本作为答案，/cancel 取消」，不含项目名/问题内容——要改为
   `请输入 <project> 的 <question> 答案，如果放弃输入请输入 /cancel`。
2. **单活输入模式**：现多点 Custom 后多个记录 `q_input` 并存，纯文本只投给最先注册的一条
   （`handleQuestionTextInput` 全局扫描取第一条，其余静默滞留）。要点新 Custom 时自动取消
   旧的待输入：发 `<project> 的 <question> 输入被取消` 消息 + 清旧 `q_input` + 旧向导消息
   重渲染回正常视图，然后走新 Custom 常规流程。

## 涉及范围

- **修改**:
  - `src/format/format.ts`（3 个新纯函数：questionLabel / questionInputPromptText /
    questionInputCancelledText；buildQuestionStageText 提示行接入 promptText）
  - `src/monitor.ts`（custom 分支：前置取消逻辑 + 弹窗新文案；/cancel 分支重写为逐条取消；
    新私有方法 cancelPendingQuestionInputs + rebuildQuestionState 重构去重；import 区扩展）
  - `tests/sessions-poller.test.mjs`（API-203-1/3/4 改判 + API-208-1~4 新增）
- **依赖**: 无新外部依赖；不碰 registry（`setQuestionInput(rec, id, null)` 清单条先例已存在，
  `clearQuestionInputs` 保留不删但 monitor 不再调用）

## 上下文（探索结论，2026-09-03 深入调研）

- **git 基线**：分支 `main`（HEAD `0b76b12e`）；`.worktrees/` 已 gitignore（.gitignore 第 20-21 行）；
  工作区干净度由 doc-prep 开工前核实并报告。
- **custom 分支**（monitor.ts:3090-3120）：`setQuestionInput`（3096-3098）→
  `answerCallback("直接回复文本作为答案，/cancel 取消", false)`（3103-3107，纯文本 toast，
  **Telegram answerCallbackQuery.text 上限 200 字符**）→ `renderQuestionStage(..., inputPending=true,
  chatID, messageID)`（3108-3118；chatID = `message.chat.id`，messageID = `record.q_msg_id ??
  callback.message.message_id`）。
- **提示行**（format.ts:373-375）：`fieldRow("输入", "✏️ 回复文本作为答案，/cancel 取消")`，
  inputPending 时追加。`buildQuestionStageText`（324-396）作用域内已有 `projectLabel` 参数与
  `current = questions[stage]`（339 行）——**改文案无需加参数**。question 正文先例走
  `safeTextKeepPaths`（346 行，密钥脱敏保留路径）。
- **纯文本捕获**（monitor.ts:2316-2534）：全局线性扫描（projects 数组序 + sessions 数组序）
  找第一条 `question && !resolved && q_answers==null && q_input!=null`，`break outer`。
- **/cancel 命令**（monitor.ts:2291-2296）：`clearQuestionInputs` 一锅端 + **无条件**回
  「已取消输入模式」。
- **状态重建模式**（内联两处：handleQuestionCallback 2953-2960、handleQuestionTextInput
  2362-2365）：`rawDraft ?? []` map 复制 + `q_stage` 钳制 [0, questions.length]——无共享 helper，
  本轮第三处需要，抽 `rebuildQuestionState` 去重。
- **renderQuestionStage**（3257-3282）：签名 `(record, projectLabel, requestID, questions, stage,
  draft, inputPending, chatID, messageID)`；内部 questionStageText 组装 ctx + sessionLabel；
  键盘 stage===length 总结形态天然无 custom 行，旧记录停总结阶段也能正确重渲染。
  editQuestionWizardMessage → richEditMessage（HTML，失败 logWarn 不抛）。
- **消息通道**：`enqueueMessage(paragraph(text))` —— sendRichMessage HTML，paragraph 内部
  escapeHtml 自动转义（「已记录第 N 题答案」/「已取消输入模式」先例）；弹窗
  answerCallbackQuery **纯文本不走 HTML**，无需转义但 ≤200 字符。
- **registry**：`setQuestionInput(reg, requestID, index|null)`（431-442，updateQuestionField
  三态）；`clearQuestionInputs`（500-520）保留。
- **测试锚点**（tests/sessions-poller.test.mjs，总 3555 行）：
  - helper：`questionWizardCallback`（2054-2061，message_id 恒 7）、`questionWizardRecord`
    （2062-2069）、`runQCallback`（2071-2080）、`answersOf`/`lastEdit`/`editCount`
    （2081-2098）、`stubFetch`（1330-1338）。
  - API-203-1（2556-2643）：弹窗断言 2587-2590（字面「直接回复文本作为答案，/cancel 取消」）、
    提示行断言 2591-2594（字面「✏️ 回复文本作为答案，/cancel 取消」）、键盘保留 2595-2597；
    `monitor.sendMessage` stub 收集 sent（2576-2579）。
  - API-203-3（2709-2778）：无输入态纯文本静默 2736-2741、全清断言 2765-2767、确认文案
    「已取消输入模式」2768-2771。
  - API-203-4（2780-2822）：弹窗 2800-2805、提示行 2807-2809。
  - 新用例锚点：3547/3549（`await rm(...)` 清理前）之前插入。
- **弹窗长度防御**：projectLabel（basename）+ label（≤60）+ 模板 ~25 字符 < 200 一般成立，
  调用处 `safeText(prompt, 200, ctx)` 兜底。

## 已确认决策（用户 grilling 确认，2026-09-03）

1. Custom 提示**两处都换新模板**（弹窗 + 消息提示行）：`请输入 <project> 的 <question> 答案，
   如果放弃输入请输入 /cancel`（提示行在 fieldRow 值内保留 `✏️ ` 前缀）。
2. `<question>` 标识 = 该题 **header**；header 空/缺失兜底 = 问题正文截断 60 字符（**截断加
   ASCII `...` 三个点**——doc-prep 核验 redact.ts `finishText` 69-75：`slice(0, limit-3) + "..."`，
   非 `…`；safeTextKeepPaths 脱敏）。
3. 点 B 的 Custom 时取消 A（A = 任意其它 q_input 待输入记录，可跨 session/项目）：先发独立
   消息 `<project> 的 <question> 输入被取消`（enqueueMessage + paragraph）→ 清 A 的 q_input
   （草稿保留、向导仍可用）→ **A 的向导消息重渲染回正常阶段视图**（去输入提示行、键盘保留）；
   然后走 B 常规 Custom 流程。
4. `/cancel` 统一逐条取消新格式（同上共用逻辑，不排除任何记录）；**无待输入时静默**（不再发
   「已取消输入模式」）。
5. 同一记录重复点 Custom：不取消自己（exclude 当前 requestID），幂等刷新。
6. 已失效记录（resolved / q_answers 已设 / q_reject）残留 q_input：**静默清除**不发取消消息。
7. A 的消息编辑仅用 `record.q_msg_id`（无回调 message 兜底；缺失跳过编辑，取消消息本身已是
   提示）；parseQuestionPayload 解析失败跳过重渲染只发消息（防御）。
8. 纯文本捕获逻辑不动（单活语义下第一条=唯一条）。Custom 恒显示、键盘结构、向导其它状态机
   均不动。取消消息不加 emoji 前缀（按用户模板原文）。

## 最终验证测试任务

> 由 dev-lead 维护，每轮整体测试前更新，**累计维护**（含历轮所有对外面，保证回归）。
> 只含两类：外部接口测试 + 界面（UI）测试。TG 向导交互由 sessions-poller stub 断言覆盖
> （历轮惯例），真实 TG 端到端由用户按部署清单人工冒烟。

### 外部接口测试

**本轮新增/改判（API-208 系列 + API-203 改判）：**

- [API-203-1 改判] Custom 提示新文案：弹窗断言改为插值模板
  `请输入 ${projectLabel} 的 ${label} 答案，如果放弃输入请输入 /cancel`（label = header）；
  提示行断言改为含 `✏️ 请输入 ... /cancel` 同模板；键盘保留断言不变；draft/q_input/q_stage
  落盘断言不变。来源：决策 #1/#2。
- [API-203-4 改判] 同 API-203-1 弹窗/提示行断言改判（无 custom 字段题恒可用语义不变）。
- [API-203-3 改写] /cancel 新语义：有 pending → 逐条发 `... 输入被取消`（新格式）+ q_input
  清除 + 消息重渲染（editMessageText）；无 pending → **静默**（sent 为空、editCount 为 0）；
  既有「无输入态纯文本静默」断言保留。来源：决策 #4。
- [API-208-1] 多记录取消主链路：A（q_input=0 + q_msg_id，**无 header** → 取消消息 label =
  question 截断兜底）待输入，点 B 的 Custom → ① sendMessage 收到 A 的取消消息（A 的
  projectLabel + 兜底 label 新格式）；② A.q_input 清除；③ A 的消息被 editMessageText
  （不含输入提示行 + 键盘保留）；④ B.q_input=0 落盘 + B 弹窗新文案。来源：决策 #3/#7。
- [API-208-2] 失效静默：A（q_input 残留且 resolved=true），点 B 的 Custom → 无取消消息 +
  A.q_input 被清 + B 正常进入输入模式。来源：决策 #6。
- [API-208-3] 同记录幂等：同一记录连续两次点 Custom → 不发取消消息、q_input 不被清、第二次
  重新提示。来源：决策 #5。
- [API-208-4] /cancel 逐条 + 无 pending 静默（**doc-prep 冻结：独立小用例**——/cancel 无 pending
  静默（sent 为空、editCount 为 0）+ 失效残留静默清，见 §14.9.5 API-208-4）。

**历轮回归（必须全绿）：**

- [API-001~005] behavior；[API-006/101~107] sessions-poller（含 permission 单表渲染/真实路径、
  rich message edit）；[REDACT-001~003]；[REG-101/201/301]；[LOCK-001~005]；[BUILD-001/002]。

### 界面（UI）测试

- 无（TG 向导由 stub 断言覆盖；真实端到端由用户按部署清单人工冒烟）。

### 本轮回归重点（修复轮次填写）

- （Round 1 首轮，暂无）

## Round 1

### Phase 1.1: 文案模板层——format 纯函数 + 弹窗/提示行接入 ✅

**目标**: 新文案模板落地：format.ts 3 个新纯函数（单一文案来源）+ 提示行与弹窗接入新模板。
**契约**: docs/modules/sessions-relay.md §14.9.1（doc-prep 冻结函数签名与文案模板）+ §14.9.6（编辑区间）
**并行组**: 批次 A（先行；1.2 依赖本 phase 的 format 新导出函数，须在本 phase 合并后开始）
**触碰范围**: `src/format/format.ts`（新增 questionLabel / questionInputPromptText /
questionInputCancelledText 三导出纯函数 + buildQuestionStageText 提示行 373-375 改用
promptText）；`src/monitor.ts`（import 区追加 3 个导出名 + custom 分支弹窗文案 3103-3107 改用
questionInputPromptText 并 safeText 200 截断）；`tests/sessions-poller.test.mjs`（API-203-1
区块 2587-2594 断言改判 + API-203-4 区块 2800-2809 断言改判）。**不碰** custom 分支取消逻辑
（1.2 地盘）、/cancel、handleQuestionTextInput、registry。
**分支**: `phase-r1-p1.1`　**worktree**: `.worktrees/phase-r1-p1.1`
**任务**:

- [ ] format.ts：`questionLabel(question: QuestionV2Info | undefined, ctx: FormatContext): string`
      ——header trim 非空直用（返回 trim 后 header）；否则
      `safeTextKeepPaths(question?.question ?? "", 60, ctx)` 截断兜底（**截断加 ASCII `...`**
      三个点——redact.ts `finishText` 69-75，非 `…`；question 可 undefined 为取消路径防御，
      契约 §14.9.1）
- [ ] format.ts：`questionInputPromptText(projectLabel: string, question: QuestionV2Info,
      ctx: FormatContext): string` —— `请输入 ${projectLabel} 的 ${questionLabel(...)} 答案，
      如果放弃输入请输入 /cancel`
- [ ] format.ts：`questionInputCancelledText(projectLabel: string, question:
      QuestionV2Info | undefined, ctx: FormatContext): string` ——
      `${projectLabel} 的 ${questionLabel(...)} 输入被取消`（question 可 undefined 为防御，
      契约 §14.9.1）
- [ ] buildQuestionStageText 提示行（373-375）：`fieldRow("输入", \`✏️ ${questionInputPromptText(
      projectLabel, current, ctx)}\`)`——current 判空防御保留（无 current 不渲染提示行）
- [ ] monitor.ts custom 分支弹窗（3103-3107）：文案改 `questionInputPromptText(projectLabel,
      current, ctx)`（ctx 构造方式按 questionStageText 现场同法），组装后 `safeText(..., 200,
      ctx)` 防御截断（Telegram answerCallbackQuery 200 字符上限）
- [ ] API-203-1/4 断言改判：弹窗与提示行断言改为插值模板（测试 questions 含 header）；
      改判于任务报告注明

**验收标准**:

- [ ] `HOME=$(mktemp -d) bun tests/sessions-poller.test.mjs` 全绿（API-203-1/4 改判 + 既有回归）
- [ ] `node scripts/build.mjs` exit 0

**实现记录**（2026-09-03，分支 `phase-r1-p1.1`，SHA `edf9b514`，merge `7d1ff51`）：
- 全部验收达成：sessions-poller 53/53（API-203-1/4 改判 + 既有回归）+ 构建 exit 0（18 模块）。
- 改判细节：两用例向导题入参加 `header: "补充说明头"`，弹窗与提示行断言改判为插值模板
  `请输入 project 的 补充说明头 答案，如果放弃输入请输入 /cancel`（projectLabel 硬编码
  "project"）；键盘保留与状态落盘断言不变。
- **契约偏差（已接受并回写契约 §14.9.1）**：弹窗 200 截断防御未用契约示例的 `safeText`——
  实证其 `redactPaths` 规则会把前置空格的 ` /cancel` 误判为外部路径脱敏为
  ` <external-path>`，弹窗文案变成「…请输入 <external-path>」与模板/断言冲突；改用
  `safeTextKeepPaths`（200 截断 + botToken 脱敏保留、跳过路径脱敏），`/cancel` 完整展示。

### Phase 1.2: 单活取消 + /cancel 统一——monitor 交互层 ✅

**目标**: custom 前置取消旧输入（发取消消息 + 清 q_input + 重渲染）+ /cancel 重写为逐条取消
新格式（无 pending 静默）+ rebuildQuestionState 去重重构。
**契约**: docs/modules/sessions-relay.md §14.9.2（单活取消）/ §14.9.3（/cancel 新语义）/
§14.9.4（rebuildQuestionState）/ §14.9.5（测试契约）/ §14.9.6（编辑区间）
**并行组**: 批次 B（依赖 Phase 1.1 合并——需其 format.ts 新导出函数；单 phase）
**触碰范围**: `src/monitor.ts`（custom 分支 3090-3098 前插入取消前置 + 新私有方法
cancelPendingQuestionInputs（放 handleQuestionCallback 近旁）+ rebuildQuestionState（新私有
helper，重构 handleQuestionCallback 2953-2958 与 handleQuestionTextInput 2362-2365 两处调用点
+ 取消路径第三处使用）+ /cancel 分支 2291-2296 重写）；`tests/sessions-poller.test.mjs`
（API-203-3 区块 2709-2778 改写 + 文件尾 3547 前新增 API-208-1~4 区块）。**不碰** format.ts/
registry/API-203-1/4 区块（1.1 地盘）。
**分支**: `phase-r1-p1.2`　**worktree**: `.worktrees/phase-r1-p1.2`
**任务**:

- [ ] 新私有方法 `rebuildQuestionState(record, questions): { draft, stage }`——抽取现有内联
      重建模式（rawDraft 复制 + stage 钳制），替换 handleQuestionCallback / handleQuestionTextInput
      两处内联 + 新取消路径使用（等价重构，行为不变）
- [ ] 新私有方法 `cancelPendingQuestionInputs(excludeRequestID?: string): Promise<number>`
      ——读 registry 全局扫描 `question && q_input != null && request_id !== exclude`：
      失效记录（resolved / q_answers != null / q_reject）→ 仅 `mutate(setQuestionInput(rec,
      id, null))` 静默清；活记录 → mutate 清 + `enqueueMessage(paragraph(
      questionInputCancelledText(projectLabel, questions[q_input], ctx)))` +
      parseQuestionPayload 成功且 q_msg_id 存在时 `renderQuestionStage(record, projectLabel,
      requestID, questions, stage, draft, false, this.config.chatId, record.q_msg_id)` 重渲染
      （解析失败/q_msg_id 缺失跳过编辑，取消消息照发）；返回取消并发消息的条数
- [ ] custom 分支前置（3096 setQuestionInput 之前）：`await this.cancelPendingQuestionInputs(
      requestID)`（排除自己=幂等刷新不取消）；随后原流程不变（setQuestionInput → 弹窗新文案
      → renderQuestionStage）
- [ ] /cancel 分支重写（2291-2296）：`const cancelled = await this.cancelPendingQuestionInputs()`
      ——不排除任何记录；**不再调用 clearQuestionInputs、不再无条件发确认**；返回 0（无任何
      活取消）→ 静默；失效残留静默清不计入
- [ ] registry `clearQuestionInputs` 保留不删（REG-301 用例仍测它），monitor 不再调用
- [ ] API-203-3 改写（逐条新格式 + 无 pending 静默 + 纯文本静默保留）+ API-208-1~4 新增
      （锚点：文件尾 3547 `await rm` 之前）

**验收标准**:

- [ ] `HOME=$(mktemp -d) bun tests/sessions-poller.test.mjs` 全绿（API-203-3 改写 + API-208-1~4
      新增 + 既有回归含 1.1 改判）
- [ ] `node scripts/build.mjs` exit 0
- [ ] 取消路径每步 registry 变化落盘（断言盘上状态，非内存）

**实现记录**（2026-09-03，分支 `phase-r1-p1.2`，SHA `1a35b0a`，merge `c4c4266`）：
- 全部验收达成：sessions-poller 57/57（API-203-3 改写 + API-208-1~4 新增 + 既有回归含 1.1
  改判）+ 构建 exit 0（143.19 KB）。与契约零偏差。
- 实现：`rebuildQuestionState` 私有方法抽取三处重复的 rawDraft 复制 + stage 钳制（等价重构）；
  `cancelPendingQuestionInputs(excludeRequestID?)` 按契约 §14.9.2（失效静默清不计入、活记录
  mutate 清 + enqueueMessage(paragraph(questionInputCancelledText)) + q_msg_id 存在且 payload
  可解析时 renderQuestionStage(inputPending=false) 重渲染、返回发消息条数）；custom 分支在
  setQuestionInput 前置调用并传当前 requestID；executeCommand 的 cancel 分支重写为逐条取消、
  无活取消静默，移除 clearQuestionInputs 调用与 import。
- API-203-3 改写：保留纯文本静默断言，主链路改为双待输入记录逐条取消断言（新格式取消消息 +
  q_input 清除 + 两向导消息重渲染去提示行留键盘）+ 再次 /cancel 静默断言。
- API-208-1~4：多记录取消主链路（A 无 header 走正文截断兜底）/ 失效静默 / 同记录幂等 /
  /cancel 无 pending 静默 + 失效残留静默清（独立小用例）。

### Round 1 整体测试记录

- 测试结论：【通过】（2026-09-03，main @ `c4c4266`）
- 102 用例 + 构建链全绿（8 任务 / 3 并发批次 / 峰值并发 5 / 重派 0）：behavior 8/8 +
  sessions-poller **57/57**（API-203-1/3/4 改判改写 + API-208-1~4 新增 + 50 条既有回归）+
  registry-sessions 20/20（含 clearQuestionInputs 保留用例）+ registry-concurrency 5/5 +
  redact-keep-paths 3/3 + bundle-smoke 3/3 + version-injection 3/3 + version-scripts 3/3；
  BUILD-001 exit 0（18 模块 143.19 KB）。
- 失败摘要与根因归属：无失败。
- 残余风险：① 真实 TG 端到端（弹窗视觉呈现、消息重渲染）由用户按部署清单人工冒烟；
  ② 极端长项目名+长 header 弹窗 200 截断兜底已有实现（safeTextKeepPaths）但未单测覆盖；
  ③ 4 个 real-* 实机测试有意未执行（历轮惯例，不在自动化门槛内）。

## Round 2（实机反馈修复轮，2026-09-03 用户真实测试后）

### 根因诊断

用户实机反馈：点 ✏️ Custom 后「没有新的模板消息发送，只有短暂的弹窗提示」。Round 1 将
Custom 提示落在两个载体：弹窗 toast（answerCallbackQuery，一闪即逝）+ 编辑原向导消息加
「输入」提示行（在长表格内不显眼）——**缺少一条独立的持久 TG 消息**。用户真实期望：点
Custom 后收到一条独立消息承载模板文案（作为后续纯文本输入的持久锚点）；多记录取消场景
「A 取消消息 → B 提示消息」均为持久消息序列。

### 已确认决策（用户实机反馈澄清，2026-09-03）

1. custom 分支**新增独立提示消息**：`enqueueMessage(paragraph(questionInputPromptText(
   projectLabel, current, ctx)))`（与取消消息同通道同形态，HTML 转义/脱敏链路一致）。
2. 弹窗与向导消息编辑提示行**均保留**（信息一致，冗余无害）；`/cancel` 与纯文本捕获路径
   不加消息（静默语义不变）。
3. doc-prep **跳过**（单 phase 窄修复，无跨 phase 契约接口；修复后 dev-lead 直接回写契约
   §14.9.1 提示通道定义）。

### Phase 2.1: custom 独立提示消息 ✅

**目标**: 点 Custom 后发送一条独立 TG 消息承载新模板文案（弹窗与编辑行保留）。
**契约**: docs/modules/sessions-relay.md §14.9.1（提示通道，合并后 dev-lead 回写修订）
**并行组**: 单 phase（实机反馈窄修复）
**触碰范围**: `src/monitor.ts`（custom 分支 renderQuestionStage 调用之后追加
enqueueMessage，约 3093-3113 区）；`tests/sessions-poller.test.mjs`（API-203-1/4 新增 sent
断言 + API-208-1/2/3 sent 精确断言改判；现场核对其它 custom 相关用例）。**不碰** format.ts/
registry/取消逻辑//cancel/handleQuestionTextInput。
**分支**: `phase-r2-p2.1`　**worktree**: `.worktrees/phase-r2-p2.1`
**任务**:

- [ ] custom 分支：`renderQuestionStage(...)` 之后追加
      `this.enqueueMessage(paragraph(questionInputPromptText(projectLabel, current, ctx)))`
      （current/ctx/projectLabel 均在作用域；enqueueMessage 入队 sendTail 串行，取消消息
      先入队 → 提示消息后入队，顺序天然正确）
- [ ] API-203-1/4：新增断言 sent 包含新模板提示消息（含 project 与 header 标识）
- [ ] API-208-1 改判：点 B Custom 后 sent = 2 条（sent[0] = A 取消消息、sent[1] = B 提示
      模板消息）；API-208-2 改判：sent = 1 条 B 提示消息（无「输入被取消」）；API-208-3
      改判：两次 Custom → sent = 2 条提示消息（无取消消息）；现场核对 API-207 等其它
      custom 相关用例的 sent 断言兼容性（includes 语义不破坏，精确条数断言逐一改判）
- [ ] 改判于任务报告注明

**验收标准**:

- [ ] `HOME=$(mktemp -d) bun tests/sessions-poller.test.mjs` 全绿（新增/改判 + 既有回归）
- [ ] `node scripts/build.mjs` exit 0

**实现记录**（2026-09-03，分支 `phase-r2-p2.1`，SHA `3a09291`，merge `cd362f7`）：
- 全部验收达成：sessions-poller 57/57（API-203-1/4 新增 sent 断言 + API-208-1/2/3 改判 +
  既有回归）+ 构建 exit 0（143.28 KB）。与契约零偏差。
- 实现：custom 分支 `renderQuestionStage(...)` 之后追加
  `this.enqueueMessage(paragraph(questionInputPromptText(projectLabel, current, ctx)))`
  （含注释说明 Round 2 动机与串行顺序）；弹窗与编辑行保留；取消逻辑与 /cancel 零改动。
- 断言：API-203-1/4 新增 sent 含提示消息断言；API-208-1 改判 2 条有序（sent[0] 取消、
  sent[1] 提示）；API-208-2 改判 1 条提示无取消；API-208-3 改判 2 条提示无取消；
  API-203-2/207-3/207-4 现场核对为 includes/some 语义无需改判；API-203-3/208-4 静默路径
  天然不受影响。
- 契约 §14.9.1 已回写「独立提示消息通道（Round 2 实机反馈修订）」三载体定义。

### Round 2 整体测试记录

- 测试结论：【通过】（2026-09-03，main @ `cd362f7`）
- 102 用例 + BUILD-001 全绿（9 任务 / 3 批次）：behavior 8/8 + sessions-poller **57/57**
  （修复行为 4 点核对全 ✓：提示消息在位与模板断言 / API-208-1 双消息顺序 / 208-2/3 条数
  语义 / 203-3/208-4 静默路径未破坏）+ registry-sessions 20/20 + registry-concurrency 5/5 +
  redact-keep-paths 3/3 + bundle-smoke 3/3 + version-injection 3/3 + version-scripts 3/3。
- 失败摘要与根因归属：F-001 唯一失败为 **ENV 类**（本机只有 Windows npm shim `bun.exe`，
  Linux node 子进程内 spawnSync("bun") ENOENT）——以 node 跑同一测试文件（断言零改动）
  3/3 通过，BUILD-001 单独运行亦 exit 0；非产品缺陷，CI/真 Linux 环境无此问题。
- 残余风险：① 真实 TG 端到端仍需用户人工冒烟（重点：点 Custom 收到独立提示消息）；
  ② 本机 bun 环境 quirk（Windows shim）影响「node 内嵌 spawn bun」链路的测试 harness 选择。

## 断点记录（运输层错误续传用）

- 流程坑（历轮记录，继续有效）：phase 分支可能存在历史残留空壳——签出前
  `git branch -f <branch> main` 重置；worktree add 注意 `-b` 兜底分支抢先。
- 本轮暂无断点。

## 交付总结

- **轮次**：1 轮完成（文档先行 → A[1.1] → 合并 → B[1.2] → 合并 → 整体测试【通过】）。
- **提交链**：`411093e`（docs 冻结 §14.9）→ `edf9b514`/`7d1ff51`（1.1 实现/merge）→
  `1a35b0a`/`c4c4266`（1.2 实现/merge，最终 HEAD）。
- **改动文件**：
  - `src/format/format.ts`：3 个导出纯函数（questionLabel——header 优先 + 正文 60 截断兜底、
    questionInputPromptText、questionInputCancelledText）+ buildQuestionStageText 提示行接入
    新模板（`✏️ 请输入 ... /cancel`）
  - `src/monitor.ts`：custom 弹窗新文案（safeTextKeepPaths 200 截断，/cancel 不被误脱敏）、
    custom 分支前置 cancelPendingQuestionInputs（单活输入模式：失效静默清 / 活记录发取消
    消息 + 清 q_input + 重渲染回正常视图）、/cancel 重写为逐条取消新格式（无 pending 静默）、
    rebuildQuestionState 三处去重重构、移除 clearQuestionInputs import（函数本体保留）
  - `tests/sessions-poller.test.mjs`：API-203-1/4 断言改判、API-203-3 改写、API-208-1~4 新增
    （共 4 新用例 + 3 用例改判改写）
  - `docs/modules/sessions-relay.md`：§14.9 契约（§14.9.1~§14.9.7）+ §14.9.1 实现修订
    （safeText → safeTextKeepPaths）
- **最终整体测试**：102 用例 + 构建链全绿（详见 Round 1 整体测试记录）。
- **待用户执行（部署清单）**：① `node scripts/build.mjs` 重新构建；② **关闭并重启所有
  opencode 窗口**（poller 与消费端都要加载新产物，历轮教训）；③ 产物 `monitor.ts` 复制到
  `~/.config/opencode/plugins/telegram-session-monitor.ts`；④ 确认 tgdiag.log 无 409（单
  poller）；⑤ 实机冒烟：触发 question → 点 ✏️ Custom（弹窗与消息提示行显示「请输入
  <项目> 的 <问题> 答案，如果放弃输入请输入 /cancel」）→ 不输入直接点另一 session 的
  Custom（收到旧输入「... 输入被取消」消息 + 旧消息恢复正常视图 + 新提示出现）→ 输入文本
  答案 → TUI 侧 question 真实收到；`/cancel` 逐条取消与无输入时静默。
- **遗留事项**：① 真实 TG 端到端人工冒烟（上述清单第 ⑤ 步）；② 向导无超时回收（历轮遗留，
  维持）；③ real-*.test.mjs 诊断测试未入库（历轮决策，维持）。

## 交付总结（Round 2 追加，2026-09-03）

- **Round 2**（实机反馈修复）：1 轮通过。根因——Round 1 将 Custom 提示落在弹窗 toast（一闪
  即逝）+ 向导消息编辑提示行（不显眼），用户实机体验后明确需要**一条独立的持久消息**。
- **修复内容**（Phase 2.1，`3a09291`/merge `cd362f7`）：custom 分支在弹窗与编辑行之外新增
  `enqueueMessage(paragraph(questionInputPromptText(...)))` 独立提示消息（三载体并存）；
  多记录取消场景消息顺序天然正确（A 取消 → B 提示，串行入队）。
- **测试**：API-203-1/4 新增 sent 断言、API-208-1/2/3 改判；整体 102 用例 + 构建链全绿
  （F-001 为本机 bun Windows shim 环境问题，非产品缺陷）。
- **待用户执行**：部署清单同 Round 1（重新构建 → **重启所有 opencode 窗口** → 复制产物 →
  实机冒烟）；冒烟重点：点 ✏️ Custom 后**收到一条独立消息**「请输入 <project> 的
  <question> 答案，如果放弃输入请输入 /cancel」；多点切换场景看到「... 输入被取消」+
  新提示消息的连续两条消息。
- **遗留事项（Round 2 后）**：① 真实 TG 端到端人工冒烟；② 本机 bun 环境 quirk（测试
  harness 记录在案）；③ 历轮遗留（向导无超时回收、real-* 未入库）维持。
