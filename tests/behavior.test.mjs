// tests/behavior.test.mjs
//
// 行为验证脚本：实例化 TelegramSessionMonitor，把 enqueueMessage /
// enqueueMessageWithKeyboard 替换为收集数组，喂入事件断言通知去抖行为。
// 契约：docs/modules/split-contracts.md §2.12（导入/构造/打桩/运行/--dry 全部冻结）。
// 用例：API-001（auto-approve 去抖）、API-002（真待审批延迟通知）、API-003（question 立即通知）。
//
// 用法：
//   HOME=$(mktemp -d) bun tests/behavior.test.mjs     # 完整断言（批次 B 合并后执行）
//   bun tests/behavior.test.mjs --dry                 # 只检查可载入性（批次 A 阶段可用）
//
// 绝不使用真实 botToken/chatId；运行必须隔离 HOME 以避免写真实 ~/.otg。

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 契约 §2.12 导入路径：../src/monitor.ts（命名导出）与 ../src/registry/index.ts。
// 使用 dynamic import：--dry 模式要求在 src/monitor.ts 尚未落盘（批次 A 未合并）
// 时本脚本仍能载入并 exit 0，而静态 import 会在模块加载阶段直接抛
// ERR_MODULE_NOT_FOUND，无法进入 dry 分支。
const srcMonitorURL = new URL("../src/monitor.ts", import.meta.url);
const srcRegistryURL = new URL("../src/registry/index.ts", import.meta.url);
const srcMonitorPath = fileURLToPath(srcMonitorURL);

const isDry = process.argv.includes("--dry");

async function dryCheck() {
  if (!existsSync(srcMonitorPath)) {
    // 前序 phase 未合并：打印说明，不做任何行为断言（预期，不算失败）。
    console.log("[dry] tests/behavior.test.mjs: src/monitor.ts not merged yet");
    console.log("[dry] skipping behavioral assertions (expected during round A)");
    console.log("[dry] after merge, run: HOME=$(mktemp -d) bun tests/behavior.test.mjs");
    process.exit(0);
  }
  const mod = await import(srcMonitorURL.href);
  if (typeof mod.TelegramSessionMonitor !== "function") {
    console.error("[dry] FAIL: src/monitor.ts does not export TelegramSessionMonitor");
    process.exit(1);
  }
  console.log("[dry] src/monitor.ts present; import + named export assertion passed");
  process.exit(0);
}

