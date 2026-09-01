# monitor.ts 单文件拆分为多模块

> 状态: completed
> 创建: 2026-09-02
> 当前轮次: Round 1
> 关联文档: docs/todos/shared-file-store.md（历史交付记录，勿混用）
> 契约文档: **docs/modules/split-contracts.md**（Round 1 冻结于 `docs(round 1): freeze design docs & contracts for round 1`；以下各 phase 的「契约冻结时定」项均已在该文件决议）

## 背景

monitor.ts 已增长到 3611 行（主类约 2767 行），单文件不利于维护。目标：源码拆成 src/ 多文件多目录，主类 TelegramSessionMonitor 保留；能拆成纯函数的功能全部拆出为独立文件。对外机制（npm 发布、本地单文件复制安装、自更新）通过「bun bundle 打包回单文件 monitor.ts 产物」保持完全不变。

## 涉及范围

- **新增**: `src/` 全部源码模块（见 Round 1 phase 清单）、`tests/behavior.test.mjs`（行为验证脚本）、`scripts/build.mjs`（bundle 构建脚本）
- **修改**: `package.json`、`.github/workflows/publish.yml`、`scripts/check-version.mjs`、`scripts/set-version.mjs`、`README.md`、`.gitignore`
- **删除**: 根目录 `monitor.ts`（变为构建产物，git rm + gitignore）
- **不动**: `PLUGIN_VERSION = "0.5.3"`（不发版）、`~/.otg/` 数据格式、任何运行时行为

## 上下文（探索结论）

### 顶层结构（monitor.ts 3611 行）
- 类：PollerLock(55-174)、SharedFileStore(189-248，未接线 dead code，原样平移)、TelegramApiError(441-450)、TelegramSessionMonitor 主类(452-3218)、ProjectRegistryStore(3351-3488)
- 顶层函数：dline(35-44)、delay(181)、registry 纯函数族(3232-3349)、loadConfig(3490-3537)、isMissingFile(3539)、writeInitializationError(3547)
- 常量：OTG_DIR/DIAG_PATH(30-31)、版本/self-update 常量(260-276)、时间限额常量(277-288)、PLANNED_COMMANDS(291-298)、ICON_*(303-317)
- 类型 22 个（321-439 + 48/183 + 3220-3230）
- 入口：`export default ... satisfies Plugin`(3564-3611)，依赖 loadConfig/ProjectRegistryStore/registerProject/TelegramSessionMonitor/writeInitializationError/SERVICE

### 纯方法三档核实结论（very thorough explore）
- **A 档（23 个，完全无 this，原样平移）**：record/string/number/rememberBounded(MAX_EVENT_IDS)/formatNumber/formatCost/formatDuration/shortID/matchesSessionID/limitMessage(TELEGRAM_MESSAGE_LIMIT)/todoCounts/totalTokens/emptyTokens/escapeHtml/fieldTable/iconForOutcome/iconForState/iconForWaitingType(ICON_*)/parseProxy/displayState/buildMenuKeyboard(entryToken+basename+MENU_MAX_PROJECTS)/todoSummary+iconForState（⚠️ 签名有 `ReturnType<TelegramSessionMonitor[...]>` 类型自引用，需改为独立导出类型）
- **B 档（17 个，参数化上下文 = {root, botToken, projectLabel, sessions, sessionInfo}）**：paragraph/fieldRow/titleLine(projectLabel)/sessionTitle/sessionLabel/errorCategory/safeText(botToken,root)/safePath(root)/safeToolTarget/safeProgress/aggregateTokens(childSessions)/helpText/menuText/formatTodos/formatUsage/formatStatus/formatTerminalNotification——6 个重点方法的直接 this.字段依赖 = 0，全部经方法调用，参数化机械
- **childSessions(2725)**：只读 this.sessions/this.sessionInfo 两个 Map → 作参数传入即可
- **不可拆**：handleEvent 链、runTelegram、command*/callback、sendMessage 链、scheduleWaitingNotify 系列（timers）、自更新五方法——强耦合实例状态/定时器，留在主类

