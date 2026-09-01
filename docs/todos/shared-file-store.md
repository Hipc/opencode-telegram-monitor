# SharedFileStore：跨窗口共享状态文件的读改写机制

> 状态: in-progress
> 创建: 2026-09-01
> 当前轮次: Round 1
> 关联文档: AGENTS.md（验证与提交规范）

## 背景

用户计划在 `~/.otg/` 增加一个 JSON 状态文件，供多个 opencode 窗口（多个进程）读写传递信息。
需要保证三件事：

1. **互斥**：同一时刻只有一个窗口在写（内核 `O_EXCL` 原子创建保证）；
2. **原子写**：读者永远读不到写了一半的内容（临时文件 + `rename` 原子替换）；
3. **无丢失更新**：拿锁后重新读最新内容再改（不用锁外旧缓存）。

已与用户确认的决策：

- 复用现有 `PollerLock`（`O_EXCL` 原子创建 + `pidAlive`/TTL 崩溃回收 + `ownerId` 防误删），
  **不修改** `PollerLock` 本身——它是已在生产验证过的代码。
- 新增泛型 `SharedFileStore<T>`：短临界区用法（拿锁 → 锁内重读 → mutate → 原子写 → 释放），
  与 poller 选举的「长租约」用法相区别。
- 抢锁超时（默认 3s）**返回 `undefined`**，不抛错——插件绝不能让 opencode 崩。
- 本轮只交付机制类，**不接线**进 `TelegramSessionMonitor`（数据用途未定，避免死代码）。

## 涉及范围

- **修改**: `monitor.ts`（新增模块级 `delay` 工具 + `SharedFileStore` 类；不改动 `PollerLock` 与现有任何逻辑）
- **依赖**: `node:fs/promises` 所需函数均已导入（`open/readFile/rename/writeFile/rm/mkdir`，`monitor.ts:16-26`）

## 上下文（探索结论）

- `PollerLock` 类：`monitor.ts:55-174`。`tryAcquire()` 用 `open(lockPath, "wx")` 原子独占创建；
  `isStale` = `pidAlive` 检查 + mtime TTL；`release()` 仅在 `ownerId` 匹配时删锁文件。
- 类结束于 `monitor.ts:174`，其后 176 行起是插件类型 import——新代码插在两者之间。
- `TelegramSessionMonitor.sleep` 是私有方法（`monitor.ts:2636`），独立类不可用 → 需模块级 `delay`。
- `DEFAULT_TTL_MS = 60_000`（`monitor.ts:46`）、`POLLER_LOCK_TTL_MS = 60_000`（`monitor.ts:213`）。
- poller 选举（`runTelegram`，`monitor.ts:1546-1639`）是同一把锁的「长租约」用法；
  `SharedFileStore` 是「短临界区」用法，原子原理相同（内核 `O_EXCL`）。

## Round 1

### Phase 1.1: SharedFileStore 机制类（已完成）

**目标**: `monitor.ts` 内新增 `SharedFileStore<T>`，通过全部行为验证与语法冒烟。
**并行组**: 单 phase，原地实现（design-driven-impl，用户直接指定的单 phase 交付）。
**触碰范围**: `monitor.ts`（唯一源文件改动）；`/tmp/opencode/` 下临时验证脚本（不入库、不提交）。
**任务**:

- [x] 新增模块级 `delay(ms)` 工具函数（命名避开类内私有 `sleep`）
- [x] 新增 `SharedFileStoreOptions` 类型 + `SharedFileStore<T>` 类（`read()` / `withWrite()`）
- [x] `withWrite` 实现：抢锁重试（50ms 间隔、3s 总超时返回 `undefined`）→ 锁内重读最新 →
      `mutate(current)` → `dataPath + ".tmp"` 写入 + `rename` 原子替换 → `finally release()`；
      `mutate` 返回 `undefined` 表示无变更、跳过写文件

**验收标准**:

- [x] `bun build --no-bundle --target node --external "*" monitor.ts` exit 0
- [x] 行为脚本（临时目录，**勿碰真实 `~/.otg/`**）全部断言通过：
  1. **单写者**：并发 5 个 `withWrite`，mutate 内 `delay(30)` 并统计临界区峰值并发 === 1
  2. **无丢失更新**：并发 10 个 `(current?.n ?? 0) + 1`，最终读回 `n === 10`
  3. **原子写**：写后 `read()` 返回完整合法 JSON
  4. **异常释放**：mutate 抛错后，后续 `withWrite` 仍能成功（锁未卡死）
  5. **崩溃回收**：预置死进程 pid 的 `.lock` 文件，`withWrite` 能越过 stale 锁成功
  6. **无变更跳过**：mutate 返回 `undefined` → 数据文件 mtime 不变

**实现记录**: （由 design-driven-impl @ 2026-09-01 回写）

- [x] 实现落点：`monitor.ts:176-248`（`PollerLock` 类之后、插件类型 import 之前）
  - `delay`：模块级工具函数，`monitor.ts:181`
  - `SharedFileStoreOptions`：`monitor.ts:183-187`（`lockTtlMs`/`acquireTimeoutMs`/`retryMs`，默认 60_000/3_000/50）
  - `SharedFileStore<T>`：`monitor.ts:189-248`；`constructor`、`read()`、`withWrite()`、私有 `withWriteLocked()`
  - `PollerLock`（monitor.ts:55-174）与现有逻辑零改动；未接线进 `TelegramSessionMonitor`（本轮范围外）
- [x] 行为验证：`/tmp/opencode/shared-store-test/verify-shared-file-store.mjs`（不入库）4 次全绿
  （`7/7 assertions passed`，含 6 条验收断言 + 1 条附加断言），`bun build` exit 0
- [x] 提交：`feat(monitor): add SharedFileStore for cross-window shared state`（见 git log）

> 设计补充（原计划未显式声明，由实现决定并回写）：`withWrite` 支持同步/异步两种
> `mutate`（`await mutate(current)`，类型签名 `=> T | undefined | Promise<T | undefined>`）；
> 同一实例并发调用 `withWrite` 时，实例内部用 promise 队列串行化——`PollerLock` 对同一
> `ownerId` 是重入的（同进程第二次 tryAcquire 会把自己已有的锁当成自己的），若无该队列，
> 同一实例的并发写会同时进入临界区导致 tmp→rename 竞态（验收 1「峰值并发 === 1」要求）。
> 跨进程互斥仍由锁文件本身保证。

### Round 1 整体测试记录

- 本 phase 未接线，插件对外行为零变化；机制行为验证即本 phase 验收（见上 6 项 + bun build 冒烟），
  由 design-driven-impl 在交付时真实执行并回贴输出结论。

## 断点记录（运输层错误续传用）

（空）

## 交付总结

- Round 1 / Phase 1.1（SharedFileStore 机制类）：已完成并提交
  （`feat(monitor): add SharedFileStore for cross-window shared state`）。
- 交付物：`monitor.ts:176-248` 新增模块级 `delay` + `SharedFileStoreOptions` + `SharedFileStore<T>`
  （`read()` / `withWrite()`），复用现有 `PollerLock` 未做任何改动，未接线。
- 验证：`bun build --no-bundle --target node --external "*"` exit 0；行为脚本 6 条验收断言
  + 1 条附加断言全绿（4 次重复运行稳定）。
- 后续轮次（接线、数据用途定稿）待主控/dev-lead 决定，本 phase 未触碰。
