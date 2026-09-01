# projects.json 写入加跨进程锁

> 状态: planning
> 创建: 2026-09-02
> 当前轮次: Round 1
> 关联文档: docs/modules/projects-registry.md（本轮冻结）、docs/todos/shared-file-store.md（PollerLock/SharedFileStore 背景）

## 背景

多个 opencode 窗口（多进程）同时运行时，`~/.otg/projects.json` 的写入目前只有
「进程内 promise 队列 + statKey CAS 重试×3 + tmp+rename 原子写」，**没有跨进程锁**。
CAS 存在 TOCTOU 窗口（afterKey 统计与 rename 之间、或两进程同读同一 beforeKey 后
先后落盘），会发生 last-writer-wins 丢失更新。要求：写入必须持锁互斥，读取不受影响。

已与用户确认的决策（2026-09-02 grilling）：

- **载体**：`ProjectRegistryStore` 内嵌一把 `PollerLock`（锁文件 `projects.json.lock`），
  复用已生产验证的 `src/infra/poller-lock.ts`，**不修改 PollerLock 本身**。
- **超时**：抢锁限时 3s（50ms 间隔重试），超时返回 `undefined` 不抛错——插件绝不卡 opencode；
  callback（`monitor.ts:1631/1645`）与自注册（`monitor.ts:458-463`）调用点已兼容 `undefined`。
- **CAS 移除**：删除 mutate 里 statKey 前后对比×3 的乐观重试循环（锁内重读已保证互斥与最新性）；
  保留损坏文件 `.bak` 备份与「幂等无变化不写盘」逻辑。
- **读取不动**：`read()/isEnabled()` 不加锁不等待，维持 statKey 缓存行为（最终一致）。

## 涉及范围

- **修改**: `src/registry/index.ts`（`mutate`/`writeAtomic` 区域；`ProjectRegistryStore` 构造函数持锁）
- **新增**: `tests/registry-concurrency.test.mjs`（并发行为测试，隔离 HOME，不碰真实 `~/.otg/`）
- **不动**: `src/monitor.ts`、`src/index.ts`（调用点接口零变化）、`src/infra/poller-lock.ts`、
  `src/infra/shared-file-store.ts`（维持未接线）、`telegram.json` 等其他文件

## 上下文（探索结论）

- `ProjectRegistryStore`（`src/registry/index.ts:144-281`）：
  - `serialized()`（146,153-157）：进程内 promise 队列——**必须保留**，`PollerLock` 对同一
    `ownerId` 重入（同进程二次 tryAcquire 会把已有锁当自己的），无队列则同实例并发 mutate
    会同时进临界区（见 docs/todos/shared-file-store.md:78-83 的同类结论）。
  - `mutate()`（209-259）：现 = CAS×3 + 损坏备份（231-240）+ 幂等无变化跳写（243-246）+ writeAtomic。
  - `writeAtomic()`（261-280）：tmp+rename，含 Windows EPERM 的 rm+rename / copyFile 兜底——**保留不动**。
  - `read()`（180-202）：statKey 缓存，独立于写入路径——**不动**。
- `PollerLock`（`src/infra/poller-lock.ts`）：`open(lockPath,"wx")` 原子独占创建（73-82）、
  ownerId 重入（93-96）、stale 回收 = pidAlive + mtime TTL（59-71,97-104）、release 仅 ownerId
  匹配才删（122-133）、tryAcquire 自建目录（85）。默认 TTL = `DEFAULT_TTL_MS`（`src/constants.ts`）。
- 写入调用点（均无需改动，`undefined` 返回值已兼容）：
  `src/index.ts:43`（启动自注册）、`src/monitor.ts:458`（周期自注册）、
  `src/monitor.ts:1625/1641/1654`（Telegram 回调 set/del/register）。
- 测试基建：`tests/behavior.test.mjs` 用 `HOME=$(mktemp -d)` 隔离运行；e2e 在 `tests/e2e/`。
  构建冒烟：`node scripts/build.mjs`。
- 锁参数沿用 SharedFileStore 既有默认值：lockTtlMs=60_000（DEFAULT_TTL_MS）、acquireTimeoutMs=3_000、retryMs=50。

## 最终验证测试任务

> 累计维护；只含外部接口/行为测试，不含 phase 内单元测试。

### 外部接口测试