### 外部契约依赖点（拆分必须联动）
- `scripts/set-version.mjs:31,37,42`：join(root,"monitor.ts") + 正则 `/const PLUGIN_VERSION = "[^"]+";/` → 改读 src/version.ts
- `scripts/check-version.mjs:35,41,43`：同上 → 改读 src/version.ts
- `.github/workflows/publish.yml:74`：`bun build --no-bundle ... monitor.ts` → 改为先 bundle 构建产物再发布
- `package.json:6-16`：main/types/files/check/prepublishOnly → files 保持 ["monitor.ts",...]（CI 现场构建产物），check/prepublishOnly 改 bundle
- self-update（主类内 578-660）：staged 路径断言 package/monitor.ts + `staged.includes('const PLUGIN_VERSION = "x"')` —— bun build 默认不 minify、顶层 const 字面量保留（需测试实机断言，不凭推断）；兜底方案：改读 staging 包内 package.json 的 version 字段
- README.md L49-58 本地单文件安装、L79 版本来源声明 → 更新为「先构建再复制产物」+ 版本来源 src/version.ts
- 过期注释：monitor.ts:263 `scripts/publish-version.mjs` 实为 set-version.mjs，拆分时一并修正

### git 基线与环境
- 分支 `main`，HEAD `674c74c2e9a4ed96f967d23743f795b860660c94`
- bun 已安装（~/.bun 存在，历史验证均用 bun build）
- 工作区洁净度未验证（doc-prep/coder 有 bash，开工时自查；发现脏工作区立即上报）

### 项目约定（铁律，所有 coder 必须遵守）
- **只读**：绝不通过 client.permission.reply / question 接口代答
- botToken 打码：safeText/dline 路径的脱敏行为**逐字节保持不变**
- 跨进程 PollerLock、事件去重集合上限（MAX_EVENT_IDS=2000）语义不变
- **行为不变优先**：拆分是纯机械平移 + 参数化，不改逻辑、不改通知格式、不改常量值；SharedFileStore 与 httpRequest 死代码按现状平移，不接线不删除
- commit 信息英文，Conventional Commits

### 构建与验证方式
- 无测试框架；验证 = `bun build` 语法冒烟 + `tests/behavior.test.mjs` 行为断言（stub enqueueMessage 喂事件）
- Round 1 的 A 批次 phase 只新建文件：允许 `bun build --no-bundle --target node --external "*" <本phase文件>` 做语法自检；对尚不存在的兄弟模块的 unresolved import 属预期，不算失败
- 最终 bundle：`bun build --target node --external "@opencode-ai/plugin" --external "@opencode-ai/sdk" src/index.ts --outfile monitor.ts`（不 minify）

## 最终验证测试任务

> 累计维护。本轮无 UI；外部面 = 插件行为 + 构建产物 + 版本脚本。

### 外部接口测试

- [API-001] 行为脚本 tests/behavior.test.mjs：auto-approve（permission.asked 随即 permission.replied）→ 0 条通知；来源 AGENTS.md 验证章节
- [API-002] 行为脚本：真待审批（仅 permission.asked，等 2.5s）→ 恰 1 条通知，内容含 ⚠️ 图标与 `permission` 类型行（**实证修正**：notifyWaiting 实际输出为 titleLine(iconForWaitingType)+fieldTable，不含 `[WAITING]` 字面；AGENTS.md 该描述已过时，本测试断言真实行为）；来源 AGENTS.md 验证章节 + monitor.ts:1231-1254 实证
- [API-003] 行为脚本：question.asked → 立即 1 条通知（不去抖）；来源 AGENTS.md 验证章节
- [API-004] 构建产物：`node scripts/build.mjs` 产出根目录 monitor.ts，exit 0，产物含 `PLUGIN_VERSION = "0.5.3"` 形态（bun 会把 const 重写为 var，任意关键字匹配即可）；self-update 校验已实证走兜底（读包内 package.json version），不依赖 const 字面量；来源 验收标准 + Phase 1.8/1.9 实证
- [API-005] `node scripts/check-version.mjs v0.5.3` exit 0（读 src/version.ts）；`node scripts/check-version.mjs v9.9.9` exit 非 0；来源 验收标准
- [API-006] bundle 产物 import 冒烟：产物可被 `import()` 加载且 default 导出为函数（satisfies Plugin 形态）；来源 插件约定

### 界面（UI）测试

- 无（本插件无 UI）

### 本轮回归重点（修复轮次填写）

- （首轮无）

## Round 1

