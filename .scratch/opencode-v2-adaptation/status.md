# 任务状态 — opencode-v2-adaptation

> 最后更新: 2026-09-25（UTC）· 任务分支 `feat/opencode-v2-adaptation` · 目标 opencode v2.0.15

## 资源清单

- 任务 worktree: `/home/hipc/work/git-clone/opencode-telegram-monitor-v2`（`feat/opencode-v2-adaptation`）
- 原始 worktree: `/home/hipc/work/git-clone/opencode-telegram-monitor`（`main` @ `76130078fc9354d4569c2681df559b1ff8357182`，只读）
- 子 worktree: 无在途（t01 已合入并清理）
- 工具链镜像: `otg-toolchain:latest`（node 22.23.2 + bun 1.4.2）；测试镜像 `hipc/opencode2:latest`（opencode v2.0.15）
- 合回授权: **未授权**（交付后等待指令）；push 未授权

## Ticket 状态

| # | 状态 | 分支/commit | 备注 |
|---|---|---|---|
| 01 探针 | 已合并（待集中验证） | `t01-v2-probe` @ `8cf28c2f`（已清理） | 证据 `tools/v2-probe/**`（FINDINGS + 31 文件 evidence） |
| 02 契约冻结 | 待派发 | — | 需吸收探针 6 项关键差异 + todo 移除决策 |
| 03 src 核心 | 阻塞（02） | — | 范围含 **todo 代码移除** |
| 04 src 等待/审批 | 阻塞（02、03） | — | 同文件串行 |
| 05 容器 e2e | 阻塞（02） | — | 复用 `run-probe.sh` 基座 |
| 06 发布元数据 | 阻塞（03、04） | — | 版本 1.0.0；README 移除 Todo 特性 |

## 关键决策

- 2026-09-24（用户）：v2-only；全量功能对齐；仅本仓库插件；容器 e2e + 真实 TG 冒烟（真实凭据经只读挂载 `~/.otg`）；版本 1.0.0；交付后等待合并指令。
- 2026-09-25（用户）：**移除 todo 代码**（v2.0.15 四路验证不可观测）。
- 容器内基线（2026-09-24）：10 文件 116 用例全绿（`real-*` 除外）。

## 探针关键差异（02 必须吸收）

1. 配置数组**拒绝绝对文件路径**；本地加载 = `<configDir>/plugin/*.ts` 自动发现 或 目录包（package.json→index.ts）。
2. 事件改名：`message.*`/`session.idle`/`session.error` 在 v2 不存在 → `session.step/text/tool.*`、`session.execution.*`。
3. question 通道 = `form.*` + `inbox.*`（`form.created` 含 options/custom 字段）。
4. todo 不可观测（用户决定移除代码）。
5. `permission.reply({sessionID, requestID, decision:"once"|"always"|"reject"})`；`permission.replied` 事件字段为 `reply`。
6. 无 `app.log`；插件日志需自有通道（现有 `dline`/console 路径）。

## 耗时记录

| 项 | ready_at | dispatched_at | started_at | finished_at | 备注 |
|---|---|---|---|---|---|
| 01 探针 | 2026-09-24T15:39Z（bf3c10d 提交时刻） | unknown（未插桩） | 2026-09-24T23:38Z（执行者报告） | 2026-09-25T00:26Z（执行者报告） | 8 场景容器实测；checks ≈300s；一次免费模型 transport 超时 |

- 汇总口径：排队时长（ready→dispatch）与调用耗时（dispatch→返回）未插桩，记 unknown；环境耗时 ≈0（镜像已存在，无安装）；不把 worker 时长之和冒充总耗时。
