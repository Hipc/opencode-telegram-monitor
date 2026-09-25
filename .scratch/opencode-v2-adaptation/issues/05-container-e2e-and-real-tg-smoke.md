# 05 — 容器 e2e 工具 + 真实 TG 冒烟配方

**What to build:** 可复现的容器 e2e 工具与真实 TG 冒烟配方：

- 容器 e2e：构建（otg-toolchain）→ 挂载（bundle / 容器内 opencode 配置 / 隔离 otg 目录）→ opencode2 容器加载插件 → 脚本化会话（按 01 配方触发事件）→ 断言（诊断日志 / registry 记录 / 等待流 / 回写闭环）；
- 断言至少覆盖：生命周期通知、等待记录（permission + question/inbox）、TG 按钮回写闭环各 ≥1 条；
- 真实 TG 冒烟：只读挂载宿主 `~/.otg`、容器内拷贝到可写目录使用；短暂运行；不写宿主目录；文档化确切步骤与预期观察；
- 工具必须自清理（`--rm`、动态空闲端口、不残留容器/进程；不占用本地 opencode 相关端口）。

**Blocked by:** 02 — 配方/替身契约冻结后可并行编写（对探针/stub 验证机制）。对最终适配插件的 green-run 依赖 03/04 合入，由编排器统一调度执行。

**Status:** ready-for-agent

**Parallel group / blockers' release conditions:** 02 完成后与 03 同时就绪；04 合入后执行最终 green-run。

**Verification ownership:** 本地 = 工具可复现 + 机制验证（对探针/stub 插件）；集成 = 对适配后插件的容器 e2e 证据 + 真实 TG 冒烟证据（本票作者编写，编排器调度执行）。

- [ ] 工具脚本可复现（记录确切命令与输出）
- [ ] 断言覆盖：生命周期通知、等待记录、回写闭环（至少各 1）
- [ ] 真实 TG 冒烟配方文档化且不写宿主目录
- [ ] 对适配后插件的 green-run 证据（03/04 合入后）
- [ ] 变更提交到 task_branch（返回 commit SHA 与文件清单）
