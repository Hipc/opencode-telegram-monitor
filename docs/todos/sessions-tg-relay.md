# sessions 落盘 + TG 中继（permission/question 状态经 projects.json 发送）

> 状态: planning
> 创建: 2026-09-02
> 当前轮次: Round 1
> 关联文档: docs/modules/projects-registry.md（registry 锁契约，须兼容）、docs/modules/sessions-relay.md
> （本轮冻结契约，唯一权威）、docs/00-overview.md

## 背景

现状：permission/question 等待通知由 monitor 在事件回调里**直接发送** Telegram
（`notifyWaiting` → `enqueueMessage` → `sendMessage`，permission 有 1s 去抖防 auto-approve 刷屏）。

目标：把等待状态**落盘**到 `~/.otg/projects.json` 中对应项目条目下的 `sessions` 数组，
由持有 `poller.lock` 的主进程**每秒扫描**该文件，把未发送记录推送到 Telegram，发送后置 `send=true`。
记录的 `resolved` 由 opencode 回复事件驱动置 true（TUI 或未来任何途径授权都会发出 replied 事件）。

**旧直发机制保留源码但停用调用**（后续可能复用）。

## 已确认的关键决策（用户 grilling 确认，2026-09-02）

1. 记录字段：`session_id` / `session_name` / `type`("question"|"permission") / `message` / `send` / `resolved`
   + 内部匹配键 `request_id` + 清理预留 `created_at`。
2. `message` = 完整事件 payload 的 **JSON 字符串**（permission 存完整 permission 调用内容；
   question 存完整工具调用内容）。
3. 多个 permission 同时触发 → **追加**写入，不删除已有记录；去重沿用 `seenWaitingRequestIDs`。
4. permission 写入走 **1s 去抖**（复用 `WAITING_NOTIFY_DEBOUNCE_MS` 定时机制）：窗口内收到
   replied（auto-approve）→ 取消，**完全不写入**；question 立即写入不去抖。
5. `resolved=true`：`permission.replied` / `question.replied/rejected`（含 v2 变体）按
   `request_id` 匹配回写；记录未写入（仍在去抖窗口）→ 取消写入。
6. **resolved 即终态**：poller 发送条件为 `send === false && resolved === false`；
   `resolved=true` 的记录即使 `send=false` 也不补发，`send` 保持 false 不动。
7. `session_name`：复用 `ensureSessionInfo()` 异步拉取，拉不到**兜底用 sessionID**；不阻塞写入。
8. 每秒扫描**仅由 poller.lock 持有者**执行；发送失败保留 `send=false` 下轮重试；
   置 `send=true`/`resolved=true` 走 `registry.mutate()`（拿 `projects.json.lock`，锁契约见
   docs/modules/projects-registry.md §4，超时返回 undefined 不抛错）。
9. TG 发送格式复用现有等待通知格式（⚠️/❓ 标题 + Type/Session 字段表），超长经 `limitMessage` 截断。
10. 旧机制 `notifyWaiting` 及其直发调用**保留源码、停用调用**；`scheduleWaitingNotify`/
    `cancelWaitingNotify` 的去抖定时机制迁移复用于新写入端。
11. 旧测试 API-001/002/003 **改写为新语义**。
12. ⚠️ 必须同步改 `parseRegistry`/`serializeRegistry`（严格白名单解析，否则 sessions 被静默丢弃）。
13. 本轮不做 sessions 清理（`created_at` 为后续清理预留）。

## 涉及范围

- **新增**:
  - `tests/registry-sessions.test.mjs`（registry sessions 往返/追加/resolved 标记）
  - `tests/sessions-poller.test.mjs`（poller 扫描发送语义）
- **修改**:
  - `src/registry/index.ts`（SessionRecord 类型、RegistryEntry.sessions、parse/serialize、记录操作纯函数）
  - `src/monitor.ts`（写入路径 addWaiting 区 + poller runTelegram 区——两个独立区域）
  - `src/constants.ts`（新增扫描间隔常量）
  - `src/format/format.ts` 或 monitor.ts poller 区（TG 消息组装，复用现有 html/format 函数）
  - `tests/behavior.test.mjs`（API-001/002/003 改写为新语义 + resolved 用例）
- **依赖**: docs/modules/projects-registry.md 冻结的 mutate 锁语义（只消费不修改）；
  `PollerLock`（poller.lock / projects.json.lock 两把独立锁，互不相干）。

## 上下文（探索结论）

- registry 读写：`src/registry/index.ts` — `RegistryEntry`（14-18 行，无 sessions）、
  `parseRegistry`（31-61，**严格白名单**，未列字段被丢弃）、`serializeRegistry`（63-65）、
  `ProjectRegistryStore.mutate`（220-279，进程内 `serialized()` 队列 + `PollerLock`
  `<filePath>.lock`，抢锁 3s deadline，超时返回 undefined 不抛错；锁内重读→fn→writeAtomic→刷缓存）。
