# permission 详情表格化：单表 + 真实 Pattern 路径 + 逐行编号

> 状态: in-progress
> 创建: 2026-09-02
> 当前轮次: Round 1
> 关联文档: docs/modules/sessions-relay.md#§13.11（本轮 supersede，见 doc-prep 冻结的 §13.12）

## 背景

用户反馈：TG 收到的 permission 通知正文仍是 JSON 原文节选，且 pattern 值被路径脱敏
（`<external-path>`）导致看不到请求的具体路径，无法据此做审批决策。诊断确认：

1. 运行中的 poller 产物停在 Round 1（有按钮、无 Round 2.1 结构化渲染）——**代码合并后
   必须重新部署**（重建 → 清旧进程 → 替换产物 → 重启），否则看不到新格式。
2. 即使 Round 2.1 结构化渲染生效，`safeText` 也会把绝对路径替换成 `<external-path>`、
   项目内路径替换成 `<project>`（redact.ts:61-62），用户仍看不到真实路径。
3. 当前多 pattern 用 `\n` 拼进单个 Pattern 行（monitor.ts:1838），与需求（逐行）不符。

## 已确认的关键决策（用户 grilling 确认，2026-09-02）

1. Pattern/Permission 值**放开路径脱敏，显示完整真实路径**；botToken/密钥类脱敏保留。
2. 原有 Type/Session 行保留；结构化详情**只列 Permission + Pattern**（去掉 Title 行）。
3. 多个 pattern → 每个独占一行，标签 `Pattern 1` / `Pattern 2` / …；单个 → 标签 `Pattern`。
4. **合并为一张表**：Type/Session/Permission/Pattern 全部行进同一个 fieldTable。
5. 兜底保留：JSON 解析失败/非对象/无可识别字段 → 300 字符原文节选（现行为）；
   limitMessage 3500 总长截断保留（用户已确认接受）。

## 涉及范围

- **修改**:
  - `src/format/redact.ts`（新增 keep-paths 脱敏变体导出）
  - `src/monitor.ts`（仅 `formatSessionRecordMessage` 方法体 + import 块追加一个名字）
  - `tests/sessions-poller.test.mjs`（API-105 区块更新 + 追加）
- **新增**:
  - `tests/redact-keep-paths.test.mjs`（keep-paths 变体单测，REDACT-001~003）
- **依赖**: 无新外部依赖；bun 测试基建沿用

## 上下文（探索结论）

- `formatSessionRecordMessage`（src/monitor.ts:1794-1858）：当前两张表（Type/Session 一张 +
  Permission/Pattern/Title 一张），Pattern 全部 `\n` 拼一行，值经 `safeText(..., 300, ctx)`
  （路径被脱敏）。fallback = `paragraph(safeText(record.message, 300, ctx))`。
- `safeText`（src/format/redact.ts:24-68）：密钥/token 脱敏链 + `ctx.root → <project>` +
  绝对路径 → `<external-path>` + **40 字符长 blob → `[REDACTED_VALUE]`**（注意：该规则
  字符类含 `/`，40+ 字符的绝对路径会被整段替换——keep-paths 变体必须同时跳过此规则，
  否则典型绝对路径仍看不到）。
- monitor.ts 经 `./format` barrel 导入（format/index.ts `export * from "./redact"`，
  redact.ts 新导出自动可用，index.ts 零改动）。
- `TELEGRAM_MESSAGE_LIMIT = 3_500`（constants.ts:18）；`limitMessage` 有标签边界安全截断。
- `fieldRow(label, value)` → `<tr><th>label</th><td>escaped</td></tr>`；`fieldTable(rows)`
  → `<table compact>...</table>`。
- 测试：`HOME=$(mktemp -d) bun tests/sessions-poller.test.mjs`（API-006/101~105），
  纯函数测试可直接 `bun tests/xxx.test.mjs`（behavior.test.mjs 先例：直接 import src TS）。
- 分支 `main`（.git/HEAD 确认）；`.worktrees/` 尚不存在（doc-prep 负责确认 gitignore）。

## 最终验证测试任务

> 由 dev-lead 维护，每轮整体测试前更新，**累计维护**（含历轮所有对外面，保证回归）。

### 外部接口测试

