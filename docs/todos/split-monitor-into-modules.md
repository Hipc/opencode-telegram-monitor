# monitor.ts 单文件拆分为多模块

> 状态: in-progress
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
- [API-002] 行为脚本：真待审批（仅 permission.asked，等 2.5s）→ 1 条 [WAITING] 通知且含 "Permission"；来源 AGENTS.md 验证章节
- [API-003] 行为脚本：question.asked → 立即 1 条通知（不去抖）；来源 AGENTS.md 验证章节
- [API-004] 构建产物：`bun build`（bundle 模式）产出根目录 monitor.ts，exit 0，且产物中可匹配 `PLUGIN_VERSION` 与 "0.5.3" 字面量（self-update 校验可识别）；来源 验收标准
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

### Phase 1.1: src/version.ts + src/constants.ts + src/types.ts ✅|⬜

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

### Phase 1.2: src/diagnostics.ts + src/infra/ ✅|⬜

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

### Phase 1.3: src/config/ ✅|⬜

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

### Phase 1.4: src/registry/ ✅|⬜

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

### Phase 1.5: src/telegram/ ✅|⬜

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

### Phase 1.6: src/format/ ✅|⬜

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

### Phase 1.7: tests/behavior.test.mjs 行为验证脚本 ✅|⬜

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

### Phase 1.8: 主类迁移与入口重建（rewiring）✅|⬜

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

### Phase 1.9: 构建脚本与发布链路联动 ✅|⬜

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

### Round 1 整体测试记录

- 测试结论：【通过】/【不通过】（待填）
- 失败摘要与根因归属：（待填）

## 断点记录（运输层错误续传用）

- （无）

## 交付总结

- （待填）