- 锁：`src/infra/poller-lock.ts` — O_EXCL + LockInfo JSON + 崩溃回收 + 同 ownerId 可重入；
  `poller.lock`（TG 轮询互斥，monitor.ts:130-133）与 `projects.json.lock`（registry mutate）
  是**两把独立锁**。
- 事件路径：`src/monitor.ts` `handleEvent`（536-828）— permission.asked/v2（659-675）、
  permission.updated（678-690）、question.asked/v2（705-728）→ `addWaiting`（855-873）：
  permission → `scheduleWaitingNotify()`（875-886，1s setTimeout，timer 表
  `waitingNotifyTimers: Map<requestID, Timer>` 117-120）；question → 立即 `notifyWaiting`（869-872）。
  `cancelWaitingNotify`（888-895）被 replied（699/737）、session.deleted（563）、dispose（412-415）调用。
- 旧直发链：`notifyWaiting`（897-920）→ `enqueueMessage`（1717-1722，sendTail 串行）→
  `sendMessage`（1736-1742）→ `telegramWithRetry("sendRichMessage")`（src/telegram/client.ts:18-48）。
  enqueueMessage/sendMessage 仍被 /menu、/help、terminal 通知等使用，**不能停用**——
  只停用 waiting 通知的调用点。
- poller：`runTelegram`（1286-1381）— tryAcquire poller.lock，失败 20s 后重试；持锁后
  getUpdates 长轮询（25s/35s timeout），成功 `pollerLock.touch()` 续期。**无每秒扫描循环，需新增**。
- session 名称：事件只有 sessionID；`ensureSessionInfo`（1163-1189）→ `client.session.get`
  异步拉取缓存；`sessionTitle`（format.ts:168-173）。
- 格式化：`src/format/html.ts`（titleLine/fieldTable/fieldRow/escapeHtml）、
  `src/format/format.ts`（sessionLabel/sessionTitle/iconForWaitingType/limitMessage）、
  `src/format/redact.ts`（safeText，日志脱敏必用）。
- 项目根路径：monitor 内已有当前 project root（自注册 mutate(registerProject(reg, root))，
  monitor.ts:458），写入 sessions 时按 `path === root` 定位条目。