async function main() {
  if (isDry) {
    await dryCheck();
    return;
  }

  if (!existsSync(srcMonitorPath)) {
    console.error(
      "src/monitor.ts not merged yet; run with --dry for the loadability check only",
    );
    process.exit(1);
  }

  const { TelegramSessionMonitor } = await import(srcMonitorURL.href);
  const registryModule = await import(srcRegistryURL.href);
  const { ProjectRegistryStore } = registryModule;
  const { registerProject, setProjectEnabled } = registryModule;

  // 契约 §2.12 fake client 最小面 { app: { log } }。运行核对发现主类实际还需要：
  // - initialize() -> bootstrap() 调 client.session.list / client.session.status；
  // - notifyWaiting() -> primarySession() -> ensureSessionInfo() 调 client.session.get。
  // 按契约「如运行中发现缺字段，在测试内补最小 stub 并注释」补齐，均为空数据 no-op。
  const fakeClient = {
    app: { log: async () => {} },
    session: {
      list: async () => ({ data: [] }),
      status: async () => ({ data: {} }),
      get: async ({ path }) => ({ data: { id: path.id, title: "Test session" } }),
    },
  };

  // 假配置（契约 §2.12 字面值）；绝不真发。
  const fakeConfig = {
    botToken: "123456789:TESTTOKEN_DO_NOT_USE_abcdefg",
    chatId: "123",
  };

  const baseDir = await mkdtemp(join(tmpdir(), "otg-behavior-test-"));
  const root = join(baseDir, "project");
  const registry = new ProjectRegistryStore(join(baseDir, "projects.json"));
  // 注册并启用 root：notifyWaiting 会先经 isProjectEnabled() 检查，
  // registerProject 只创建 enabled:false 条目，不显式启用则通知永远不会发出。
  await registry.mutate((reg) => registerProject(reg, root));
  await registry.mutate((reg) => setProjectEnabled(reg, root, true));

  let failures = 0;
  const total = 3;

  async function runCase(name, fn) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${name}: ${error.message}`);
    }
  }

  // 契约 §2.12 打桩：构造后把私有发送入口替换为收集数组（.mjs 无类型检查），
  // 并把 runTelegram/scheduleRegistration/scheduleSelfUpdate 置为 no-op，
  // 避免真实网络轮询/注册/自更新。
  function makeMonitor() {
    const monitor = new TelegramSessionMonitor(
      fakeClient,
      fakeConfig,
      root,
      registry,
    );
    const collected = [];
    monitor.enqueueMessage = async (text) => {
      collected.push(text);
    };
    monitor.enqueueMessageWithKeyboard = async () => {};
    monitor.runTelegram = async () => {};
    monitor.scheduleRegistration = () => {};
    monitor.scheduleSelfUpdate = () => {};
    monitor.initialize();
    return { monitor, collected };
  }

  // API-001: auto-approve（permission.asked 随即 permission.replied）→ 0 条通知。
  // permission 通知走去抖窗口（WAITING_NOTIFY_DEBOUNCE_MS=1000），窗口内
  // received replied（即被 auto-approve）→ cancelWaitingNotify 取消发送。
  await runCase(
    "API-001 auto-approve: permission.asked + immediate replied -> 0 notifications",
    async () => {
      const { monitor, collected } = makeMonitor();
      monitor.accept({
        id: "evt-1001",
        type: "permission.asked",
        properties: { sessionID: "s-1", id: "perm-1", permission: "read" },
      });
      monitor.accept({
        id: "evt-1002",
        type: "permission.replied",
        properties: { sessionID: "s-1", requestID: "perm-1" },
      });
      await sleep(2500); // 越过去抖窗口：若 cancel 生效则仍为 0 条
      if (collected.length !== 0) {
        throw new Error(
          `expected 0 notifications, got ${collected.length}: ${JSON.stringify(collected)}`,
        );
      }
      await monitor.dispose();
    },
  );

  // API-002: 真待审批（仅 permission.asked，无 replied）→ 2.5s 后恰 1 条
  // [WAITING] 通知且文本含 "Permission"。
  await runCase(
    "API-002 pending permission: only permission.asked -> 1 [WAITING] notification after 2.5s",
    async () => {
      const { monitor, collected } = makeMonitor();
      monitor.accept({
        id: "evt-1003",
        type: "permission.asked",
        properties: { sessionID: "s-1", id: "perm-2", permission: "read file" },
      });
      await sleep(2500); // > WAITING_NOTIFY_DEBOUNCE_MS，去抖窗口过期后发出
      if (collected.length !== 1) {
        throw new Error(
          `expected exactly 1 notification, got ${collected.length}: ${JSON.stringify(collected)}`,
        );
      }
      const text = collected[0];
      if (!text.includes("[WAITING]")) {
        throw new Error(`notification missing [WAITING] marker: ${text}`);
      }
      if (!text.includes("Permission")) {
        throw new Error(`notification missing Permission text: ${text}`);
      }
      await monitor.dispose();
    },
  );

  // API-003: question.asked → 立即 1 条通知（question 不去抖）。
  await runCase(
    "API-003 question asked -> immediate 1 notification",
    async () => {
      const { monitor, collected } = makeMonitor();
      monitor.accept({
        id: "evt-1004",
        type: "question.asked",
        properties: {
          sessionID: "s-1",
          id: "q-1",
          questions: [{ header: "Continue with the plan?" }],
        },
      });
      // question 不走去抖窗口：只需等 notifyWaiting 异步链（registry.read 等
      // 真实 I/O）完成，故等待较短时间即可。
      await sleep(300);
      if (collected.length !== 1) {
        throw new Error(
          `expected exactly 1 notification, got ${collected.length}: ${JSON.stringify(collected)}`,
        );
      }
      await monitor.dispose();
    },
  );

  await rm(baseDir, { recursive: true, force: true });
  const passed = total - failures;
  console.log(`\n${passed}/${total} cases passed`);
  // 显式退出：bootstrap 的 withTimeout 会遗留 8s 探活 timers，让事件循环
  // 空挂约 8s；先 flush stdout 再退出。
  await sleep(20);
  process.exit(failures === 0 ? 0 : 1);
}

await main();