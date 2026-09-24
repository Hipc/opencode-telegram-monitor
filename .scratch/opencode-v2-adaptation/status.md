# 任务状态 — opencode-v2-adaptation

> 最后更新: 2026-09-25（UTC）· 任务分支 `feat/opencode-v2-adaptation` · 目标 opencode v2.0.15（镜像 `hipc/opencode2:latest`）
> 阶段: **开发完成（全部批次已合入）**；最终 full 门禁重跑中（含真实 TG 冒烟；代理替换已获用户批准）→ 交付（等待合并指令）

## 资源清单

- 任务 worktree: `/home/hipc/work/git-clone/opencode-telegram-monitor-v2`（`feat/opencode-v2-adaptation`）
- 原始 worktree: `/home/hipc/work/git-clone/opencode-telegram-monitor`（`main` @ `76130078fc9354d4569c2681df559b1ff8357182`，只读，全程未触碰）
- 子 worktree: 无在途（t01/t03/t04/t05/t05b/t06/t07 均已合入并清理）
- 工具链镜像: `otg-toolchain:latest`（node 22.23.2 + bun 1.4.2）；测试镜像 `hipc/opencode2:latest`（opencode v2.0.15）
- 合回授权: **未授权**（交付后等待指令）；push 未授权

## Ticket / 批次状态

| # | 状态 | commit | 备注 |
|---|---|---|---|
| 01 探针 | 已合入 | `8cf28c2f` | 8 场景容器实测；证据 `tools/v2-probe/**` |
| 02 契约冻结 | 已合入 | `de1abeaf`（r1 `7eabae78`、r2 `c3136a95`） | `docs/modules/opencode-v2-contract.md` |
| 03 src 核心 | 已合入 | `0da0f3c7` | 入口/生命周期/用量；todo 移除 |
| 04 src 等待/审批 | 已合入 | `8f3572f1` | permission/form/HTTP 回写；122 用例绿 |
| 05 容器 e2e 工具 | 已合入 | `2f29103`（rebase → `4dddc8e7`） | harness + form 通道探针（19/19） |
| 05b green-run + lineage | 已合入 | `9f1161fb`（rebase → `4dddc8e7`） | harness 对适配插件 20/20；parentID 可观测结论 |
| 06 发布元数据与文档 | 已合入 | `3ec5ae0d` | 1.0.0 + README/docs 同步 |
| 修复轮 F1–F3 | 已合入 | `401e7c19` | parentID 恢复；resolved-reply 终态分类；help 文案 |
| 文档 r2 回写 | 已合入 | `c3136a95` | lineage 关闭 / 错误形状 / harness README 校正 |
| T08 冒烟配方修复 | 已合入 | `73499e0a` | serve 长驻 + 发送断言（合成 401 机制验证 + 负控）；代理替换经用户批准 |

## 关键决策

- 2026-09-24（用户）：v2-only；全量功能对齐；仅本仓库插件；容器 e2e + 真实 TG 冒烟（`~/.otg` 只读挂载、容器内拷贝）；版本 1.0.0；交付后等待合并指令。
- 2026-09-25（用户）：**移除 todo 代码**（v2.0.15 四路验证不可观测）。

## 契约要点（最终，权威版见 docs/modules/opencode-v2-contract.md）

1. 本地加载：`<configDir>/plugin/*.ts` 自动发现 或 目录包（package.json→index.ts）；配置数组拒绝绝对文件路径。
2. 事件：`session.execution.*` / `session.step|text|tool.*` / `session.usage.updated` / `permission.*` / `form.*` / `inbox.*`；v1-compat 事件（`message.*`/`session.idle`/`session.error`）不存在。
3. question 通道 = `form.*`（`form.created` + options/custom）；form 回写 = 进程内 `POST /api/session/<sid>/form/<fid>/reply`（Basic auth；端口 `serve --port N` argv + 双 env 密码；standalone 显式失败、无兜底）。
4. permission 回写 = `client.permission.reply({sessionID, requestID, decision})`；已决请求的错误（普通 `Error`，文本精确匹配）→ 终态删除、不重试。
5. subagent lineage：子会话 `session.created`/`session.get` 携带 `parentID`（已消费；恢复 v1 父/根投影与 token 聚合）。
6. todo 已移除；无 `app.log`（自有 dlog/console 通道）。

## 最终验证

- 首次 full（`4c2da740`）：15/16 PASS（build + 124 用例 + 4 套容器 e2e）；真实 TG 冒烟 ENV_BLOCKED（配置代理 `100.113.198.63:7890` 不可达）→ 用户批准以可用代理 `10.0.10.100:17892` 替换容器侧副本；重试暴露配方覆盖缺口（`run --standalone` 退出过快，5s idle 去抖被 dispose 清除，发送从未发生）→ T08 修复（serve 长驻 + 发送断言）。
- 当前门禁：在 `73499e0a` 上重跑容器内 full（build + 10 个 host 套件 + harness/probe-a1/harness-resolved/lineage + 真实 TG 冒烟，代理替换副本）；结果见交付报告。
- 复用条件：仅当 tested_sha 与命令配置不变时复用既有证据。

## 耗时记录（UTC；来源：各执行者报告 / git 提交时间；未插桩项记 unknown）

| 批次 | started_at | finished_at | checks | 备注 |
|---|---|---|---|---|
| 01 探针 | ~23:38 | 00:26 | ≈300s | 8 场景；1 次免费模型 transport 超时 |
| 03 src 核心 | ~16:47 | 17:12 | ≈115s | behavior 14/14 |
| 05 容器 e2e | ~16:44 | 17:24 | ≈60s | probe 19/19 + stub harness |
| 04 等待/审批 | unknown | 18:06 | ≈42s | 122/122 |
| 05b green-run | 18:12 | 18:35 | ≈95s | harness 20/20 |
| 06 发布元数据 | unknown | commit | ≈3s | 版本 1.0.0 |
| 修复轮 F1–F3 | ~18:41 | 18:56 | ≈310s | 124 用例 + harness 22/22 |
| T08 冒烟配方修复 | 19:26 | 19:40 | ≈60s | serve 长驻 + 发送断言；合成 401 机制验证 + 负控 |
| 集成包 ×7 | 15:14 | 18:57 | <1s/包 | 全部 ff/rebase，线性历史 |

- 口径：排队时长（ready→dispatch）与调用耗时（dispatch→返回）未插桩，记 unknown；环境耗时 ≈0（镜像已存在、零依赖）；不把 worker 时长之和冒充总耗时。
