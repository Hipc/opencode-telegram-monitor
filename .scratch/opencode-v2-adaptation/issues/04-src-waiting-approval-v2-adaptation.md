# 04 — src 等待/审批适配（permission + inbox/question + 回写）

**What to build:** 等待/审批链路在 v2 下与 v1 语义一致：

- permission 通知去抖（窗口内 replied 取消发送）与取消/终态删除语义保持；
- `session.inbox.*`（v2 question 通道）→ 等待记录与通知（含向导/自定义输入若语义变化则按 02 契约对齐）；
- TG 按钮回写经 v2 permission reply API 应用到真实 session 的闭环（含失败重试与幂等语义保持）；
- 事件路径与回写路径的双路径并存语义保持（v1 语义，见 sessions-relay 契约）；
- **禁止新增运行时兜底/降级路径**；v1 私有 transport（`_client.post` 等）不得依赖。

**Blocked by:** 02（契约）、03（同文件 `monitor.ts`/`index.ts`/`types.ts`，必须基于 03 合入后的新基线）。

**Status:** ready-for-agent

**Parallel group / blockers' release conditions:** 03 合入后唯一就绪；05/06 可与本票并行（不同文件）。

**Verification ownership:** 本地 = 容器内（otg-toolchain）等待/去抖/回写单测 + 全量既有测试绿 + 构建绿；集成 = 05 的容器 e2e 覆盖回写闭环。

- [ ] permission 去抖与取消行为保持（测试证据）
- [ ] inbox/question 映射与回复路径实现
- [ ] TG 按钮回写在 v2 下应用到真实 session（测试证据）
- [ ] 全量既有测试绿（容器内 bun）
- [ ] 变更提交到 task_branch（返回 commit SHA 与文件清单）
