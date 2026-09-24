# opencode v2 适配 — 任务规格（feature: opencode-v2-adaptation）

> 创建: 2026-09-24 · 任务分支: `feat/opencode-v2-adaptation` · 目标: opencode **v2.0.15**（容器镜像 `hipc/opencode2:latest`）

## 需求

opencode 升级到 v2，插件接口完全改变；把 `opencode-telegram-monitor` 重新适配到 v2 插件接口。

## 已确认决策（用户，2026-09-24）

1. **v2-only**：仓库主线切到 v2；v1 用户继续用已发布的 0.6.x。不做双兼容。
2. **全量功能对齐**：生命周期 / 用量 / todo / 权限通知 + TG 按钮回写 / 提问通知 / 注册表菜单 / 锁 / 代理 / 自更新。
3. **范围**：仅本仓库插件；其它本地 v1 插件（`bb-agent-state` 等）不在本轮。
4. **验收**：容器 e2e + 真实 TG 冒烟；真实凭据用宿主 `~/.otg`（只读挂载、容器内拷贝使用，不写宿主）。
5. **版本**：`1.0.0`（破坏性：仅支持 opencode v2）。
6. **合回策略**：交付后等待用户指令；**未授权自动合回**；push 另行授权。

## 硬约束

- **不得影响本机正在运行的 opencode**（宿主为 v1，本会话运行其上）。
- **所有构建 / 测试 / 验证环节均在容器内进行**（用户重申）；不在宿主安装任何东西。

## 环境事实（recon，2026-09-24）

- 宿主 opencode：v1（`~/.config/opencode` 下 `@opencode-ai/plugin` 1.17.13；本地插件均为 v1 风格）。
- 宿主无 bun（`npm install -g bun` 因代理 ECONNREFUSED 失败，不再重试宿主安装）。
- 工具链镜像：**`otg-toolchain:latest`**（node 22.23.2 + bun 1.4.2，alpine/musl，代理内置）。
- v2 测试镜像：**`hipc/opencode2:latest`**（opencode v2.0.15；仅 curl；内嵌 bun；XDG 配置目录；
  `plugin` 数组接受本地文件路径；`opencode run --standalone` 无头可用；`opencode serve` + `opencode api`）。
- v2 插件契约（recon 摘要，待 01 探针实测补全）：默认导出 `{id, effect|setup}`；`event.subscribe(fn)`；
  `permission.hook/list/get/reply`；`session.inbox.*` 取代 `question.*`；client 对象含
  `app/location/session/permission/tool/storage/...`。
- 任务 worktree：`/home/hipc/work/git-clone/opencode-telegram-monitor-v2`
  - original_root=`/home/hipc/work/git-clone/opencode-telegram-monitor`
  - original_branch=`main`，original_base_sha=`76130078fc9354d4569c2681df559b1ff8357182`

## 验证基线（容器内，2026-09-24）

- `node scripts/build.mjs` → exit 0（18 模块 → `monitor.ts` 146.24 KB）
- 全量测试 **116 用例全绿**（10 文件；`real-*` 需真实凭据，除外）

## 可复现命令（容器内）

```bash
W=/home/hipc/work/git-clone/opencode-telegram-monitor-v2

# 构建
docker run --rm --user $(id -u):$(id -g) -e HOME=/tmp/home \
  -v $W:/w -w /w otg-toolchain:latest sh -c 'mkdir -p /tmp/home && node scripts/build.mjs'

# 全量测试（逐文件，隔离 HOME）
for f in $(cd $W && find tests -name '*.test.mjs' ! -name 'real-*' | sort); do
  docker run --rm --user $(id -u):$(id -g) -v $W:/w -w /w \
    otg-toolchain:latest sh -c "export HOME=\$(mktemp -d); bun $f"
  echo "$f -> $?"
done
```

## Tickets

见 `issues/01..06`。就绪前沿：`01 → 02 → {03,05} → 04 → 06`；关键链：01 证据 → 02 契约 → 03/04 核心（同文件串行）。
