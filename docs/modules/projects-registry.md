# projects-registry 模块契约（ProjectRegistryStore 写锁轮）

> 冻结: 2026-09-02（Round 1）　文件: `src/registry/index.ts`（核心区 144-281）
> 计划: docs/todos/projects-json-write-lock.md
> 背景: docs/todos/shared-file-store.md（PollerLock 复用结论）
> 本文件是 `ProjectRegistryStore.mutate()` 新语义（跨进程锁）的**唯一权威描述**；
> 与 docs/modules/split-contracts.md §2.7（拆分轮冻结）冲突处，以本文件为准（§8 列出差异）。

## 1. 模块职责与动机

`ProjectRegistryStore` 管理 `~/.otg/projects.json`（项目注册表）。多个 opencode 窗口
（多进程）可能同时写该文件；旧实现只有「进程内 promise 队列（`serialized()`）+ statKey
CAS 对比×3 重试」，缺少跨进程互斥：CAS 存在 TOCTOU 窗口（两进程同读同一 beforeKey 后
先后落盘 → last-writer-wins 丢失更新）。本轮在写入路径上加跨进程锁：

- 锁载体：`ProjectRegistryStore` **内嵌一把** `PollerLock`（`src/infra/poller-lock.ts`），
  锁文件 = 注册表文件路径 + `".lock"`（即 `~/.otg/projects.json.lock`）。
- 读取路径不加锁：`read()/isEnabled()` 维持 statKey 缓存行为（最终一致，可读到旧内容）。
- **不修改** `PollerLock` 本身；**不接线** `SharedFileStore`（维持现状未用）。

## 2. 公开接口契约（消费者视角，本轮零变化）

消费者（`src/index.ts`、`src/monitor.ts`）的导入路径、构造签名、方法签名与返回语义
**全部不变**——本轮是 `ProjectRegistryStore` 内部实现变更，对外接口冻结为：

| 成员 | 签名 | 语义（冻结） |
|---|---|---|
| `constructor` | `(filePath: string, logger?: (message: string) => Promise<void> \| void)` | 不变；新增副作用：创建一个私有 `PollerLock`（见 §3），**不创建任何文件/目录**（目录由 `ensureDir()`/锁获取时创建） |
| `ensureDir()` | `async (): Promise<void>` | 不变；`mkdir(dirname(filePath), { recursive: true })`。调用方写前负责调用（`src/index.ts:42`）；`mutate()` **不**自建注册表目录 |
| `read()` | `async (): Promise<ProjectRegistry>` | 不变；**不加锁不等待**，statKey 缓存；文件缺失/解析失败回退 `EMPTY_REGISTRY`；并发写期间可返回旧内容（最终一致） |
| `isEnabled(rootPath)` | `async (rootPath: string): Promise<boolean>` | 不变；`findRegistryEntry(...)?.enabled ?? false` |
| `mutate(fn)` | `async (fn: (reg: ProjectRegistry) => ProjectRegistry \| undefined): Promise<ProjectRegistry \| undefined>` | **语义重构**（§4）；`undefined` 返回语义与旧版兼容：fn 返回 `undefined` → 不写盘不抛错返回 `undefined`（旧版如此）；**新增**：抢锁超时也返回 `undefined`（旧版 CAS 重试耗尽也返回 `undefined`，消费者已兼容——见 §6 调用点） |

### 2.1 纯函数区（index.ts:13-142，不动）

`RegistryEntry` / `ProjectRegistry` / `EMPTY_REGISTRY` / `normalizeRegistryPath` /
`parseRegistry` / `serializeRegistry` / `findRegistryEntry` / `registerProject` /
`entryToken` / `findEntryByToken` / `setProjectEnabled` / `deleteProjectByPath`：
签名与行为**零改动**，本轮不做任何触碰。

### 2.2 statKey（保留，但用途变更）

`private statKey(): Promise<string | undefined>`（现 167-174，返回 `${mtimeMs}:${size}`）
**方法保留**——`read()` 缓存比对仍依赖它。**删除**其在 `mutate()` 内的 CAS 用途（beforeKey/
afterKey 前后对比与 ×3 重试循环）。

## 3. 锁实例化契约

- 字段：`private readonly lock: PollerLock`，在构造函数内初始化：
  `this.lock = new PollerLock(filePath + ".lock")`——**只传 lockPath，不传 ttlMs**，
  使用 `PollerLock` 默认 TTL = `DEFAULT_TTL_MS` = `60_000`（`src/constants.ts:7`）。