**本轮新增/更新：**

- [API-105r] 结构化渲染（更新）：permission 记录（message 含 permission + 多 patterns）→
  渲染为**单张** fieldTable（Type/Session/Permission/Pattern 1/Pattern 2 行），多 pattern
  逐行编号、单 pattern 标签为 `Pattern`；**不出现** Title 行、不出现 `{` 开头 JSON dump；
  来源：决策 #2/#3/#4。
- [API-106] 真实路径（新增）：pattern 为绝对路径（含 40+ 字符长路径）→ 原样显示，
  **不含** `<external-path>` / `<project>` / `[REDACTED_VALUE]`；来源：决策 #1。
- [REDACT-001~003] keep-paths 变体单测：绝对路径保留原样（含 40+ 字符）；botToken/密钥
  仍脱敏；limit 截断行为与 safeText 一致。来源：决策 #1。
- 兜底回归（既有 API-105-2/3 语义保持）：非法 JSON / 空对象 → 退回 300 字符原文节选。

**历轮回归（必须全绿）：**

- [API-001~005] behavior.test.mjs（写入/去抖/resolved 回写/并发）
- [API-006] sessions-poller.test.mjs（扫描发送语义）
- [API-101~104] sessions-poller.test.mjs（按钮/回调/回写/双路径）
- [REG-101/201] registry-sessions.test.mjs；[LOCK-001~005] registry-concurrency.test.mjs
- [BUILD-001] `node scripts/build.mjs` exit 0；[BUILD-002] bundle 冒烟 3 断言

### 界面（UI）测试

- 无（TG 渲染由 stub 断言覆盖；真实端到端由用户按部署清单人工冒烟）。

### 本轮回归重点（修复轮次填写）

- （Round 1 首轮，暂无）

## Round 1

### Phase 1.1: redact.ts keep-paths 脱敏变体 ⬜

**目标**: 新增导出 `safeTextKeepPaths(value, limit, ctx)`——保留全部密钥类脱敏、跳过全部
路径类脱敏（root 替换、external-path 正则、40 字符 blob 规则），供 permission 详情值展示。
**契约**: docs/modules/sessions-relay.md §13.12.1（doc-prep 本轮冻结：密钥链逐条原样 + 跳三条
路径类规则 + 空白折叠/trim/limit 截断一致 + 既有导出零行为变化）
**并行组**: 批次 A（与 1.2 并发；契约冻结签名后无编辑冲突——1.1 只碰 redact.ts 与新测试文件）
**触碰范围**: `src/format/redact.ts`（新增导出函数，建议以私有共享 helper 复用密钥脱敏链，
**不得改动 `safeText`/`safePath`/`safeToolTarget`/`safeProgress` 既有行为**）；
新建 `tests/redact-keep-paths.test.mjs`（REDACT-001~003）。**不碰** monitor.ts / sessions-poller.test.mjs。
**分支**: `phase-r1-p1.1`　**worktree**: `.worktrees/phase-r1-p1.1`
**任务**:

- [ ] 新增 `export function safeTextKeepPaths(value: string, limit: number, ctx: RedactionContext): string`：
      密钥/token 脱敏链与 safeText 完全一致（PRIVATE KEY/botToken/TG token 形态/Bearer/
      sk-/ghp_/github_pat_/glpat-/xox/pypi/hf_/AIza/JWT/AKIA/KEY=xxx/URL），**跳过**
      `ctx.root → <project>`、绝对路径 → `<external-path>`、`\b[A-Za-z0-9_+/=-]{40,}\b →
      [REDACTED_VALUE]` 三条规则；空白折叠/trim/limit 截断（`slice + "..."`）与 safeText 一致
- [ ] 既有导出零行为变化（safeText 等不动；重构内部共享 helper 允许，但密钥链顺序不得变）
- [ ] 新建 `tests/redact-keep-paths.test.mjs`：REDACT-001（绝对路径 `/a/b/c.ts` 与 45 字符
      长路径原样保留）、REDACT-002（botToken 与 `sk-xxx` 密钥仍被 `[REDACTED]`）、
      REDACT-003（limit 截断加 `...` 尾）

**验收标准**:

