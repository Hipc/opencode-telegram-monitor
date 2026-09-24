# 03 — src 核心适配（入口 + 会话生命周期/用量/todo）

**What to build:** 插件在 opencode v2 下可加载并跑通核心链路：

- 入口契约：默认导出 `{id, effect|setup}`、`event.subscribe` 接线、生命周期/dispose 等价物、root 解析；
- 会话生命周期事件（`session.created/updated/idle/error/deleted`，含 v2 的状态/错误形状）→ 现有投影与 TG 通知链路（busy/idle/retry/终态语义保持）；
- `message.updated` / `message.part.updated` → 用量统计与工具投影（token/cost 字段按 v2 形状）；
- todo 来源适配（v2 等价查询或事件）；
- `TARGET_OPENCODE_VERSION` → v2.x；
- 保持既有对外行为：去抖/去重/落盘语义不动，仅集成层适配；**禁止新增运行时兜底/降级路径**，异常保留原因并暴露。

**Blocked by:** 02 — 需要冻结的事件映射与 client 签名。

**Status:** ready-for-agent

**Parallel group / blockers' release conditions:** 02 完成后与 05 同时就绪；04 等待本票合入（同文件基线）。

**Verification ownership:** 本地 = 容器内（otg-toolchain）本票单测 + 受影响既有测试绿 + 构建绿；集成 = 构建产物在 opencode2 容器可加载（探针配方），容器 e2e 由 05 承接。

- [ ] v2 入口契约实现，容器内加载成功（日志证据）
- [ ] 生命周期/用量/todo 行为与 v1 语义一致（测试证据）
- [ ] 受影响既有测试全绿（容器内 bun）
- [ ] `node scripts/build.mjs` 绿
- [ ] 变更提交到 task_branch（返回 commit SHA 与文件清单）
