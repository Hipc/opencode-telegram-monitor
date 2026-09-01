# 版本号唯一来源迁移到 package.json（构建时注入）

> 状态: completed
> 创建: 2026-09-02
> 当前轮次: Round 1
> 关联文档: docs/modules/version-injection.md（本轮冻结契约）、README.md#releases

## 背景

当前版本号有双源：`src/version.ts` 的 `PLUGIN_VERSION` 常量（源码内唯一来源）与
`package.json` 的 `version` 字段，靠 `set-version.mjs` 同步 + `build.mjs` 构建后断言维持一致。
用户要求改为：**`package.json` 成为唯一版本来源**，构建时读取并注入到 bundle 产物。
这是 npm 生态标准做法，且与现有 self-update 兜底（读 staging 包内 package.json version，
`src/monitor.ts:265-289`）方向天然一致。

## 已确认决策（grilling 结论）

1. **README 同步时机**：保持由 `set-version.mjs` 在发版时同步，build 不写任何文件（构建只读、可复现）。
2. **src/version.ts 去留**：保留文件（`SERVICE` 导出被 `src/index.ts:6`、`src/config/load-config.ts:4` 引用），
   `PLUGIN_VERSION` 改为「未声明全局标识符 + dev fallback」注入点模式——`--define` 替换不了源码中
   已声明的同名 const，必须用未声明标识符。
3. **非目标**：不发版（版本保持 0.5.3）、不改任何运行时行为、README 更新不挪进 build。

## 涉及范围

- **修改**: `src/version.ts`、`scripts/build.mjs`、`scripts/set-version.mjs`、`scripts/check-version.mjs`、
  `.githooks/pre-push`（仅注释）、`.github/workflows/publish.yml`（仅注释）、`README.md`（版本流程描述段落）
- **不动**: 产物形态（仍是 `var PLUGIN_VERSION = "x.y.z"`）、self-update 逻辑与 staged 断言正则、
  `src/monitor.ts`、`package.json` 的 version 值、`docs/**`（由文档先行代理负责冻结新契约）
- **依赖**: bun build `--define` 注入机制（需实测 typeof 折叠行为）；基线分支 main，HEAD 773da5e

## 上下文（探索结论）

- `src/version.ts:6` — `export const PLUGIN_VERSION = "0.5.3";`；同文件还导出 `SERVICE`（勿动）。
- `scripts/build.mjs:33-46` — bun build 仅传 `--target/--external/--outfile`，无注入；`:58-69` 构建后
  硬门断言产物版本 == `package.json`（保留，改为验证注入生效）。
- `scripts/set-version.mjs:35-45` — 目前改写 src/version.ts（要删掉这段）；`:47-50` package.json、
  `:52-64` README pin（保留）。
- `scripts/check-version.mjs:35-48` — 目前校验 src/version.ts（要删掉这段）；`:50-52` package.json、
  `:54-66` README pin（保留）。
- `.githooks/pre-push` — 已核实**无** src/version.ts 字样（调用 check-version.mjs 的方式不变，
  本轮可零改动）；`.github/workflows/publish.yml:66-69` 注释提及 src/version.ts，需更新措辞
  （Verify/Build 步骤调用不变）。
- `README.md:76-81`（三处同步表格）、`:87-94`（发版步骤 `git add src/version.ts ...`）— 需改写为
  package.json 单源 + 构建注入的描述。
- tests 不直接断言 PLUGIN_VERSION（grep 无命中）；`tests/behavior.test.mjs` 直跑 `src/`（覆盖 fallback 路径），
  `tests/e2e/bundle-smoke.test.mjs` 对产物。
- **bun 环境怪癖**（上一轮实证）：本机 bun 为 WSL interop Windows 二进制，绝对 Linux 路径报 `BadPathName`；
  一律用相对路径且 cwd=仓库根（worktree 内同理）。

## 最终验证测试任务

> 累计维护。不含单元测试（各 phase 自带）；本插件无 UI。

### 外部接口测试

- [E2E-001] `node scripts/build.mjs`：cwd=仓库根；期望 exit 0，产出根目录 `monitor.ts`，
  产物含 `var PLUGIN_VERSION = "0.5.3";`（== package.json version，验证注入生效）；来源：本计划验收标准①
- [API-001] `node scripts/check-version.mjs 0.5.3`：期望 exit 0，输出提及 package.json 与 README；来源：验收标准②
- [API-002] `node scripts/check-version.mjs 9.9.9`：期望 exit 1，错误信息指明 package.json/README 不符，
  且**不再提及 src/version.ts**；来源：验收标准②
- [API-003] `node scripts/set-version.mjs <v>`（在仓库的**临时副本**上执行）：期望只改副本内
  package.json + README.md，**不再改写 src/version.ts**（副本 src/version.ts 内容不变）；来源：验收标准②