- import：`import { PollerLock } from "../infra/poller-lock";`（依赖方向与
  docs/02-directory-layout.md「infra/* → registry/*」一致）。
- 锁文件路径：`<filePath>.lock`，**精确等于**注册表路径字符串 + `".lock"`（测试不得写死
  `~/.otg`；HOME 隔离下为 `$TMP/.../projects.json.lock`）。
- TTL 语义：锁文件 mtime 超过 60s 即视为 stale（`PollerLock.fileIsStale`）；同机 pid 已死
  立即视为 stale（`isStale`：`info.host === hostname() && !pidAlive(info.pid)`）。
  本轮 mutate 临界区极短（读+算+原子写，远小于 60s），**不需要**在临界区内 `touch()`；
  不引入 touch 调用（保持简单；如未来临界区变长再议）。
- 同实例重入：`PollerLock` 对同一 `ownerId` 的二次 `tryAcquire` 会直接成功
  （poller-lock.ts:92-96）——**`serialized()` 队列必须保留**，否则同一实例并发 mutate
  会双双进入临界区破坏互斥（结论同 docs/todos/shared-file-store.md:78-83）。

## 4. `mutate()` 行为契约（本轮核心，冻结）

`mutate(fn)` 重构为如下确定步骤（作为唯一权威流程）：

```
serialized() 进程内队列（保留，不得移除）
  └─ 循环抢锁:
        deadline = Date.now() + ACQUIRE_TIMEOUT_MS(3000)
        立即尝试 tryAcquire() 一次；
        失败则每 RETRY_MS(50) 重试一次，直到 deadline 到点
        → 超时: return undefined（不执行 fn、不抛错、不改缓存）
     └─ 抢到锁后（临界区）:
        1. 锁内重读: statKey()（结果记作 `key`，兼作缓存比对 key，等同旧实现的 beforeKey）→ 读文件 → parseRegistry
           - 文件缺失 → EMPTY_REGISTRY（同现状）
           - 解析失败且文本非空（损坏）→ copyFile 备份 `<filePath>.bak` + logWarn
             （损坏也继续以 EMPTY_REGISTRY 为底执行 fn——修复性写入，同现状 231-240）
        2. next = fn(registry)
           - next === undefined → return undefined（不写盘、不改缓存；锁在 finally 释放）
        3. 幂等无变化: next === registry 且无解析损坏 → 不写盘，仅刷缓存
           cache = { key: key ?? "missing", registry: next }（损坏时仍走写盘以修复）
        4. 否则 writeAtomic(next)（原样保留，Windows 兜底不动）
        5. 刷缓存: cache = { key: (await statKey()) ?? "missing", registry: next }
        6. return next
     └─ finally: lock.release()（无论 fn 是否抛错）
```

### 4.1 冻结的参数常量

| 常量 | 值 | 说明 |
|---|---|---|
| `ACQUIRE_TIMEOUT_MS` | `3_000` | 抢锁 deadline（从首次尝试起算），超时返回 `undefined` |
| `RETRY_MS` | `50` | 抢锁重试间隔 |
| TTL | `60_000` | `PollerLock` 默认（`DEFAULT_TTL_MS`，不显式传） |

实现可把三个常量写成 `ProjectRegistryStore` 模块内的 `const`（不要求导出；测试只能靠
行为验证超时语义，不得依赖常量导出）。

### 4.2 错误与异常语义（冻结）

- 抢锁超时：返回 `undefined`，**不抛错**（插件绝不因注册表锁阻塞 opencode）。
- fn 抛错：错误向上传播（调用方原有的 try/catch 路径不变），**锁必须先 `release()`**
  （finally），不得卡死后续 mutate（LOCK-005）。
- writeAtomic 抛错（磁盘故障等）：向上传播，锁同样在 finally 释放。
- 锁获取成功后无需二次 CAS：锁内重读已保证「读到即最新」（锁外无写者）。

### 4.3 明确不做的事（防过度实现）

- `mutate()` 内**不**调用 `ensureDir()`（注册表目录由调用方保证：`src/index.ts:42`；
  锁文件父目录由 `PollerLock.tryAcquire()` 自建，poller-lock.ts:85——这会使
  projects.json 的父目录在锁获取时实际存在，属良性副作用，**不要**因此往里加 mkdir）。
- **不**给 read()/isEnabled() 加锁或等待（保持最终一致）。
- **不**改 `writeAtomic`（tmp+rename + Windows EPERM 的 rm+rename / copyFile 兜底，
  现 261-280）。
- **不**改 `serialized()` 的实现。
- **不**改 `PollerLock`、**不**接线 `SharedFileStore`。

## 5. 调用点与消费契约（本轮零改动，冻结）

| 调用点 | 用途 | undefined 兼容性 |
|---|---|---|
| `src/index.ts:42-43` | 启动：`ensureDir()` + `mutate(registerProject(reg, root))` | 返回值未使用，兼容 |
| `src/monitor.ts:458` | 周期自注册 `mutate(registerProject(reg, root))` | 返回值未使用，兼容 |
| `src/monitor.ts:1625-1630` | 回调 set：`mutate(entry ? setProjectEnabled(...) : undefined)` | 已是 `if (!next)` 处理，兼容 |
| `src/monitor.ts:1641-1644` | 回调 del：`mutate(entry ? deleteProjectByPath(...) : reg)` | 已是 `if (!next)` 处理，兼容 |
| `src/monitor.ts:1654` | 回调 register（旧菜单残留按钮） | 返回值未使用，兼容 |

`read()` 调用点：`src/monitor.ts:437`（isEnabled）、`1601`、`1664`——不加锁语义不变。

## 6. 测试契约（tests/registry-concurrency.test.mjs，LOCK-001~005）

新文件 `tests/registry-concurrency.test.mjs`（与 `tests/behavior.test.mjs` 同级、用 bun
运行，不引入测试框架）。测试基建冻结：

- **隔离**：每个用例用独立临时目录（`mkdtemp` 到系统 tmp），构造 `ProjectRegistryStore`
  指向 `join(tmp, "projects.json")`；**绝不触碰真实 `~/.otg/`**（可显式覆盖 HOME。
  注意：锁文件/注册表路径由测试传入的 filePath 决定，不依赖环境变量）。
- 导入：`import { ProjectRegistryStore, registerProject, ... } from "../src/registry/index.ts"`
  （或 dynamic import，参照 behavior.test.mjs 的 import URL 写法）。
- 存储实例约定：每个 `ProjectRegistryStore` 实例是**独立锁 owner**（各自内嵌 PollerLock，
  ownerId 互异）——测试用「多个独立实例共享同一 filePath」模拟多进程并发。

| 用例 | 名称 | 定义（冻结） |
|---|---|---|
| LOCK-001 | 并发写无丢失更新 | ≥10 个独立 store 实例并发 `mutate`，回调把唯一 token 条目 push 进 `projects`（用 `registerProject` 语义：每个实例一个唯一路径）；全部完成后新实例 `read()`：注册表条目数 = 实例数，无丢失。另可加 N 次并发递增计数器（mutate 读→改→写）终值 = N 的强校验 |
| LOCK-002 | 读不被锁阻塞 | 实例 A 的 mutate 回调内（持锁期间）调用**另一实例 B** 的 `read()`：立即返回（<100ms 量级）、返回可解析注册表、且不等锁释放；持锁期间 B 的 `read()` 不抛错 |
| LOCK-003 | 抢锁超时返回 undefined | 实例 A `mutate` 持锁阻塞（回调内等待/锁不释放）期间，实例 B `mutate` → 约 3s 后返回 `undefined`，**不抛错**；随后 A 释放锁，B 再次 mutate 成功返回注册表 |
| LOCK-004 | stale 锁回收 | 预置锁文件：向 `<filePath>.lock` 写入格式合法、`pid` 为不可能存活的值（如 `2**31-1` 或 `Number.MAX_SAFE_INTEGER`）的 LockInfo JSON（字段见 poller-lock.ts:8-13）；`mutate` 越过 stale 锁成功并写盘 |
| LOCK-005 | 异常释放 | 实例 A `mutate` 回调抛错 → 断言该 reject 向上传播；随后（锁已释放）另一实例（或同实例）`mutate` 正常成功（锁未被卡死） |

> 注：`PollerLock.tryAcquire()` 每次调用都会 mkdir 锁父目录；LOCK-004 预置锁文件时
> `mkdir(dirname(lockPath), { recursive: true })` 需先确保目录存在（或让 store 的
> `ensureDir()` 先行）。这是测试脚手架细节，不构成对实现的要求。

## 7. 验证门（合并后全量）

- `bun tests/registry-concurrency.test.mjs`（LOCK-001~005 全绿）
- `HOME=$(mktemp -d) bun tests/behavior.test.mjs`（API-001/002/003 回归）
- `node scripts/build.mjs`（exit 0 + 根产物）
- `bun tests/e2e/bundle-smoke.test.mjs`

## 8. 与既有契约文档的差异（supersede 记录）

| 出处 | 原句 | 本轮状态 |
|---|---|---|
| split-contracts.md §2.7 | 「整类逐字节平移（缓存/serialized 队列/3 次重试/原子写/Windows fallback）」 | 3 次重试（CAS）本轮移除；其余保留。`ProjectRegistryStore` 类契约以此为 supersede |
| split-contracts.md §2.7 | 「无 src 内部依赖」 | 本轮新增 `../infra/poller-lock` import（依赖方向符合 directory-layout 的 infra→registry 序）；其余导入不变 |

## 9. 变更记录

- 2026-09-02 冻结（Round 1 / Phase 1.1）：mutate 加跨进程锁语义、锁行为契约、LOCK-001~005。