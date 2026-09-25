# 任务状态 — opencode-v2-adaptation

> 最后更新: 2026-09-25（UTC）· 任务分支 `feat/opencode-v2-adaptation` · 目标 opencode v2.0.15（镜像 `hipc/opencode2:latest`）
> 阶段: **开发完成（全部批次 + T09/T10/T12 实机修复已合入）**；T12 文档回写（r5）合入后，full 门禁重跑待于当前 HEAD 执行（含真实 TG 冒烟、dupe、t10-cross 与 t12-ownership 场景；代理替换已获用户批准）→ 交付（等待合并指令）

## 资源清单

- 任务 worktree: `/home/hipc/work/git-clone/opencode-telegram-monitor-v2`（`feat/opencode-v2-adaptation`）
- 原始 worktree: `/home/hipc/work/git-clone/opencode-telegram-monitor`（`main` @ `76130078fc9354d4569c2681df559b1ff8357182`，只读，全程未触碰）
- 子 worktree: 无在途（t01/t03/t04/t05/t05b/t06/t07/t08/t09/t10/t11/t12 均已合入并清理）
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
| T09 重复推送修复 | 已合入 | `8c807377` | 实机事故：同一 question 连续重复推送——`request_id` 全局幂等（append 去重 / mark 全副本 / 轮内去重）+ message_id 解包修正；负控（修复前 16 次重复发送）；容器 dupe 场景 |
| T10 回写通道修复 | 已合入 | `5453956f` | 实机事故：TG 选 option 显示 Submitted 但 TUI 不提交——端点发现补 `service.json`（pid 匹配 + loopback 校验）+ apply 归属门（`session.get`，非宿主跳过不删记录）；容器双 server 场景正例 15/15 + 负控 7/7 |
| T11 冒烟夹具修复 | 已合入 | `602f906a` | 收尾竞态：等待终端发送结果 + 宽限再停服；竞态模拟验证（旧版致断 / 新版等待） |
| T12 事件归属修复 | 已合入 | `ca5ad927` | 实机事故：一次完成 → 多条不同项目名通知（多激活各发一条）——事件归属过滤（location 比对 / sessionID 索引）+ 进程级共享去重；容器正例 8/8 + 负控 6/6（复现现场签名） |

## 关键决策

- 2026-09-24（用户）：v2-only；全量功能对齐；仅本仓库插件；容器 e2e + 真实 TG 冒烟（`~/.otg` 只读挂载、容器内拷贝）；版本 1.0.0；交付后等待合并指令。
- 2026-09-25（用户）：**移除 todo 代码**（v2.0.15 四路验证不可观测）。
- 2026-09-25（实机事故 + 本机加载发现）：触发一个 question 后连续重复 TG 推送 → 根因 = 多实例重复记录（append 无去重）+ `markSessionSent` 只标第一条 + `response.result.*` 解析错误致 q_msg_id 缺失；T09 修复（`8c807377`，负控：修复前 16 次重复发送）。本机 v2 实测从 `~/.config/opencode/plugins/`（**复数**）自动加载成功（同进程 `loading plugin` 反复 ~6 次）；探针已证单数 `plugin/` 亦自动发现——两目录均被扫描，建议只放一处。
- 2026-09-25（实机事故 2）：TG 已提交但 TUI question 未落定 → 根因 = ① 常驻 `serve --service` 进程 argv 无 `--port`、env 无密码（端点发现缺失）② ad-hoc server 抢跑 apply 得 404 被误判终态删记录（无归属门）；T10 修复（`5453956f`）。recon：v2 把 `{url,pid,password}` 写入 `~/.local/state/opencode/service.json`（0600）；TUI 均为该 daemon 客户端。
- 2026-09-25（实机事故 3）：一次 agent 完成 → 多条 complete 通知（项目名各异、表格相同）→ 根因 = v2 事件流全局共享且 monitor 未按项目过滤（多激活各发一条）；T12 修复（`ca5ad927`）：事件归属过滤（带 location 严格比对；无 location 走 sessionID 索引）+ 进程级共享去重收敛同 root 重复激活。

## 契约要点（最终，权威版见 docs/modules/opencode-v2-contract.md）