- [REG-001] `HOME=$(mktemp -d) bun tests/behavior.test.mjs`：3/3 通过（回归，覆盖直跑 src/ 的 fallback 路径）；来源：验收标准④
- [REG-002] `bun tests/e2e/bundle-smoke.test.mjs`：通过（产物命名导出回归）；来源：验收标准④

### 界面（UI）测试

- 无（CLI/插件项目，无界面）

### 本轮回归重点

- E2E-001：注入是本轮核心改动，产物版本断言必须实证（不能凭 define 语义推断）。
- REG-001：`src/version.ts` 改为 fallback 模式后，直跑路径（behavior 套件）必须全绿。

## Round 1

### Phase 1.1: 版本注入链路（version.ts 注入点 + build.mjs 注入） ✅

**目标**: `package.json` version 经 `bun build --define` 注入 bundle；src 直跑时走 dev fallback。
**并行组**: 批次 A（可与 1.2 并发，无文件交集）
**触碰范围**: `src/version.ts`（仅 PLUGIN_VERSION 声明区）、`scripts/build.mjs`（bun build 参数段 + 断言段注释）
**分支**: `phase-r1-p1.1`　**worktree**: `.worktrees/phase-r1-p1.1`
**任务**:

- [ ] `src/version.ts`：PLUGIN_VERSION 改为注入点——
  `declare const __PLUGIN_VERSION__: string | undefined;` +
  `export const PLUGIN_VERSION = typeof __PLUGIN_VERSION__ !== "undefined" ? __PLUGIN_VERSION__ : "0.0.0-dev";`
  （SERVICE 与其余注释不动；更新该文件头部注释说明单一来源已是 package.json）
- [ ] `scripts/build.mjs`：读 `pkg.version` 后给 bun build 传
`--define __PLUGIN_VERSION__:"<version>"`（值为 JSON 字符串字面量，注意 shell 引号转义；
   用 Bun.build API 则传 `define: { __PLUGIN_VERSION__: JSON.stringify(version) }`）；
   保留构建后断言（产物版本 == pkg.version），更新相关注释；
   删除 `:71-84` 的 `Self-update compatibility` const 字面量警告段（含文件头
   `:13-14` 对应描述——self-update 已走 package.json 兜底，注入后该警告必然触发属噪音；
   契约授权，见 version-injection.md §2.3）
- [ ] **先实测** define 注入产物形态：构建后确认产物含 `var PLUGIN_VERSION = "0.5.3";`
  （若 bun 对 typeof 折叠异常导致形态变化，如实报告并让断言匹配真实形态，禁止放宽断言）
- [ ] 本 phase 单元自测：cwd=worktree 根执行 `node scripts/build.mjs` exit 0 且产物含正确版本；
  `bun -e "import('./src/version.ts').then(m=>console.log(m.PLUGIN_VERSION))"` 输出 `0.0.0-dev`
  （或等价的直跑验证，注意 bun 相对路径怪癖）

**验收标准**:
- [ ] `node scripts/build.mjs` exit 0，产物 monitor.ts 含 `var PLUGIN_VERSION = "0.5.3";`
- [ ] 直跑 src（bun test/import）时 PLUGIN_VERSION === "0.0.0-dev"，无运行时错误
- [ ] SERVICE 导出未受影响（behavior 套件相关用例不因此报错）

**实现记录**: 分支 `phase-r1-p1.1` @ `82696b0`（feat(build): inject package.json version via bun define，+27/−30）。
产物形态实测 = 契约目标形态 `var PLUGIN_VERSION = "0.5.3";`（bun 对 typeof 守卫常量折叠 + var hoist），§3 无偏离、无需回写；
直跑 src 输出 `0.0.0-dev`（typeof 守卫生效，无 ReferenceError）；build.mjs 硬门断言保留未放宽。
处置记录：仓库存在上一轮遗留的同名死分支（指向 main 祖先、无独有提交），已 `git branch -d` 后从 main 重建签出。
无延期、无偏差。

### Phase 1.2: 版本脚本收缩（set-version / check-version / 文档措辞） ✅

**目标**: 发版与校验脚本只认 package.json + README 两个面；文档描述与新链路一致。
**并行组**: 批次 A（可与 1.1 并发，无文件交集）
**触碰范围**: `scripts/set-version.mjs`、`scripts/check-version.mjs`、`.githooks/pre-push`（已核实
无 src/version.ts 字样，可零改动）、`.github/workflows/publish.yml`（仅注释 :66-69）、
`README.md`（仅版本流程描述段：三处同步表格、发版步骤）
**分支**: `phase-r1-p1.2`　**worktree**: `.worktrees/phase-r1-p1.2`
**任务**:

- [ ] `scripts/set-version.mjs`：删除改写 src/version.ts 的段落（:31,:35-45 及头部注释相应行），
  保留 package.json 与 README pin 写入；输出信息更新为 `package.json, README.md -> <version>`
- [ ] `scripts/check-version.mjs`：删除 src/version.ts 校验段（:35,:41-48 及头部注释相应行），
  保留 package.json 与 README pin 校验；不一致输出不再提及 src/version.ts；
  提示语 `Run node scripts/set-version.mjs ...` 保留；成功输出更新措辞
