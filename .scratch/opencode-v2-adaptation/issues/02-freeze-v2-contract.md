# 02 — v2 集成契约冻结（doc-prep）

**What to build:** 依据 01 的实测证据，冻结 v2 集成契约文档，作为 03/04/05/06 的唯一实现依据：

- 事件 → 内部映射表（v2 payload 形状 → 现有 `handleEvent` 分发的语义对齐，逐事件族）；
- client API 用法与签名（入口/日志/会话查询/permission reply/storage 取舍）；
- 入口与生命周期 seam（`{id, effect|setup}` 选择、`event.subscribe` 接线、v1 `dispose` 的等价物、root/directory 来源）；
- 类型策略（本地类型定义 vs 包导入；bundle 的 external 策略变化）；
- 测试替身（fake v2 client）形状冻结（供 03/04/05 编写）；
- 文件所有权与批次划分（03/04 同文件串行边界）。

**Blocked by:** 01 — 需要实测 payload 与 API 签名证据才能冻结。

**Status:** ready-for-agent

**Parallel group / blockers' release conditions:** 02 完成后 {03, 05} 同时就绪；04 等待 03。

**Verification ownership:** 文档合入即验收；03/04/05 可直接据此实现（无未决签名/形状）。文档由 doc-prep 写入 `docs/modules/`，并更新 `docs/00-overview.md` 指针。

- [ ] 映射表覆盖 01 全部事件族与 client 调用
- [ ] 测试替身（fake v2 client）形状冻结（供 05 编写）
- [ ] 入口/生命周期/类型策略明确，无未决项
- [ ] `docs/00-overview.md` 指针更新
- [ ] 合入 task_branch（返回 commit SHA）
