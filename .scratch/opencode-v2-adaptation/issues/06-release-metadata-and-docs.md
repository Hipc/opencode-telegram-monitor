# 06 — 发布元数据与文档同步

**What to build:** 适配后的发布元数据与文档同步：

- `package.json` 版本 → `1.0.0`（走 `scripts/set-version.mjs` 流程，同步 README 的 npm pin）；
- README：兼容性（opencode v2 / v1 用户留 0.6.x）、安装说明（v2 本地安装路径按契约更新）、只读声明与审批回写说明按实际行为更新；**移除 Todo projection 特性描述**（v2 不可观测、代码已移除）；
- `docs/00-overview.md`：目标版本、SDK/接口描述、关键机制按 v2 更新；
- 版本注入 / 校验测试保持绿（`version-injection` / `version-scripts`）。

**Blocked by:** 03、04 — 文档需描述最终行为；版本号需在核心适配完成后落定。

**Status:** ready-for-agent

**Parallel group / blockers' release conditions:** 03/04 合入后与 05 的 green-run 并行。

**Verification ownership:** 本地 = 容器内版本相关测试绿 + 文档与实际行为一致（对照 02 契约）；不 tag、不发布、不 push。

- [ ] `package.json` 1.0.0 + README pin 同步（set-version 流程，check-version 通过）
- [ ] README 兼容性/安装/只读章节更新，且不含已移除特性描述（Todo projection）
- [ ] `docs/00-overview.md` 更新
- [ ] 版本注入/校验测试绿（容器内 bun）
- [ ] 变更提交到 task_branch（返回 commit SHA 与文件清单）