### 并行分组总览（doc-prep 冻结，dev-lead 调度依据）

- **批次 A**（7 个 worktree 全并发）：**1.1–1.7**。全部为新建文件，编辑区间零重叠；互相之间
  的 import 按 split-contracts.md §2 冻结路径/导出名先行写定，兄弟模块未落盘导致 per-phase
  语法自检 unresolved import 属预期（不算失败）。
- **批次 B**（批次 A 全合并后，2 个 worktree 并发）：**1.8 + 1.9**。1.8 依赖 A 全部；1.9 依赖
  1.1 的 version.ts 契约。编辑区间不相交（1.8: src/monitor.ts + src/index.ts + git rm --cached
  monitor.ts；1.9: scripts/build.mjs + package.json + publish.yml + check/set-version.mjs +
  README.md + .gitignore）。
- 合并顺序：A 任意序 → B 任意序；整体测试在 B 合并后执行（1.7 完整断言也在此时）。
- 分支/worktree 统一：`phase-r1-p1.{1..9}` / `.worktrees/phase-r1-p1.{1..9}`。

### Phase 1.1: src/version.ts + src/constants.ts + src/types.ts ✅

**实现记录**: 完成。分支 `phase-r1-p1.1`，SHA `dece569`，worktree 已删。三文件与 monitor.ts 原文值级 diff EXIT=0（仅 export 前缀 + :263 注释修正）；PLUGIN_VERSION 字面形态保留；契约新增 TodoCounts/TokensSummary/SessionDisplayState。备注：bun 多入口 build 需 --outdir，语法自检用单入口逐文件等效执行。

**目标**: 建立 src/ 的基础层——版本常量、共享常量、共享类型，供后续所有模块 import
**并行组**: 批次 A（可与 1.2–1.7 并发）
**触碰范围**: 仅新建 src/version.ts、src/constants.ts、src/types.ts；不改任何现有文件
**分支**: `phase-r1-p1.1`　**worktree**: `.worktrees/phase-r1-p1.1`
**契约**: docs/modules/split-contracts.md §2.1（version.ts: PLUGIN_VERSION 字面形态/export const 均可）、§2.2（constants.ts 全清单）、§2.3（types.ts + 新增 TodoCounts/TokensSummary/SessionDisplayState）
**任务**:

- [ ] src/version.ts：PLUGIN_VERSION（保持字面 `const PLUGIN_VERSION = "0.5.3";` 形态，scripts 正则依赖）、TARGET_OPENCODE_VERSION、SERVICE、NPM_PACKAGE_NAME、NPM_REGISTRY_BASE、SELF_UPDATE_FETCH_TIMEOUT_MS、OPENCODE_CACHE_MARKERS（自 monitor.ts 260-276，含注释随迁；修正 :263 过期脚本名）
- [ ] src/constants.ts：OTG_DIR、DIAG_PATH、DEFAULT_TTL_MS、IDLE_DEBOUNCE_MS、WAITING_NOTIFY_DEBOUNCE_MS、TELEGRAM_*、MAX_EVENT_IDS、MENU_MAX_PROJECTS、POLLER_*、REGISTER_INTERVAL_MS、PLANNED_COMMANDS、ICON_*（自 30-31/46/277-317）
- [ ] src/types.ts：LogLevel/SessionState/SessionOutcome/ToolState/WaitingType、TokenTotals、ErrorSummary、WaitingProjection、ToolProjection、SessionProjection、RuntimeEvent、Telegram 协议类型（CallbackQuery/InlineButton/InlineKeyboard/Update/Envelope）、TelegramConfig、ProxySpec（自 321-439/327/333）
- [ ] 新增独立导出类型 TodoCounts/TokensSummary（供 todoSummary/iconForState 签名解耦类自引用）

**验收标准**:
- [ ] 三个文件符号清单与 monitor.ts 原符号一一对应（无遗漏/重命名/默认值变化）
- [ ] `bun build --no-bundle --target node --external "*" src/version.ts src/constants.ts src/types.ts` 语法通过

### Phase 1.2: src/diagnostics.ts + src/infra/ ✅

**实现记录**: 完成。分支 `phase-r1-p1.2`，SHA `a6b9faf`，worktree 已删。4/4 语法自检通过 + 字节级等价核验 MATCH；mkdirSync 副作用随迁 diagnostics.ts（契约 §2.2）；SharedFileStore 原样平移。备注：diagnostics import 路径按契约用 `./constants`（计划文件原写 `../constants` 系笔误）。