- [ ] `bun tests/redact-keep-paths.test.mjs` 全绿（纯函数测试可直接运行，无需 HOME 隔离）
- [ ] `node scripts/build.mjs` exit 0

**实现记录**: （待填）

### Phase 1.2: formatSessionRecordMessage 单表渲染 + Pattern 逐行 ⬜

**目标**: permission 记录渲染为单张 fieldTable（Type/Session/Permission/Pattern N 行），
Pattern 逐行编号、值经 safeTextKeepPaths 显示真实路径；去掉 Title 行；fallback 保持。
**契约**: docs/modules/sessions-relay.md §13.12（doc-prep 本轮冻结；§13.12.2 渲染规则 +
§13.12.3 测试编号 + §13.12.4 编辑区间）
**并行组**: 批次 A（与 1.1 并发；1.2 只碰 monitor.ts 的 formatSessionRecordMessage 方法体 +
  import 块追加 `safeTextKeepPaths` 一行，以及 tests/sessions-poller.test.mjs）
**触碰范围**: `src/monitor.ts`（**仅** import 块（48-82 区）追加一个导入名 +
  `formatSessionRecordMessage` 方法体（现 1794-1859）；**禁改** 发送链/键盘/handleCallback/
  registry/写入端）、`tests/sessions-poller.test.mjs`（API-105 区块 907-1001 更新 + API-106
  尾部追加，允许最小修正受影响的既有断言行并在报告注明）。
**分支**: `phase-r1-p1.2`　**worktree**: `.worktrees/phase-r1-p1.2`
**任务**:

- [ ] `formatSessionRecordMessage` 重写渲染：rows = [Type, Session] + 结构化行合并进
      **同一张** fieldTable；结构化行只含 Permission（值 `safeTextKeepPaths(permission, 300, ctx)`）
      与 Pattern 行——patterns 数组（`patterns ?? resources ?? pattern`，宽松归一）逐项一行：
      单个标签 `Pattern`，多个标签 `Pattern 1`/`Pattern 2`/…，值 `safeTextKeepPaths(item, 300, ctx)`
- [ ] 去掉 Title 行（parsed.title 不再渲染）
- [ ] fallback 语义保持：JSON.parse 失败/非对象/Permission 与 Pattern 行均无输出 →
      在表格后追加 `paragraph(safeText(record.message, 300, ctx))` 原文节选（300 字符，路径
      脱敏照旧）；question 记录渲染零改动
- [ ] 整体仍经 `limitMessage`；titleLine + 单表结构
- [ ] `tests/sessions-poller.test.mjs`：更新 API-105-1（单表断言：恰 1 个 `<table`、
      `Pattern 1`/`Pattern 2` 编号行、无 `Title`）；新增 API-106（绝对路径 + 45 字符长路径
      原样出现，无 `<external-path>`/`<project>`/`[REDACTED_VALUE]`）；API-105-2/3 保持

**验收标准**:

- [ ] `HOME=$(mktemp -d) bun tests/sessions-poller.test.mjs` 全绿（含全部既有回归）
- [ ] `node scripts/build.mjs` exit 0
- [ ] 渲染产物：合法 permission 记录不含未解析 JSON 原文、不含 Title 行、pattern 为真实路径

**实现记录**: （待填）

### Round 1 整体测试记录

- 测试结论：（待填）
- 失败摘要与根因归属：（待填）

## 断点记录（运输层错误续传用）

- 流程坑（历轮记录，继续有效）：phase 分支可能存在历史残留空壳——签出前
  `git branch -f <branch> main` 重置；worktree add 注意 `-b` 兜底分支抢先。
- 本轮暂无断点。

## 部署清单（代码合并 + 整体测试通过后，用户手工执行）

1. `node scripts/build.mjs` 重新构建
2. 停止旧插件进程（tgdiag.log 中旧版 PID），关闭多余 opencode 窗口
3. 产物 `monitor.ts` 复制到 `~/.config/opencode/plugins/telegram-session-monitor.ts`
4. 重启 opencode，确认只剩一个 poller（tgdiag.log 无 409）
5. 触发一次真实 permission 请求，肉眼验证：单张表格 + Permission 行 + 真实路径
   Pattern 行（多 pattern 逐行编号）+ 三按钮 + 点击链路

## 交付总结

（待填）
