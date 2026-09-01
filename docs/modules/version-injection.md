# 版本注入契约（version-injection）

> 状态: frozen（Round 1 版本注入轮 doc-prep 冻结，提交于 main）
> 创建: 2026-09-02
> 关联计划: docs/todos/version-from-package-json.md（Round 1，phase 1.1 – 1.2）
> 基线: `main` @ `773da5e`
> 适用范围: 本文件是**包版本单一来源迁移轮**的契约唯一事实来源——版本号以
> `package.json` 的 `version` 字段为唯一来源，构建时经 `bun build --define` 注入
> bundle 产物。Phase 1.1 / 1.2 的一切实现、自测、断言以此为准；并行工人不得
> 自行发明与本文件冲突的接口、形态或断言。

## 0. 背景与目标（已确认决策，grilling 结论）

1. **单一来源**：`package.json` 的 `version` 字段是唯一事实来源。`src/version.ts`
   不再包含版本字面量，改为「注入点」——构建时被 `--define` 替换为真实版本，
   直跑 src（测试/开发，无 define）时回退到 `"0.0.0-dev"`。
2. **构建只读、可复现**：`scripts/build.mjs` 只读 `package.json` 并注入，不写任何
   文件（除产物 monitor.ts 本身）；README 的版本 pin 仍由 `set-version.mjs` 在
   发版时同步，不挪进 build。
3. **非目标**：不发版（版本保持 0.5.3）、不改任何运行时行为、不动 self-update
   逻辑（见 §5）、不动产物对外形态（仍是 `var PLUGIN_VERSION = "x.y.z";`）。
4. **为什么必须用未声明标识符**：`--define`（bun/esbuild 语义）只能替换源码中
   **未声明**的标识符引用。若 `PLUGIN_VERSION` 保持为已声明的 `const`，define
   不会生效。因此注入点形式为「`declare const __PLUGIN_VERSION__`（仅类型声明，
   运行时不存在）+ `typeof` 守卫」——`typeof` 对未声明标识符不抛 ReferenceError，
   被 define 替换为 `typeof "0.5.3"` 后可被常量折叠。

---

## 1. 注入点契约（Phase 1.1 提供：src/version.ts）

**1.1 冻结代码形态**（`src/version.ts`，从第 6 行 `export const PLUGIN_VERSION = "0.5.3";` 起替换）：

```ts
// PLUGIN_VERSION is injected at bundle time by scripts/build.mjs from
// package.json "version" (see docs/modules/version-injection.md). Running the
// sources directly (tests/dev) without the define yields the dev fallback
// below; a released bundle always carries the real package version.
declare const __PLUGIN_VERSION__: string | undefined;
export const PLUGIN_VERSION =
  typeof __PLUGIN_VERSION__ !== "undefined"
    ? __PLUGIN_VERSION__
    : "0.0.0-dev";
```

- **必须满足**：
  - 顶层存在 `declare const __PLUGIN_VERSION__: string | undefined;`（类型声明，无运行时值）；
  - 守卫**必须是 `typeof __PLUGIN_VERSION__ !== "undefined"` 形态**（禁止简写为
    `__PLUGIN_VERSION__ ?? "0.0.0-dev"`——未 define 时直接读未声明标识符会抛
    ReferenceError，`typeof` 是唯一安全的探测方式）；
  - fallback 字符串**必须**是 `"0.0.0-dev"`（tests/behavior 直跑路径以此为
    稳定可断言值）；
  - `export const PLUGIN_VERSION` 的导出名与导出形态不变（`src/monitor.ts:41`
    `import { PLUGIN_VERSION, ... }` 依赖）。
- **同文件其余导出零改动**：`SERVICE`、`TARGET_OPENCODE_VERSION`、`NPM_PACKAGE_NAME`、
  `NPM_REGISTRY_BASE`、`SELF_UPDATE_FETCH_TIMEOUT_MS`、`OPENCODE_CACHE_MARKERS`
  的值与导出均不变。
- **头部注释更新**：现第 3-5 行「Single source of truth ... set-version.mjs reads
  this constant and writes package.json」方向描述已过时，改写为「单一来源是
  package.json，构建时注入」（即上面代码块中的注释；用词可微调，含义必须一致）。

**1.2 消费方与影响面**（已核实，均不需要改动）：

| 消费方 | 现状 | 注入后语义 |
|---|---|---|
| `src/monitor.ts:41`（`import { PLUGIN_VERSION }`，runSelfUpdate / 通知文案） | 真实版本 | bundle 产物=真实版本（注入值）；直跑 src= `"0.0.0-dev"`。`latest === PLUGIN_VERSION` 比较逻辑不变 |
| `src/index.ts:6`、`src/config/load-config.ts:4`（`SERVICE`） | 不变 | 不受影响（SERVICE 未动） |