**目标**: 拆出诊断日志与跨进程基础设施
**并行组**: 批次 A（可与 1.1、1.3–1.7 并发）
**触碰范围**: 仅新建 src/diagnostics.ts、src/infra/delay.ts、src/infra/poller-lock.ts、src/infra/shared-file-store.ts；不改任何现有文件
**分支**: `phase-r1-p1.2`　**worktree**: `.worktrees/phase-r1-p1.2`
**契约**: docs/modules/split-contracts.md §2.4（diagnostics：OTG_DIR/DIAG_PATH 自 ../constants import，mkdirSync 顶层副作用随迁）、§2.5（infra：poller-lock 不 import delay/dline——纠正旧表述；shared-file-store import delay+poller-lock）
**任务**:

- [ ] src/diagnostics.ts：OTG_DIR/DIAG_PATH 引用自 constants（**冻结：自 ../constants import**）、dline（自 35-44）；`mkdirSync(OTG_DIR, {recursive:true})`（原监测顶层 33 行副作用）随迁至本文件顶层
- [ ] src/infra/delay.ts：delay（自 181-188）
- [ ] src/infra/poller-lock.ts：LockInfo 类型 + PollerLock 类（自 48/55-174）原样平移（**冻结：仅 import constants/fs/os/crypto/path，不 import delay/dline**）
- [ ] src/infra/shared-file-store.ts：SharedFileStoreOptions + SharedFileStore（自 183/189-248）原样平移（dead code，不接线；import ./delay + ./poller-lock）

**验收标准**:
- [ ] 四个文件与原实现逐行等价（仅 import 路径变化）
- [ ] `bun build --no-bundle --target node --external "*" src/infra/*.ts` 语法通过（未建兄弟模块的 import 失败属预期）

### Phase 1.3: src/config/ ✅

**实现记录**: 完成。分支 `phase-r1-p1.3`，SHA `9ff36b2`，worktree 已删。三函数逐字节平移（diff 验证），校验正则/打码不变。偏差：ProxySpec 未从 load-config re-export（函数体未用到，契约 §2.6 亦未声明导出）——telegram/types.ts 已直接从 types.ts 转口，无影响。

**目标**: 拆出配置读取
**并行组**: 批次 A（可与 1.1、1.2、1.4–1.7 并发）
**触碰范围**: 仅新建 src/config/load-config.ts（含 isMissingFile、writeInitializationError）；不改任何现有文件
**分支**: `phase-r1-p1.3`　**worktree**: `.worktrees/phase-r1-p1.3`
**契约**: docs/modules/split-contracts.md §2.6（loadConfig 校验逐字节；TelegramConfig 自 ../types import、SERVICE 自 ../version import）
**任务**:

- [ ] loadConfig（自 3490-3537）+ isMissingFile（3539-3546）+ writeInitializationError（3547-3562）平移
- [ ] TelegramConfig/ProxySpec 类型从 types.ts re-export 或 import（**冻结：自 ../types import**；writeInitializationError 的 SERVICE 自 ../version import）

**验收标准**:
- [ ] 校验逻辑逐行等价（botToken/chatId/proxy 正则不变）
- [ ] bun build 语法自检通过

### Phase 1.4: src/registry/ ✅

**实现记录**: 完成。分支 `phase-r1-p1.4`，SHA `9e6b3c5`，worktree 已删。src/registry/index.ts 与原 3220-3488 区间除 import 头外逐行一致；原实现未引用 delay/isMissingFile/OTG_DIR，故未 import（与契约 §2.7 吻合）。

**目标**: 拆出项目注册表（类型 + 纯函数族 + Store 类）
**并行组**: 批次 A（可与 1.1、1.2、1.3、1.5–1.7 并发）
**触碰范围**: 仅新建 src/registry/（**冻结：单文件 src/registry/index.ts**）；不改任何现有文件
**分支**: `phase-r1-p1.4`　**worktree**: `.worktrees/phase-r1-p1.4`
**契约**: docs/modules/split-contracts.md §2.7（全部导出/import 清单；消费者 import 路径为 `../registry`）
**任务**:

- [ ] RegistryEntry/ProjectRegistry/EMPTY_REGISTRY（3220-3230）+ 纯函数族 normalizeRegistryPath/parseRegistry/serializeRegistry/findRegistryEntry/registerProject/entryToken/findEntryByToken/setProjectEnabled/deleteProjectByPath（3232-3349，JSDoc 随迁）+ ProjectRegistryStore（3351-3488）原样平移
- [ ] 出口决策已冻结：**全部集中在 src/registry/index.ts**，不拆多文件；无 src 内部依赖（仅 node:path/fs/crypto）

**验收标准**:
- [ ] 符号与行为逐行等价（缓存/serialized 队列/3 次重试/原子写/Windows fallback 不变）
- [ ] bun build 语法自检通过

### Phase 1.5: src/telegram/ ✅

**实现记录**: 完成。分支 `phase-r1-p1.5`，SHA `b74d935`，worktree 已删。逐函数行级等价 diff 全 OK；无 this 残留；2490-2494 注释逐字节保留。偏差：① `Socket` 类型改自 node:net（node:tls 不导出该类型，tsc 实证），tlsConnect 仍来自 node:tls；② requestViaProxy 局部变量 `proxy` 与新参数同名冲突，机械重命名为 `proxySpec`（两处）。

**目标**: 拆出 Telegram 协议类型 + API 传输层（retry/request/direct/proxy/tunnel/parseProxy + TelegramApiError）
**并行组**: 批次 A（可与 1.1–1.4、1.6–1.7 并发）
**触碰范围**: 仅新建 src/telegram/（api-error.ts、types.ts 转口、client.ts、index.ts barrel，**契约冻结**）；不改任何现有文件
**分支**: `phase-r1-p1.5`　**worktree**: `.worktrees/phase-r1-p1.5`
**契约**: docs/modules/split-contracts.md §2.9（四文件导出清单）+ §3（参数化替换表；requestViaProxy TLS socket 逐字节保留）
**任务**:

- [ ] TelegramApiError（441-450）+ parseProxy（2610-2624）平移
- [ ] telegramWithRetry/telegramRequest/requestDirect/requestViaProxy/openTunnel（2364-2609/2625-2709）平移为模块级函数，**机械参数化**：`TransportContext = { config, signal }`、退避 `delay`（自 ../infra/delay）、**requestViaProxy 的 TLS socket 实现逐字节保留（勿改写为 http.request over CONNECT，见 2490-2494 注释）**
- [ ] 日志调用方式与原实现一致（**已核实：全部走 dline**，monitor.ts:2458/2466/2488/2510/2519/2527/2549/2583，保持不变）

**验收标准**:
- [ ] 传输函数与原方法体逐行等价（仅 this→参数替换）
- [ ] parseProxy 输出 ProxySpec 结构不变
- [ ] bun build 语法自检通过

### Phase 1.6: src/format/ ✅

**实现记录**: 完成。分支 `phase-r1-p1.6`，SHA `58774cf`，worktree 已删。5 文件 830 行，全部函数字符串/模板字面量与原段逐字节一致；自引用解耦两处（契约要求）。备注：redact.ts 保留文件私有 record/string/number 助手（避免 coerce↔redact 环）；format.ts 实际未用 coerce 导出故未 import。

**目标**: 拆出全部格式化/脱敏纯函数与 ICON 常量（本轮最大纯函数集）
**并行组**: 批次 A（可与 1.1–1.5、1.7 并发）
**触碰范围**: 仅新建 src/format/（**冻结：coerce.ts、redact.ts、html.ts、format.ts + index.ts barrel；不建 icons.ts——ICON_* 15 个归 constants.ts，iconFor* 在 format.ts**）；不改任何现有文件
**分支**: `phase-r1-p1.6`　**worktree**: `.worktrees/phase-r1-p1.6`
**契约**: docs/modules/split-contracts.md §2.8（每个函数参数签名冻结；RedactionContext/FormatContext 定义；coerce 族指派决策）
**任务**:

- [ ] A 档方法平移为模块级函数（record/string/number/rememberBounded/formatNumber/formatCost/formatDuration/shortID/matchesSessionID/limitMessage/todoCounts/todoSummary/totalTokens/emptyTokens/escapeHtml/fieldTable/fieldRow/paragraph/titleLine/iconForOutcome/iconForState/iconForWaitingType/displayState/buildMenuKeyboard/parseProxy 归 telegram 不在此）——**含 coerce.ts 族（record/string/number/rememberBounded）与指派进 format 的 status/summarizeError/errorCategory**
- [ ] B 档方法参数化：safeText/safePath/safeToolTarget/safeProgress（redaction ctx：`RedactionContext = {root, botToken}`）、sessionLabel/sessionTitle/errorCategory、aggregateTokens/childSessions（sessions+sessionInfo 两 Map 作参，**冻结签名为 childSessions(parentID, sessions, sessionInfo)**）、menuText/helpText/formatStatus/formatTerminalNotification/formatTodos/formatUsage（**FormatContext = RedactionContext & {projectLabel, sessions, sessionInfo}**）
- [ ] 签名类型自引用解耦（ReturnType<TelegramSessionMonitor[...]> → TodoCounts/SessionDisplayState/TokensSummary，见 split-contracts.md §2.3）
- [ ] 方法体逐行平移，仅签名与 this 引用替换；输出字符串格式逐字节不变

**验收标准**:
- [ ] 每个函数与原方法体逐行等价（this 替换除外）
- [ ] 脱敏行为不变（safeText 对 botToken/root 的打码逻辑原样）
- [ ] bun build 语法自检通过

### Phase 1.7: tests/behavior.test.mjs 行为验证脚本 ✅

**实现记录**: 完成。分支 `phase-r1-p1.7`，SHA `45b03a5`，worktree 已删。219 行，dynamic import（保持同路径/同导出名，--dry 兼容）；隔离 HOME；进程显式 exit（bootstrap 遗留 8s timer）。**发现 API-002 文本断言与代码现状冲突**（`[WAITING]` 字面不存在，实际为 ⚠️+permission 表格）——已在「最终验证测试任务」中实证修正为断言真实行为。fake client 按运行需要补最小 stub（session.list/status/get）。

**目标**: 固化 AGENTS.md 描述的行为验证为可重复脚本（stub enqueueMessage 喂事件断言）
**并行组**: 批次 A（可与 1.1–1.6 并发）
**触碰范围**: 仅新建 tests/behavior.test.mjs（及如需的 helper）；不改任何现有文件
**分支**: `phase-r1-p1.7`　**worktree**: `.worktrees/phase-r1-p1.7`
**契约**: docs/modules/split-contracts.md §2.12（导入/构造/打桩/运行/--dry 全部冻结）
**任务**:

- [ ] 按 docs/modules 冻结的契约：`import { TelegramSessionMonitor } from "../src/monitor.ts"`（命名导出），构造签名 (client, config, root, registry)，stub 实例 enqueueMessage/enqueueMessageWithKeyboard 收集通知
- [ ] 断言用例（对应 API-001/002/003）：auto-approve→0 条；仅 permission.asked 等 2.5s→1 条含 [WAITING] 与 "Permission"；question.asked→立即 1 条
- [ ] fake client 满足主类 initialize 所需最小面（`{app:{log:async()=>{}}}`；构造后覆写 runTelegram/scheduleRegistration/scheduleSelfUpdate 为 no-op 避免真实网络）；不使用真实 botToken/chatId；registry 用真实 ProjectRegistryStore 指向临时目录
- [ ] 可运行：`HOME=$(mktemp -d) bun tests/behavior.test.mjs`（隔离真实 ~/.otg）；`--dry` 模式在 src/monitor.ts 未合并时打印说明 exit 0，合并后完成 import+导出断言

**验收标准**:
- [ ] 三条断言齐全且测试编号写入用例名
- [ ] 脚本自身 `bun tests/behavior.test.mjs --dry` 语法可载入（完整运行在合并后整体测试执行）

### Phase 1.8: 主类迁移与入口重建（rewiring）✅

**实现记录**: 完成。分支 `phase-r1-p1.8`，SHA `33a35d9`，worktree 已删。src/monitor.ts（1836 行）+ src/index.ts（61 行）；根 monitor.ts 已 git rm（+1897/−3611）。**bundle 实机结论**：bun 把 `export const PLUGIN_VERSION` 重写为 `var`（不 minify 也如此，双 worker 独立实测一致）→ self-update 按契约 §4.3 兜底改为读 staging/current 包 package.json 的 version 字段（staged 与 post-swap 两处，错误消息与失败路径逐字保留）。死导入 httpRequest 一并移除。行为测试（1.8 分支内）：API-001/003 ✅，API-002 因测试文件断言陈旧 ✗（已由 1.10 修复）。