1. 本地加载：`<configDir>/plugin/*.ts` **与** `<configDir>/plugins/*.ts` 均自动发现（本机实测复数、探针实测单数）或 目录包（package.json→index.ts）；配置数组拒绝绝对文件路径。
2. 事件：`session.execution.*` / `session.step|text|tool.*` / `session.usage.updated` / `permission.*` / `form.*` / `inbox.*`；v1-compat 事件（`message.*`/`session.idle`/`session.error`）不存在。
3. question 通道 = `form.*`（`form.created` + options/custom）；form 回写 = 进程内 `POST /api/session/<sid>/form/<fid>/reply`（Basic auth；端点发现链 = argv `--port N|--port=N` → state `service.json`（pid 匹配、loopback 校验）→ legacy `~/.config/opencode/service.json` → 显式失败；argv 端口在而 env 密码缺失不回落）；**apply 归属门**：先 `client.session.get`，非宿主跳过且不删记录（permission/question 同）。
4. permission 回写 = `client.permission.reply({sessionID, requestID, decision})`；已决请求的错误（普通 `Error`，文本精确匹配）→ 终态删除、不重试。
5. subagent lineage：子会话 `session.created`/`session.get` 携带 `parentID`（已消费；恢复 v1 父/根投影与 token 聚合）。
6. todo 已移除；无 `app.log`（自有 dlog/console 通道）。
7. 事件归属（T12）：带 `location.directory` 的事件必须与本实例 root（resolve 后）严格相等；无 location 的事件经 sessionID→directory 索引归属（`form.created` 用 `data.form.sessionID`）；不可归属 → 忽略 + 一次性诊断；进程级共享 seen-event 集合（`Symbol.for("opencode-telegram-monitor/seen-events")`）收敛同 root 重复激活。

## 最终验证

- 首次 full（`4c2da740`）：15/16 PASS（build + 124 用例 + 4 套容器 e2e）；真实 TG 冒烟 ENV_BLOCKED（配置代理 `100.113.198.63:7890` 不可达）→ 用户批准以可用代理 `10.0.10.100:17892` 替换容器侧副本；重试暴露配方覆盖缺口（`run --standalone` 退出过快，5s idle 去抖被 dispose 清除，发送从未发生）→ T08 修复（serve 长驻 + 发送断言）。
- 门禁重跑（T08 后）：在 `73499e0a` 上重跑容器内 full（build + 10 个 host 套件 + harness/probe-a1/harness-resolved/lineage + 真实 TG 冒烟，代理替换副本）；结果见交付报告。
- 门禁重跑（T09 后）：在 `63767247` 上重跑 full —— 17/17 PASS（130 用例 + dupe 12/12 + 真实 TG 冒烟 status=200）；见交付报告。
- 门禁重跑（T10 后）：在 `602f906a` 上重跑 full —— 18/18 PASS（145 用例 + dupe 12/12 + t10-cross 15/15 + 真实 TG 冒烟 status=200）；见交付报告。
- 当前门禁：T12（`ca5ad927`）新增 OWNERSHIP 单测与容器 `t12-ownership`（正例 8/8 + 负控 6/6）→ **full 门禁重跑以含本轮文档提交的当前 HEAD 为 tested_sha**（命令配置同上 + dupe + t10-cross + t12-ownership）；结果见交付报告。
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
| T09 重复推送修复 | 12:50 | 13:15 | ≈380s | request_id 幂等 + mark 全副本 + message_id 解包；负控（修复前 16 次重复发送） |
| T10 回写通道修复 | 13:57 | 14:25 | ≈780s | service.json 端点发现 + 归属门；双 server 场景正/负控 |
| T11 冒烟夹具修复 | 14:56 | 15:07 | ≈360s | 收尾等待终端结果 + 宽限；竞态模拟验证 |
| T12 事件归属修复 | 15:07 | 16:20 | ≈1500s | 归属过滤 + 共享去重；正/负控 |
| 集成包 ×7 | 15:14 | 18:57 | <1s/包 | 全部 ff/rebase，线性历史 |

- 口径：排队时长（ready→dispatch）与调用耗时（dispatch→返回）未插桩，记 unknown；环境耗时 ≈0（镜像已存在、零依赖）；不把 worker 时长之和冒充总耗时。