---

## 2. 构建注入契约（Phase 1.1 提供：scripts/build.mjs）

**2.1 define 传参形态**（现状 build.mjs 用 `spawnSync` 数组参数，无 shell 引号问题）：

```js
// 读 pkg.version（build.mjs 已有），注入：
["--define", `__PLUGIN_VERSION__:${JSON.stringify(version)}`]
// JSON.stringify("0.5.3") === '"0.5.3"'（含双引号），数组元素即 __PLUGIN_VERSION__:"0.5.3"
```

- 若改用 `Bun.build` API，则传 `define: { __PLUGIN_VERSION__: JSON.stringify(version) }`
  ——值**必须是**「含双引号的字符串字面量」（`"0.5.3"`），不是裸 `0.5.3`。
- 注入值必须来自 `pkg.version`（`package.json` 单一来源），不得硬编码。

**2.2 产物硬门断言（保留，只更新注释）**：构建后读取根 `monitor.ts`，断言
`/PLUGIN_VERSION = "([^"]+)";/`（未锚定，var/const 关键字均接受）且捕获值
`=== pkg.version`，失败 `exit 1`。**禁止放宽**「值 == pkg.version」这一硬门。

**2.3 删除 const 字面量警告段（契约授权）**：删除 build.mjs 第 71-84 行
「3) Self-update compatibility」警告块及其在文件头注释（8-14 行）中的对应描述。
理由：该警告的前提（self-update 依赖产物中 `const PLUGIN_VERSION = "..."` 字面量）
已不存在——self-update 校验在拆分轮已落地 package.json 兜底（见 §5.1），
注入后该 warning 确定性地永远触发，属纯噪音。
**注意**：文件头注释（8-14 行）中关于 bun 把模块级 `const` hoist 为 `var`
产物的说明**保留**（仍是产物形态的成因），只删「self-update literal ... only
warned about if absent」相关句。

**2.4 bun 环境怪癖（既有约束，重申）**：本机 bun 为 WSL interop Windows 二进制，
绝对 Linux 路径报 `BadPathName`；exec 一律相对路径且 `cwd = 仓库根`（build.mjs
现状已满足；worktree 内执行时同理）。

---

## 3. 产物契约

1. **目标形态**：构建后根 `monitor.ts` 含 `var PLUGIN_VERSION = "0.5.3";`
   （`"0.5.3"` 由 pkg.version 注入；`var` 由 bun 的模块级绑定 hoist 产生，与
   基线产物形态一致，见根 monitor.ts:49 现状）。
2. **直跑形态**：不经构建直跑 `src/version.ts`（bun test / import）时
   `PLUGIN_VERSION === "0.0.0-dev"`，无运行时错误。
3. **实测回写条款**：若 bun 对 `typeof` 守卫的常量折叠行为与预期不同（如产物
   保留三元、或关键字不是 var），Phase 1.1 工人**如实报告**，断言正则按真实
   形态更新，但「值 == pkg.version」硬门**不许放宽**；契约形态由 doc-prep 在
   下一轮依据实测回写本文件 §3。E2E-001（计划文件）是本条款的实证载体。

---

## 4. 脚本契约（Phase 1.2 提供）

**4.1 `scripts/set-version.mjs`**：
- 删除 `src/version.ts` 读写段（现 :31 路径、:35-45 改写 + 头部 :6 注释行）；
- **保留** package.json 写入（:47-50）与 README pin 写入（:52-64）+ 版本合法性
  校验（:24-29，整段保留）；
- 输出信息改为 `set-version: package.json, README.md -> <version>`。
- 对本轮 phase 自测的约束（关联计划文件 API-003）：必须在仓库**临时副本**上
  执行，禁止污染真仓库。

**4.2 `scripts/check-version.mjs`**：
- 删除 `src/version.ts` 读取与校验（现 :35 读取、:41-48 mismatch 分支 + 头部
  :5 注释行）；
- **保留** package.json 校验（:50-52）、README pin 校验（:54-66）、版本合法性
  校验（:30-33）、失败提示 `Run \`node scripts/set-version.mjs ...\` first.`
  （:70）；
- 成功输出改为 `check-version: <version> matches package.json, README.md`；
- **任何输出（stdout/stderr/错误信息）不得含 `src/version.ts` 字样**。

**4.3 `.githooks/pre-push`**：调用方式零改动（`node scripts/check-version.mjs <tag>`）。
已核实该文件**无** `src/version.ts` 字样，本轮可零改动（触碰范围内的「仅注释」
允许空 diff）。

