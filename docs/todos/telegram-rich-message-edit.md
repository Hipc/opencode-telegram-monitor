# Telegram 富文本消息编辑统一（首次富文本 + 编辑刷新持续渲染）

> 状态: in-progress
> 创建: 2026-09-03
> 当前轮次: Round 1
> 关联文档: docs/modules/sessions-relay.md（本轮契约冻结于 **§15**，模块契约序列第 5 号；
> supersede 记录见其 §11，变更记录见其 §12）、docs/00-overview.md、docs/02-directory-layout.md

## 背景

插件首次发送全部走**非官方**通道 `sendRichMessage` + `rich_message.html`（`src/monitor.ts`
`sendMessage`/`sendMessageWithKeyboard`，实机已验证 table/键盘生产可用），但三条**编辑**路径
（permission 结果编辑、question 向导编辑、/menu 刷新）全部走**官方** `editMessageText` +
纯文本 `text`：

- `editPermissionResultMessage`（src/monitor.ts 3264-3295）：`text = originalText + 结果行`，
  originalText 来自 `callback.message.text`；
- `editQuestionWizardMessage`（3305-3330）：`text = 完整重渲染或 callback.message.text + 结果行`；
- `editMenuMessage`（3332-3343）：`text = menuText()`——`menuText()` 本身是 HTML
  （`paragraph("📋 项目监控列表")` = `<p>…</p>`，src/format/format.ts 253-256）。

实机症状（用户报告）：编辑刷新后消息退回纯文本/表格丢失；menu 刷新泄漏 `<p>` 标签。
根因假定：网关对 `sendRichMessage` 发出的富文本消息，用官方 `editMessageText` 纯文本编辑时
无法按富文本载体处理——编辑请求必须采用与首次发送对称/兼容的**富文本 edit 形态**。该假定
**必须先用真实 Telegram 配置探测证实**，不得凭推断直接改代码。

## 已确认的关键决策（用户批准的共同理解，2026-09-03）

1. **目标**：Telegram 首次富文本消息及任何编辑刷新后，持续按表格/富文本渲染。
2. **范围**：question 向导 next/prev/选项/custom/submit/cancel 的编辑刷新；permission 结果编辑；
   menu 刷新（已调研确认 `menuText()` 也含 HTML）。
3. **不改变**：按钮 callback 业务、question 回答/permission 审批语义、首次发送格式
   （`sendMessage`/`sendMessageWithKeyboard` 的 body 与语义零变化）。
4. **探针前置（硬性）**：必须先以真实 Telegram 配置探测网关支持的富文本 edit payload；
   优先候选为与 `sendRichMessage`/`rich_message.html` 对称的 `editRichMessage`。若网关不支持任何
   富文本 edit 形态，**不得假装修复**（不得用纯文本 `editMessageText` 冒充），应如实上报并进入
   后续设计决策轮。
5. **不虚构最终 API 形态**：doc-prep 冻结的是「由 probe gate 选择且实现/测试必须一致」的判定
   契约（§15 探针契约）；具体 wire 方法名由编码 phase 首任务实测后按冻结判定规则实现；编码工人
   不能改 docs，最终由 dev-lead 回写实测结论。
6. **完整测试**必须包含：单元、构建、bundle/外部行为、真实 Telegram 编辑刷新验证（实机探针）。

## 涉及范围

- **新建**：`tests/e2e/real-rich-edit.test.mjs`（真实 Telegram 富文本 edit 探针，入库）；
  `docs/todos/telegram-rich-message-edit.md`（本文件）。
- **修改**：
  - `src/monitor.ts`：统一富文本 edit helper 新增 + 三条编辑路径迁移（editPermissionResultMessage /
    editQuestionWizardMessage / editMenuMessage 及其调用点）；question/permission 终态文本来源修正
    （脱离 `callback.message.text` 依赖，改为服务器侧重建）。
  - `tests/sessions-poller.test.mjs`：编辑 payload 相关既有断言最小改判（wire 方法名随探针结论）
    + 新增回归用例（API-301~304，见契约 §15.5）。
- **文档**：`docs/modules/sessions-relay.md`（§15 契约冻结 + §11/§12 记录，doc-prep 完成）。
- **不修改**：根 `monitor.ts` 构建产物、`src/telegram/client.ts`（传输层）、`src/format/*`、
  `src/registry/*`、`src/constants.ts`、`src/types.ts`。
- **依赖**：`~/.otg/telegram.json` 真实凭据可用（实机探针前提）；无代码层依赖。

## 上下文（探索结论，doc-prep 2026-09-03 核验）