- 测试基建：tests/*.test.mjs 用 bun 跑、无框架、隔离 HOME（mktemp）；测试需要类时直接
  import `src/monitor.ts`（不要从插件入口 re-export，bundle 冒烟约束）。

## 最终验证测试任务

> 累计维护。本项目对外面 = projects.json 文件行为 + TG 发送行为（经 stub 验证）+ bundle 产物。
> **测试编号归属（契约，冻结）**：API-001~005 → `tests/behavior.test.mjs`（Phase 1.2 改写/新增，
> 1.2 执行 `HOME=$(mktemp -d) bun tests/behavior.test.mjs`）；API-006 → `tests/sessions-poller.test.mjs`
> （Phase 1.3 新建）；REG-101 → `tests/registry-sessions.test.mjs`（Phase 1.1 新建）；
> LOCK-001~005 → `tests/registry-concurrency.test.mjs`（既有，无人触碰，Phase 1.1 验收回归）；
> BUILD-001/002 → 各 phase 各自验收 + 终验（build.mjs / bundle-smoke.test.mjs）。详见
> docs/modules/sessions-relay.md §8。

### 外部接口测试

- [API-001] auto-approve 回归：`permission.asked` 后 1s 内 `permission.replied` → projects.json
  **0 条**新 session 记录（去抖取消写入）。来源：决策 #4 + 旧 API-001 语义迁移。
- [API-002] 真待审批：只有 `permission.asked`，等 2.5s → 恰 1 条记录：
  type=permission、message=完整 payload JSON、send=false、resolved=false、request_id/created_at/session_name 存在。
  来源：决策 #1/#2/#4。
- [API-003] question：`question.asked` → **立即** 1 条记录（不去抖），message=完整工具调用内容 JSON。
  来源：决策 #2/#4。
- [API-004] resolved 回写：记录写入后收到 `permission.replied`/`question.replied`（含 v2/rejected 变体）
  → 按 request_id 匹配置 resolved=true；poller 扫描跳过 resolved 记录（send 保持 false 不补发）。
  来源：决策 #5/#6。
- [API-005] 并发多 permission：短时间内多个 permission.asked（不同 request_id）→ 全部追加保留，
  互不覆盖。来源：决策 #3。
- [API-006] poller 扫描发送：registry 中存在 send=false && resolved=false 记录 → 持 poller.lock 的
  ticker 每秒扫描、经 TG 发送（stub 验证格式含 ⚠️/❓ 标题与 Session 字段）→ 成功后 send=true；
  发送失败 → send 保持 false 下轮重试。来源：决策 #8/#9。
- [REG-001~005] registry 锁回归：LOCK-001~005 全绿（docs/modules/projects-registry.md §6）。
- [REG-101] sessions 往返：parseRegistry/serializeRegistry 保留 sessions 字段（白名单内字段，
  损坏条目丢弃不抛错）；appendSessionRecord 追加不覆盖；markSessionResolved/markSessionSent 按
  request_id 精确匹配。来源：决策 #1/#12。
- [BUILD-001] `node scripts/build.mjs` exit 0，产物根目录 monitor.ts。
- [BUILD-002] `bun tests/e2e/bundle-smoke.test.mjs`：default 为函数 + 除 default 外无其它函数/类导出。

### 界面（UI）测试

- 无（本项目无 UI；Telegram 侧表现由 API-006 的 stub 断言覆盖）。

### 本轮回归重点（修复轮次填写）

- （Round 1 首轮，暂无）

## Round 1

### Phase 1.1: registry sessions 存储层 ⬜

**契约**: docs/modules/sessions-relay.md §2~§4（SessionRecord 类型、RegistryEntry.sessions、
parse/serialize 容错、append/mark 纯函数签名与语义——全部冻结，照此实现）
**目标**: `projects.json` 具备承载 sessions 记录的能力——类型、白名单解析/序列化、
追加/标记纯函数，配套单元测试。
**并行组**: 批次 A（先行，1.2/1.3 依赖其产物）
**触碰范围**: `src/registry/index.ts`（类型区 13-22、parseRegistry 31-61、serializeRegistry 63-65、
纯函数区新增 helper）；新建 `tests/registry-sessions.test.mjs`。**不改** mutate/锁逻辑
（docs/modules/projects-registry.md §2.1 纯函数区契约由本轮扩展，§3/§4 锁语义零触碰）。
**分支**: `phase-r1-p1.1`　**worktree**: `.worktrees/phase-r1-p1.1`
**任务**:

- [ ] 新增 `SessionRecord` 类型：`{ session_id: string; session_name: string; type: "question" | "permission"; message: string; send: boolean; resolved: boolean; request_id: string; created_at: string }`（created_at 用 ISO 字符串；类型定义放 src/registry/index.ts）
- [ ] `RegistryEntry` 增加可选 `sessions?: SessionRecord[]`
- [ ] `parseRegistry`：白名单扩展——保留并校验 sessions（非数组/条目缺关键字段 → 丢弃该条目或该记录，不抛错）；`serializeRegistry` 同步输出
- [ ] 新增纯函数：`appendSessionRecord(reg, projectPath, record)`（按 path 定位条目追加；条目不存在返回原 reg）；`markSessionRecordsByRequest(reg, requestID, patch)` 或等价的 `markSessionResolved` / `markSessionSent`（按 request_id 匹配，无匹配返回 undefined 以跳过写盘）
- [ ] 单元测试 `tests/registry-sessions.test.mjs`（REG-101：往返保留、追加不覆盖、按 request_id 标记、损坏 sessions 容错）

**验收标准**:

- [ ] REG-101 全绿；既有 `bun tests/registry-concurrency.test.mjs`（LOCK-001~005）回归通过
- [ ] parseRegistry 对含 sessions 的文件往返后字段逐项一致（含 created_at/request_id）
- [ ] 不触碰 mutate/锁代码（LOCK 回归证明）

### Phase 1.2: monitor 写入路径（去抖写盘 + resolved 回写 + 停用旧直发） ⬜

**契约**: docs/modules/sessions-relay.md §5（事件→记录映射、去抖写盘、resolved 回写、旧直发停用）+
§7 编辑区间（658-741、855-920 独占）+ §8 测试归属（API-001~005）
**目标**: permission/question 事件把等待记录写入 projects.json（permission 走 1s 去抖、
question 立即）；回复事件按 request_id 置 resolved；旧直发调用点停用（源码保留）。
**并行组**: 批次 B（依赖 Phase 1.1 合并；与 1.3 同批并发——同文件不同区域）
**触碰范围**: `src/monitor.ts`（**addWaiting/scheduleWaitingNotify/cancelWaitingNotify 区
855-895 + handleEvent 的 replied 分支 699/737 + question 立即发送分支 869-872**；**不得触碰**
runTelegram 1286-1381 与 sendMessage/enqueueMessage 区 1717+）；`tests/behavior.test.mjs` 全量改写。
**分支**: `phase-r1-p1.2`　**worktree**: `.worktrees/phase-r1-p1.2`
**任务**:

- [ ] `addWaiting` permission 分支：不再调旧通知，改为 1s 去抖后 `registry.mutate(appendSessionRecord(...))`——record 字段按决策 #1/#2（message=JSON.stringify(完整事件 properties)；session_name 经 `ensureSessionInfo` 拉取、失败兜底 sessionID；send=false、resolved=false、created_at=ISO now）；沿用 `waitingNotifyTimers` 定时表与 `WAITING_NOTIFY_DEBOUNCE_MS`
- [ ] `addWaiting` question 分支：立即 mutate 追加（不去抖）；停用旧 `notifyWaiting` 调用
- [ ] `cancelWaitingNotify` 语义扩展：窗口内收到 replied → clearTimeout（= 取消写入，auto-approve 零落盘）
- [ ] replied 事件（permission.replied/v2.updated、question.replied/rejected/v2）：窗口外已写入的记录 → `registry.mutate(markSessionResolved(request_id))`；mutate 返回 undefined（超时）时静默容忍并 logWarn
- [ ] 写入定位：按当前项目 root 的 registry 条目（`path === root`）追加；未注册项目时跳过写盘并 logWarn
- [ ] 旧 `notifyWaiting` 函数体保留不删；仅移除其调用点（queue 一律不删——其余调用方不受影响）
- [ ] 改写 `tests/behavior.test.mjs`：API-001（auto-approve → 0 条写入）、API-002（真待审批 2.5s → 恰 1 条且字段完整）、API-003（question 立即 1 条）、新增 API-004（replied → resolved=true + 去抖取消写入两分支）、API-005（并发多 permission 全保留）

**验收标准**:

- [ ] API-001~005 全绿（`HOME=$(mktemp -d) bun tests/behavior.test.mjs`）
- [ ] `node scripts/build.mjs` exit 0（bundle 冒烟，monitor.ts 无类型/导入错误）
- [ ] 旧直发函数源码仍在（grep notifyWaiting 有定义），waiting 通知无调用点

### Phase 1.3: poller 每秒扫描发送 ⬜

**契约**: docs/modules/sessions-relay.md §6（SESSIONS_SCAN_INTERVAL_MS、扫描条件、
sendMessage 复用与可测试入口、ticker 生命周期）+ §7 编辑区间（1286-1383 独占）+
§8 测试归属（API-006）；**constants.ts 只允许本 phase 触碰**
**目标**: 持有 poller.lock 的进程每秒扫描 projects.json，把 send=false && resolved=false 的
session 记录发到 Telegram，成功后置 send=true；失败保留重试。
**并行组**: 批次 B（依赖 Phase 1.1 合并；与 1.2 同批并发——同文件不同区域）
**触碰范围**: `src/monitor.ts`（**runTelegram 区 1286-1381 及其邻近新增私有方法/TG 消息组装
函数**；**不得触碰** addWaiting 区 855-895 与 handleEvent replied 分支）；`src/constants.ts`
（新增 `SESSIONS_SCAN_INTERVAL_MS = 1_000`）；新建 `tests/sessions-poller.test.mjs`。
**分支**: `phase-r1-p1.3`　**worktree**: `.worktrees/phase-r1-p1.3`
**任务**:

- [ ] `src/constants.ts` 增加 `SESSIONS_SCAN_INTERVAL_MS = 1_000`
- [ ] runTelegram 持锁成功后启动 1s `setInterval` 扫描 ticker；释放锁/退出路径 clearInterval
- [ ] 扫描逻辑：`registry.read()`（不加锁读）→ 遍历 projects[].sessions，筛选 `send === false && resolved === false` → 逐条经现有发送链（`enqueueMessage`/`telegramWithRetry("sendRichMessage")`）发送；格式复用等待通知样式（iconForWaitingType ⚠️/❓ + titleLine + fieldTable：Type/Session 字段 + message 节选，`limitMessage` 截断）
- [ ] 发送成功 → `registry.mutate(markSessionSent(request_id))`（send=true）；发送失败 → 不置位、logWarn，下轮 ticker 重试；mutate 超时 undefined 静默容忍
- [ ] resolved=true 或 send=true 的记录一律跳过（决策 #6：resolved 即终态，不补发）
- [ ] 新建 `tests/sessions-poller.test.mjs`（API-006：stub 发送函数断言发送次数/格式、send 置位、失败重试、resolved 跳过）

**验收标准**:

- [ ] API-006 全绿
- [ ] ticker 生命周期正确：锁释放后无残留 interval（测试或代码审查可证）
- [ ] `node scripts/build.mjs` exit 0

### Round 1 整体测试记录

- 测试结论：【通过】/【不通过】（待填）
- 失败摘要与根因归属：（待填）

## 断点记录（运输层错误续传用）

- （暂无）

## 交付总结

- （待填）