**4.4 `.github/workflows/publish.yml`**：逻辑零改动——「Verify version matches
tag」步骤（:70-71，跑 check-version）与「Build plugin bundle」步骤（:76-77，
跑 build.mjs）均不变；仅更新 :66-69 注释中 `src/version.ts / package.json /
README.md` 的枚举为 `package.json / README.md`。流程幂等性说明：tag checkout
后 `package.json` 即 tag 版本，check-version 校验通过 → build.mjs 注入同值
→ 发布，无需也不存在 set-version 步骤（已核实 workflow 无该步骤）。

**4.5 `README.md`**：仅版本流程描述段（「Publishing a new release」一章：
:76 措辞、:78-82 三处同步表格、:87 注释、:94 `git add src/version.ts package.json
README.md`）改写为 package.json 单源 + 构建注入的描述；全 README 不得残留
`src/version.ts` 版本来源描述。

---

## 5. 边界与不动项（防工人误碰）

1. **self-update 逻辑不动**（`src/monitor.ts` `applyVersionUpdate` :265-300）：
   拆分轮已落地 **package.json 兜底**（读 staged/current `package/package.json`
   的 `version` 字段与 `latest` 比对，源码注释明示「split-contracts §4 兜底
   决策」）。本轮版本注入后该路径**完全不受影响**，禁止改动。
   - 与 `docs/modules/split-contracts.md §4` 的关系：§4.1「首选（字面量断言，
     保留）」在拆分轮实机被证伪（bun 把 const hoist 为 var，产物无 const 字面量），
     拆分轮实现已采用 §4.3 兜底。本文件取代 split-contracts.md §4 中与版本来源
     相关的表述；split-contracts.md 作为拆分轮 frozen 历史契约，本体不改。
2. **`package.json`**：`version` 值（0.5.3）不改；`main`/`types`/`files` 不改；
   scripts 条目（`set:version` / `check` / `prepublishOnly` 等）不改。
3. **`src/monitor.ts` / `src/index.ts` / `src/config/load-config.ts` / `src/telegram/*`
   / `src/format/*` / `src/infra/*` / `src/registry/*`**：本轮零改动（消费
   `SERVICE` 与 `PLUGIN_VERSION` 的 import 语句均不变；PLUGIN_VERSION 值语义
   变化仅影响直跑路径——属预期行为，见 §1.2）。
4. **tests**：`tests/behavior.test.mjs`（直跑 src/，覆盖 fallback 路径）与
   `tests/e2e/bundle-smoke.test.mjs`（对产物）均不改；REG-001 / REG-002 为本轮
   回归实证。
5. **docs/ 与根产物 monitor.ts**：并行工人禁止触碰 `docs/**`；根 `monitor.ts`
   是构建产物（gitignore），禁止手改。

---

## 6. 并行分组（写入计划文件，dev-lead 调度依据）

### 批次 A（可全并发，2 个 worktree）：Phase 1.1 + 1.2

| phase | 触碰文件（编辑区间） |
|---|---|
| 1.1 | `src/version.ts`（PLUGIN_VERSION 声明区 + 头部注释）、`scripts/build.mjs`（bun build 参数段 :33-54 + 断言/警告段 :56-84） |
| 1.2 | `scripts/set-version.mjs`、`scripts/check-version.mjs`、`.githooks/pre-push`（可零改动）、`.github/workflows/publish.yml`（仅注释）、`README.md`（版本流程段） |

- **文件交集 = 空**，编辑区间零重叠 → 可同批并发；合并顺序任意。
- **无硬依赖**：1.2 删除对 src/version.ts 的读写不依赖 1.1 的新形态；1.1 的
  注入不依赖 1.2 的脚本收缩。两 phase 各自自测独立成立。
- 分支/worktree：`phase-r1-p1.1` / `.worktrees/phase-r1-p1.1`、
  `phase-r1-p1.2` / `.worktrees/phase-r1-p1.2`（均自基线 main 签出）。
- 与 dev-lead 初步分组（批次 A 并发）**一致，无差异**。

---

## 7. 验证引用（计划文件为执行载体，此处为契约锚点）

- E2E-001 产物注入实证 ↔ 本文件 §3.1 / §3.3；API-001/002 ↔ §4.2；API-003 ↔ §4.1；
  REG-001 ↔ §1.1 fallback / §5.4；REG-002 ↔ §3.1。

---

## 8. 冻结记录

- Round 1（版本注入轮）doc-prep 于 2026-09-02 冻结本文件，提交：
  `docs(round 1): freeze design docs & contracts for version injection round 1`
  （SHA 见 git log）。
- 与计划文件的关系：计划文件记 phase 安排、任务与验收；本文件记契约本体。
- 仍存在的文档风险：产物形态（§3）依赖 bun 实测，若与预期偏离由 Phase 1.1
  报告后 doc-prep 下轮回写。