- **首次发送**（src/monitor.ts 3380-3426）：`sendMessage`/`sendMessageWithKeyboard` =
  `telegramWithRetry("sendRichMessage", { chat_id, rich_message: { html: limitMessage(text) },
  reply_markup? })`——非官方方法名但生产可用（real-keyboard-channel 探针实证）；`limitMessage`
  在发送路径应用。
- **三条编辑路径现状**：
  - `editMenuMessage`（3332-3343）：`editMessageText` + `menuText()`（HTML `<p>…</p>`）+
    `buildMenuKeyboard`——**无 `limitMessage`**、无富文本载体 → `<p>` 泄漏根因；
  - `editPermissionResultMessage`（3264-3295）：`editMessageText` + `originalText + 结果行`；
    originalText 由调用方传入 `message.text ?? ""`（2764，= callback.message.text 纯文本视图）；
    不传 reply_markup ⇒ 键盘移除（§13.5 决策 #4）；
  - `editQuestionWizardMessage`（3305-3330）：`editMessageText` + 完整重渲染文本 + 可选
    keyboard；终态编辑（submit/cancel/单问题直接提交）文本为
    `${message.text ?? ""}\n✅ Submitted / ❌ Cancelled`（3010、3124、3142，= callback.message.text
    依赖）；纯文本输入路径（2393-2401）已用服务器侧 `questionStageText` 重建（保持）。
- **既有测试形态**：`tests/sessions-poller.test.mjs`（49 用例）经全局 fetch stub 断言编辑 payload，
  过滤条件 `call.url.includes("editMessageText")`（API-102 区 1389-1407、q 向导编辑断言区
  2044-2090 的 `edits`/`editCount` 辅助）——wire 方法名变更时这些断言需最小改判。
- **真实探针先例**：`tests/e2e/real-keyboard-channel.test.mjs`（E2E-201/202/203）与
  `real-keyboard-channel-diag.test.mjs`：读 `~/.otg/telegram.json` 凭据（botToken 打码输出）、
  经 `telegramRequest`（proxy 直连分支）、禁 getUpdates/answerCallbackQuery、逐条 try/catch、
  退出码收口——本轮探针沿用同款纪律。
- **索引**：codebase-memory 对本仓库 `full` 模式索引成功（2026-09-02，coverage 无记录缺口），
  上述行号为直接读取源码实证。

## Round 1

### Phase 1.1: 探测并统一 Telegram 富文本编辑

**目标**: 用真实网关探针确认唯一可维持表格渲染的富文本 edit 形态（优先 `editRichMessage` 对称
形态），实现一个统一私有 rich edit helper 并迁移三条编辑路径；修正 question/permission 终态
文本来源（脱离 `callback.message.text`），使首次富文本消息及任何编辑刷新后持续按表格渲染；
首次发送 payload 零变化。

**契约**: docs/modules/sessions-relay.md §15（doc-prep 冻结：探针候选/判定规则/helper 签名/
错误语义/终态文本来源/测试编号；wire 方法名由探针结论回填）

**并行组**: 批次 A（单 phase——`src/monitor.ts` 编辑 helper 区与 `tests/sessions-poller.test.mjs`
编辑断言区高度耦合，拆分会造成依赖与编辑区间冲突，故不拆分）

**分支**: `phase-r1-p1.1`　**worktree**: `.worktrees/phase-r1-p1.1`

**触碰范围**:

- `tests/e2e/real-rich-edit.test.mjs`（新建）：真实 Telegram 最小探针——发送一条含表格和按钮的
  富文本消息，再编辑**同一 message_id**，顺序验证探针候选与键盘两态；不得调用
  getUpdates/answerCallbackQuery；凭据不落盘不输出；测试所启动资源自行收尾（进程退出即释放，
  无守卫生效——单次请求序列设计）。
- `src/monitor.ts`：`editQuestionWizardMessage`、`editPermissionResultMessage`、`editMenuMessage`
  及其相邻统一 rich edit helper（新增，冻结签名 §15.3）；必要时修正 question/permission 终态
  文本来源（§15.4）；**不动** `sendMessage`/`sendMessageWithKeyboard` 首次发送语义与 body。
- `tests/sessions-poller.test.mjs`：只改编辑 payload 相关既有断言（wire 方法名随探针结论最小
  改判）与新增回归用例（API-301~304，§15.5）。

**任务**:

- [ ] 1. **先运行探针**（首任务，编码前不可写实现）：构建/校验 `tests/e2e/real-rich-edit.test.mjs`
      可用后运行，依序比较候选（§15.2）：`editRichMessage`+`rich_message.html`（对称优先）→
      `editMessageText`+`rich_message.html` → `editMessageText`+`parse_mode:"HTML"`；同一
      message_id 顺序编辑；每步同时验证键盘两态（携带 reply_markup 保留 / 省略移除）；记录唯一
      可维持 table 的形态与键盘保留/移除行为；按冻结判定规则（§15.2）得出 wire 形态结论。