- [BUILD-001] `node scripts/build.mjs`：无入参；期望 exit 0 且产出根目录 `monitor.ts`；来源 AGENTS.md 验证清单
- [API-001] `HOME=$(mktemp -d) bun tests/behavior.test.mjs`（auto-approve 回归）：期望 0 条通知；来源 AGENTS.md / 现有断言
- [API-002] 同上（真待审批 2.5s）：期望恰 1 条含 ⚠️ 与小写 permission；来源 AGENTS.md / 现有断言
- [API-003] 同上（question 立即通知）：期望立即 1 条；来源 AGENTS.md / 现有断言
- [LOCK-001] `bun tests/registry-concurrency.test.mjs`（并发写无丢失更新）：多实例并发 mutate 计数递增，最终读回等于总次数；来源本轮验收标准 1
- [LOCK-002] 同上（读不被锁阻塞）：锁被占时 `read()` 立即返回；来源本轮验收标准 2
- [LOCK-003] 同上（抢锁超时）：持锁不释放时并发 mutate 在超时后返回 `undefined` 且不抛错；来源决策 2
- [LOCK-004] 同上（stale 锁回收）：预置死进程 pid 的 `.lock`，mutate 可越过并成功；来源 PollerLock 既有机制
- [LOCK-005] 同上（异常释放）：mutate 抛错后锁释放，后续 mutate 仍成功；来源本轮验收标准 5
- [E2E-001] `bun tests/e2e/bundle-smoke.test.mjs`：bundle 产物 default 为函数 + 命名导出存在；来源 AGENTS.md 验证清单

### 界面（UI）测试

（无——本轮为注册表存储层改动，无 UI 面）

### 本轮回归重点（修复轮次填写）

（待填）

## Round 1

### Phase 1.1: ProjectRegistryStore 写入加跨进程锁 + 并发行为测试 ⬜

**目标**: `mutate()` 改为「抢锁 → 锁内重读 → fn → 原子写 → finally 释放」，多进程并发写无丢失更新；新增并发行为测试固化。
**契约**: docs/modules/projects-registry.md（本轮冻结——mutate 新语义/锁行为/LOCK-001~005 的唯一权威描述）
**并行组**: 单 phase（批次 A，本轮唯一 phase）
**触碰范围**: `src/registry/index.ts`（ProjectRegistryStore 类：构造函数 + mutate + 相关 import；纯函数区 13-142 与 read/isEnabled/ensureDir 不动）；新增 `tests/registry-concurrency.test.mjs`。不与任何其他 phase 共享文件。
**分支**: `phase-r1-p1.1`　**worktree**: `.worktrees/phase-r1-p1.1`
**任务**:

- [ ] `ProjectRegistryStore` 增加私有 `lock` 字段：`new PollerLock(filePath + ".lock")`（import 自 `./infra/poller-lock` 或包内相对路径按现有模块布局）
- [ ] `mutate()` 重构：`serialized()` 队列内 → 循环抢锁（deadline 3s、50ms 间隔）→ 成功后锁内执行现有「读文件 → 解析 → 损坏备份 .bak → fn → 幂等无变化跳写 / writeAtomic → 刷缓存」→ `finally release()`
- [ ] 移除 CAS：删除 `beforeKey`/`afterKey` 对比与 ×3 重试循环（statKey 方法本身保留，read() 缓存仍在用）
- [ ] 抢锁超时（3s）返回 `undefined`，不抛错
- [ ] 新增 `tests/registry-concurrency.test.mjs`：LOCK-001 并发无丢失更新（≥10 个独立 store 实例并发 mutate 递增计数）；LOCK-002 锁被占时 read() 不阻塞；LOCK-003 超时返回 undefined；LOCK-004 stale 锁回收；LOCK-005 mutate 抛错后锁释放。隔离 HOME/临时目录，绝不触碰真实 `~/.otg/`
- [ ] 跑 `bun tests/registry-concurrency.test.mjs`、`HOME=$(mktemp -d) bun tests/behavior.test.mjs`、`node scripts/build.mjs` 全绿

**验收标准**:

- [ ] LOCK-001：并发 10 实例各 mutate 一次 push 唯一路径条目，最终读回恰 10 条，无丢失
- [ ] LOCK-002：持锁期间 `read()` 立即返回（<100ms 量级），内容为可解析注册表
- [ ] LOCK-003：锁被他人持有时 mutate 在约 3s 后返回 `undefined`，进程不崩
- [ ] LOCK-004：预置 pid=不存在进程 的 `projects.json.lock`，mutate 越过 stale 锁成功
- [ ] LOCK-005：mutate 回调抛错后，下一次 mutate 正常成功（锁未卡死）
- [ ] API-001/002/003 行为回归与 BUILD-001 构建冒烟全绿

**实现记录**: （合并后由 dev-lead 汇总回写）

### Round 1 整体测试记录

- 测试结论：【通过】/【不通过】（待填）
- 失败摘要与根因归属：（待填）

## 断点记录（运输层错误续传用）

（空）

## 交付总结

（待填）
