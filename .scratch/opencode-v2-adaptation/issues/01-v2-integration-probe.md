# 01 — opencode v2 集成探针（容器实测证据）

**What to build:** 在 `hipc/opencode2:latest`（opencode v2.0.15）容器内，用一个最小探针插件实测并落盘 v2 插件集成契约的全部事实，供契约冻结（02）与实现（03/04）直接引用：

- **加载契约**：默认导出 `{id, effect|setup}` 两种形态的选择与语义；`setup(client)` 收到的 client 对象实际能力面；reload / 生命周期（v1 `dispose` 的等价物）；本地多文件 TS 插件能否被 v2 直接加载（决定是否需要宿主打包）。
- **事件实测**：我们消费的事件族逐条捕获真实 payload —— `session.created/updated/idle/error/deleted`、`message.updated`、`message.part.updated`、`permission.asked/replied/rejected`、`session.inbox.*`（question 通道）、`session.execution.*`、tool 相关事件；以及 todo / token 用量数据在 v2 的来源与形状。
- **client API 签名**：日志（`app.log` 等价物）、会话查询（list/status/get/messages/todo 等价物）、permission reply（精确请求形状）、storage（是否可替代自研落盘层 —— 只记录事实，不改方案）。
- **触发配方**：无头脚本化会话（`opencode run --standalone` / `serve` + `api`）确定性触发 permission-ask 与 question/inbox 的方法；root/directory 信息在 v2 的来源。
- **证据**：原始 trace（JSONL）+ 发现报告提交到 task_branch。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

**Parallel group / blockers' release conditions:** 唯一初始就绪票。02（契约冻结）、03/04（实现）、05（e2e 配方）全部等待其证据产出。

**Verification ownership:** 本地 = 容器内探针加载成功（插件日志证据）+ 每事件族 ≥1 条实测 payload + 命令可复现；集成 = 本票产出的容器配方由 05 复用（green-run 由编排器统一调度）。

- [ ] 探针在 opencode2 容器内成功加载（日志/证据可复现）
- [ ] 目标事件族各有 ≥1 条真实 payload trace（必须包含 permission 与 inbox/question）
- [ ] client API 精确签名（含 permission reply）实测确认，不依赖推测
- [ ] 无头触发配方可复现（记录确切命令与输出）
- [ ] 证据与发现报告提交到 task_branch（返回 commit SHA）