**目标**: src/monitor.ts 主类（引用全部新模块，删除已迁出成员）+ src/index.ts 入口；根 monitor.ts 退出 git
**并行组**: 批次 B（依赖批次 A 全部合并；与 1.9 并发——文件不相交）
**触碰范围**: 新建 src/monitor.ts、src/index.ts；git rm 根 monitor.ts；不改 scripts/package.json/workflow/README/.gitignore（归 1.9）
**分支**: `phase-r1-p1.8`　**worktree**: `.worktrees/phase-r1-p1.8`
**契约**: docs/modules/split-contracts.md §2.10（保留成员清单与删除/import 映射）、§2.11（index.ts）、§3（传输层调用）、§4（self-update 校验）
**任务**:

- [ ] src/monitor.ts：TelegramSessionMonitor 主类原样平移（452-3218），删除已迁出的 4 个独立类/顶层函数/纯方法，改为 import；类内 this.xxx() 调用改为模块函数调用（childSessions 等改传 Map 参数）；命名导出 class（供 tests 契约）
- [ ] self-update 校验（578-660）按调研结论适配：优先保留 `const PLUGIN_VERSION = "..."` 字面量断言（bundle 不 minify 应保留，测试阶段实机验证）；若实机不成立则改读 staging 包 package.json version（兜底方案，契约允许并需回写）
- [ ] src/index.ts：入口（3564-3611）平移 + `export { TelegramSessionMonitor }`（测试契约）
- [ ] `git rm --cached monitor.ts`（根 monitor.ts 删除；gitignore 条目由 1.9 加）
- [ ] 手工 bundle 验证：`bun build --target node --external "@opencode-ai/plugin" --external "@opencode-ai/sdk" src/index.ts` exit 0，产物含 `const PLUGIN_VERSION = "0.5.3"` 字面量（记录实机结论，供 self-update 决策）

**验收标准**:
- [ ] src/monitor.ts + src/index.ts 编译通过（bundle exit 0）
- [ ] bundle 产物含 PLUGIN_VERSION 字面量（或已按兜底改 self-update 并记录）
- [ ] 主类保留成员清单与计划边界一致（handleEvent/投影/命令/轮询/发送队列/自更新在类内）

### Phase 1.9: 构建脚本与发布链路联动 ✅

**实现记录**: 完成。分支 `phase-r1-p1.9`，SHA `bb0afd2`，worktree 已删。scripts/build.mjs 新建（bundle + 版本硬门：产物含 `PLUGIN_VERSION = "<pkg.version>"` 即过，const 字面量缺失仅 WARNING 不阻断）；check-version/set-version 改读 src/version.ts（实测 v0.5.3 exit 0 / v9.9.9 exit 1）；publish.yml 步骤序 Verify → Build → Publish；.gitignore 加 `/monitor.ts`；README 安装章节与版本来源表已更新。build.mjs 用相对路径（本机 bun 为 WSL interop Windows 二进制，绝对 Linux 路径 BadPathName）。