- [ ] 2. **先写失败单元测试**（探针结论回填后）：锁定 question/permission/menu 三条编辑请求使用
      探针确认的富文本形态（wire 方法名 + body 载体字段断言）；锁定终态编辑文本为服务器侧重建
      （断言不含 `callback.message.text` 原文、含富文本结构）；锁定 keyboard 有/无两态
      （reply_markup 存在/缺失）- 见 §15.5 编号定义。
- [ ] 3. **实现统一 private rich edit helper**（冻结签名 §15.3，内部 wire 形态 = 探针结论）并
      迁移三条编辑路径（permission 结果 / question 向导 / menu 刷新）；保持现有错误处理语义
      （logWarn + errorCategory 脱敏 + 不抛错）与 `limitMessage` 限长；终态文本来源按 §15.4 修正。
- [ ] 4. **只运行本 phase 直接相关单元测试**（`HOME=$(mktemp -d) bun tests/sessions-poller.test.mjs`）
      与该实机探针（`bun tests/e2e/real-rich-edit.test.mjs`）；**禁止**全量/集成测试/整项目检查
      （behavior/registry/redact/bundle 均归终验，本 phase 不做）。

**验收标准**:

- [ ] next/prev/option/custom 刷新 request 保留 table 富文本载体和键盘（API-301）；
- [ ] submit/cancel/permission 结果仍富文本，结果行正确，键盘移除（API-301/302）；
- [ ] menu 刷新不泄漏 `<p>` 标签（富文本载体承载 HTML，API-303）；
- [ ] 首次发送 payload 不变（sendMessage/sendMessageWithKeyboard 零改动，API-304 回归断言）；
- [ ] 实机同 message_id 编辑后表格仍渲染（探针结论 + 人眼确认项）；
- [ ] 对应单元测试通过（sessions-poller 全绿含改判与新增）。

**实现记录**: （编码 phase 完成后由工人/ dev-lead 回填：探针结论、提交 SHA、测试结果）

## 最终验证测试任务

> 累计维护（含历轮全部对外接口面，保证回归；终结验由 dev-lead 于合并后统一调度）。

### 外部接口（API/REG 项）

- 完整单元套件：`tests/behavior.test.mjs`（API-001~005）、`tests/sessions-poller.test.mjs`
  （API-006/101~106/201~207 + 本轮 API-301~304）、`tests/registry-sessions.test.mjs`
  （REG-101/201/301）、`tests/registry-concurrency.test.mjs`（LOCK-001~005）、
  `tests/redact-keep-paths.test.mjs`（REDACT-001~003）；
- 构建链：`node scripts/build.mjs` exit 0 + 根 `monitor.ts` 产物（BUILD-001）+ bundle 加载
  外部行为 `tests/e2e/bundle-smoke.test.mjs`（BUILD-002：default 为函数、无其它导出）。

### 实机 API（真实 Telegram 探针，本轮新增）

- [REAL-RICH-EDIT-001~005] `tests/e2e/real-rich-edit.test.mjs`：发送带 table+keyboard 的富文本
  消息（sendRichMessage + rich_message.html），同 message_id 顺序执行三个编辑候选，分别验证
  **保留 keyboard**（携带 reply_markup）与**省略 reply_markup 移除 keyboard** 两态；结论按
  冻结判定规则写入任务报告。

### UI（Telegram 界面，人眼/可观察验证）

- 触发 question，点击 next/prev/option/custom/submit/cancel，肉眼验证 table 不变纯 HTML（无
  标签泄漏、无表格退化为纯文本）；
- permission 按钮点击后结果编辑仍富文本（结果行正确、键盘移除）；
- /menu 刷新不泄漏 `<p>` 标签。

## Round 1 整体测试记录

- （终验后由 dev-lead 回填：测试结论、用例数、提交链）

## 断点记录（运输层错误续传用）

- 流程坑（历轮记录，继续有效）：phase 分支可能存在历史残留空壳——签出前
  `git branch -f <branch> main` 重置；worktree add 注意 `-b` 兜底分支抢先。
- 本轮暂无断点。

## 交付总结

- （本轮完成后由 dev-lead 回填：探针选择的 wire 形态、提交链、测试结论、遗留事项；
  契约侧 dev-lead 需把实测结论回写 docs/modules/sessions-relay.md §15.2 判定结果占位）