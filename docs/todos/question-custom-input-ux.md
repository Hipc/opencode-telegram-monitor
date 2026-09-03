# question Custom 输入提示增强：单活输入模式 + 提示带项目/问题标识

> 状态: in-progress
> 创建: 2026-09-03
> 当前轮次: Round 1
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

### Phase 1.1: 文案模板层——format 纯函数 + 弹窗/提示行接入 ⬜

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

**实现记录**: （合并后由 dev-lead 回写）

### Phase 1.2: 单活取消 + /cancel 统一——monitor 交互层 ⬜

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

**实现记录**: （合并后由 dev-lead 回写）

### Round 1 整体测试记录

- 测试结论：（待填）
- 失败摘要与根因归属：（待填）

## 断点记录（运输层错误续传用）

- 流程坑（历轮记录，继续有效）：phase 分支可能存在历史残留空壳——签出前
  `git branch -f <branch> main` 重置；worktree add 注意 `-b` 兜底分支抢先。
- 本轮暂无断点。

## 交付总结

（交付时填写）