**目标**: bundle 构建 + scripts/workflow/package.json/README/.gitignore 全部指向新结构
**并行组**: 批次 B（依赖 1.1 的 version.ts 契约冻结；与 1.8 并发——文件不相交）
**触碰范围**: 新建 scripts/build.mjs；修改 package.json、.github/workflows/publish.yml、scripts/check-version.mjs、scripts/set-version.mjs、README.md、.gitignore；不改 src/**、不碰根 monitor.ts
**分支**: `phase-r1-p1.9`　**worktree**: `.worktrees/phase-r1-p1.9`
**契约**: docs/modules/split-contracts.md §4（self-update 校验链 + build.mjs 断言）、§7（scripts/workflow/package.json/README/.gitignore 逐点改法）
**任务**:

- [ ] scripts/build.mjs：bun build bundle src/index.ts → 根 monitor.ts（不 minify，external @opencode-ai/*），构建后断言产物含 `const PLUGIN_VERSION = "0.5.3"` 形态字面量（self-update 兼容），失败即 exit 非 0
- [ ] package.json：check/prepublishOnly 改为 `node scripts/build.mjs`；main/types/files 保持 monitor.ts（CI 现场构建）
- [ ] publish.yml：publish 前加 build 步骤；bun build 冒烟改对 src/index.ts 或经 build.mjs
- [ ] check-version.mjs / set-version.mjs：monitor.ts 路径 → src/version.ts（正则不变，`export const` 兼容已确认）
- [ ] .gitignore：加 `/monitor.ts`（构建产物）
- [ ] README.md：本地安装章节改「先 node scripts/build.mjs 构建再复制产物」；版本来源声明改 src/version.ts；npm 安装说明不变

**验收标准**:
- [ ] `node scripts/check-version.mjs v0.5.3` exit 0、`v9.9.9` exit 非 0（本地以 src/version.ts 实测）
- [ ] `node scripts/build.mjs` 产出根 monitor.ts 且断言通过（若 src/monitor.ts 尚未合并，本 phase 内允许以临时 stub index 验证脚本逻辑，整体测试再全链验证）
- [ ] publish.yml 语法有效（yaml 解析通过）

### Phase 1.10: 测试断言实证修正 + README 残留行 ✅

**实现记录**: 完成。分支 `phase-r1-p1.10`，SHA `3f26007`（tests）+ `fe20d2b`（README），worktree 已删。API-002 断言改为真实输出特征（⚠️ 图标 + 小写 permission Type 行 + Session/Request 字段），1.8 分支物化实证 3/3 通过；README 三处发布流程过期表述更新（staging 校验表述/set-version 注释/git add 路径）。

### Round 1 整体测试记录

- 测试结论：【通过】（2026-09-02，design-driven-test 真实执行）
- 执行记录：
  - API-001/002/003：`HOME=$(mktemp -d) bun tests/behavior.test.mjs` → 3/3 通过（exit 0）；`--dry` 载入通过
  - API-004：`node scripts/build.mjs` → exit 0，bundle 18 模块 94.19 KB，产物 L49 `var PLUGIN_VERSION = "0.5.3";`；git status 干净（`/monitor.ts` gitignore:11 生效）
  - API-005：check-version v0.5.3 exit 0 / v9.9.9 exit 1（三处 mismatch 明细）
  - API-006：`bun tests/e2e/bundle-smoke.test.mjs`（本轮新建回归资产）→ 3/3 通过（import OK / default 函数 / 命名导出存在）
  - 附带核验：publish.yml 步骤序 Verify → Build → Publish ✅；package.json check/prepublishOnly → scripts/build.mjs ✅
- 失败摘要与根因归属：无失败用例
- 残余风险：self-update 端到端（staged tarball 校验链）未在本轮验证（无真实 npm 发布演练），兜底逻辑（读包内 package.json version）属计划内并经代码落地；建议后续发布演练覆盖

## 断点记录（运输层错误续传用）

- （无）

## 交付总结

- **轮次**：仅 Round 1，整体测试一次通过（API-001…006 共 6 条外部面 + 行为套件 3/3）
- **结构**：单文件 monitor.ts（3611 行）→ src/ 10 个模块文件 + tests/ 2 个回归资产 + scripts/build.mjs；主类 TelegramSessionMonitor 保留于 src/monitor.ts（强耦合逻辑不拆）；根 monitor.ts 转为 gitignored 构建产物
- **合并链**：批次 A（p1.1–p1.7，e6a7f18…c9e203f）→ 批次 B（p1.8 988e05d / p1.9 a23db42 / 补丁 p1.10 dc01f03）→ 文档 0748188
- **关键实证决策**：① bun bundle 将 `export const` 重写为 `var`（双 worker 独立实测一致）→ self-update 校验走契约兜底（读 staging 包 package.json version）；② notifyWaiting 实际输出无 `[WAITING]` 字面（AGENTS.md/测试断言过时）→ API-002 断言实证修正为 ⚠️+permission 真实特征，行为零变化
- **外部机制零变化**：npm 发布（files 白名单 + CI 现场构建）、本地复制安装（先 build.mjs）、check-version/set-version（改读 src/version.ts）、~/.otg 数据格式、PLUGIN_VERSION=0.5.3 不变、不发版