- [ ] `.githooks/pre-push` 与 `.github/workflows/publish.yml`：pre-push 确认无 src/version.ts 字样
  （现状已无，零改动即可）；publish.yml 仅更新 :66-69 提及 src/version.ts 的注释，
  Verify（:70-71）与 Build（:76-77）步骤零改动（tag checkout 后 package.json 即 tag 版本，
  check-version 通过 → build.mjs 注入同值 → 发布，幂等性不受影响；workflow 无 set-version 步骤）
- [ ] `README.md`：改写「Releases / keep all three in sync」段落——单一来源 package.json、
  构建时注入产物、set-version 只写 package.json + README；发版步骤去掉 `git add src/version.ts`
- [ ] 本 phase 单元自测（在仓库**临时副本**上，禁止污染真仓库）：
  copy 仓库到 mktemp 目录 → `node scripts/check-version.mjs 0.5.3` exit 0；
  `node scripts/check-version.mjs 9.9.9` exit 1 且信息含 package.json 不含 src/version.ts；
  `node scripts/set-version.mjs 9.9.9` 后副本内 package.json/README 已变而 src/version.ts 未变

**验收标准**:
- [ ] check-version 对 0.5.3 exit 0、对 9.9.9 exit 1，输出不含 src/version.ts 字样
- [ ] set-version 不再读写 src/version.ts（副本实测）
- [ ] pre-push / publish.yml 逻辑零改动（与基线 diff 仅注释行，pre-push 可为空 diff）
- [ ] README 版本流程描述与新链路一致，无 src/version.ts 残留描述

**实现记录**: 分支 `phase-r1-p1.2` @ `0bbdac2`（refactor(scripts): drop src/version.ts from version scripts，4 files +26/−50）。
临时副本实测：check-version 0.5.3 → exit 0（输出无 src/version.ts）；9.9.9 → exit 1（错误含 package.json/README 两条，提示语保留）；
set-version 9.9.9 后副本 package.json/README 更新、src/version.ts 未变、`x.y.z` 占位符未被误改，set 后 check-version 9.9.9 → exit 0。
顺手清理：删除 set-version.mjs 头部「publish workflow 回写 main with [skip ci]」过期注释（与 workflow 现状不符）；check-version 失败首行措辞改为 `does not match the pinned version`。
处置记录：`phase-r1-p1.2` 同样撞上轮陈旧分支（已确认是 main 祖先），`git branch -D` 后从 main 重建。pre-push 零改动（diff 为空）。无延期、无偏差。

### Round 1 整体测试记录

- 测试结论：【通过】（12/12 用例；单元回归 REG-001 behavior 3/3 + 对外面 5 条全绿）
- 执行记录：REG-001 `HOME=$(mktemp -d) bun tests/behavior.test.mjs` exit 0；E2E-001 `node tests/e2e/version-injection.test.mjs` exit 0
  （产物含 `var PLUGIN_VERSION = "0.5.3";`，无 0.0.0-dev 残留）；API-001/002/003 `node tests/e2e/version-scripts.test.mjs` exit 0；
  REG-002 `bun tests/e2e/bundle-smoke.test.mjs` exit 0。失败：无。
- 测试文件：本轮新增 `tests/e2e/version-injection.test.mjs`、`tests/e2e/version-scripts.test.mjs`（提交 `f346412`）；
  既有 `tests/behavior.test.mjs`、`tests/e2e/bundle-smoke.test.mjs` 未改。
- 执行器约束（已固化在新测试文件头部注释）：纯 spawn+fs 类 e2e 必须用 `node` 执行——bun（WSL interop Windows 二进制）
  下内部 spawnSync 落入 Windows 域会 ENOENT。
- 失败摘要与根因归属：无。

## 交付总结

- **结论**：1 轮完成，整体测试【通过】，版本号唯一来源已迁移到 package.json。
- **合并链**：`9b4fc0a`(docs) → `82696b0`(p1.1) → `0bbdac2`(p1.2) → `5ea2f7e`(merge HEAD) → `f346412`(test e2e)。
- **改动面**：src/version.ts（注入点+fallback）、scripts/build.mjs（--define 注入+硬门保留）、
  scripts/set-version.mjs / scripts/check-version.mjs（只认 package.json+README）、
  .github/workflows/publish.yml（注释）、README.md（版本流程段）、tests/e2e/ 新增 2 个测试文件。
- **产物形态**：`var PLUGIN_VERSION = "0.5.3";`（bun typeof 常量折叠实证，契约 §3 无偏离）；直跑 src 为 "0.0.0-dev"。
- **遗留**：分支领先 origin/main 33 个提交未推送（等用户确认 docs 可公开后自行 push）；
  publish.yml/pre-push 属 CI 集成面，无独立 e2e 条目（本轮仅注释改动，逻辑零改动）。

## 断点记录（运输层错误续传用）

（空）

## 交付总结

（待填）
