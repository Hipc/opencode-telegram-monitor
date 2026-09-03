// tests/behavior.test.mjs
//
// 行为验证脚本（Phase 1.2 改写，契约 docs/modules/sessions-relay.md §8）：
// 实例化 TelegramSessionMonitor，喂入 permission/question 事件，断言
// projects.json（registry）中被写入的 session 记录——
//   API-001 auto-approve（asked + 1s 内 replied）→ 0 条记录（去抖取消写入）
//   API-002 真待审批（仅 asked，等 2.5s）→ 恰 1 条完整记录（type/message/send/resolved/request_id/created_at/session_name）
//   API-003 question.asked → 立即 1 条记录（不去抖），message=完整调用内容 JSON
//   API-004 replied/rejected（含 v2/permissionID 变体）→ 按 request_id **删除**记录
//     （Round 6 §16 supersede：终态 = 删除，不再是 resolved=true）
//   API-005 短时多个 permission.asked（不同 request_id）→ 全部追加保留
//   API-501 ESC abort（session.error MessageAbortedError）→ 该 session 落盘记录删除
//   API-502 去抖窗口内 ESC abort → 记录从未写入（timer 取消）
//   API-503 session.deleted → 该 session 全部落盘记录删除
// 旧直发 TG 通知（notifyWaiting 调用点）已停用，本文件不再断言直发文本。
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

// 契约 §8 导入路径：../src/monitor.ts（命名导出）与 ../src/registry/index.ts。
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
  const { registerProject } = registryModule;

  // 契约 §2.12 fake client 最小面。主类运行需要：
  // - initialize() -> bootstrap() 调 client.session.list / client.session.status；
  // - persistWaitingRecord() -> ensureSessionInfo() 调 client.session.get（返回 title
  //   供 session_name）。
  // 均为空数据 no-op（title 定为 "Test session" 供 API-002 断言 session_name）。
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

  let failures = 0;
  let total = 0;

  // 每用例独立环境：独立临时目录 + registry 文件 + monitor（sessions 互不污染）。
  // 打桩：runTelegram/scheduleRegistration/scheduleSelfUpdate 置 no-op，
  // 避免真实网络轮询/注册/自更新；enqueueMessage 置 no-op 防旧直发路径误触。
  async function makeEnv() {
    const baseDir = await mkdtemp(join(tmpdir(), "otg-behavior-test-"));
    const root = join(baseDir, "project");
    const registry = new ProjectRegistryStore(join(baseDir, "projects.json"));
    // 模拟 monitor 自注册（周期 reassertRegistration 等价物）：root 条目必须存在，
    // 否则写入端按「未注册项目」跳过写盘。
    await registry.mutate((reg) => registerProject(reg, root));
    const monitor = new TelegramSessionMonitor(
      fakeClient,
      fakeConfig,
      root,
      registry,
    );
    monitor.enqueueMessage = async () => {};
    monitor.enqueueMessageWithKeyboard = async () => {};
    monitor.runTelegram = async () => {};
    monitor.scheduleRegistration = () => {};
    monitor.scheduleSelfUpdate = () => {};
    monitor.initialize();
    return { baseDir, root, registry, monitor };
  }

  // 从 registry 读 root 条目下的 session 记录（无 sessions 键 → 空数组）。
  async function readSessions(registry, root) {
    const reg = await registry.read();
    const entry = reg.projects.find((e) => e.path === root);
    return entry?.sessions ?? [];
  }

  async function runCase(name, fn) {
    total += 1;
    let env;
    try {
      env = await makeEnv();
      await fn(env);
      console.log(`ok   ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${name}: ${error.message}`);
    } finally {
      if (env) {
        await env.monitor.dispose().catch(() => undefined);
        await rm(env.baseDir, { recursive: true, force: true });
      }
    }
  }

  // API-001: auto-approve（permission.asked 随即 permission.replied）→ 0 条记录。
  // permission 走去抖窗口（WAITING_NOTIFY_DEBOUNCE_MS=1000），窗口内收到
  // replied（即被 auto-approve）→ cancelWaitingNotify 取消写入（零落盘）。
  await runCase(
    "API-001 auto-approve: permission.asked + immediate replied -> 0 persisted records",
    async ({ monitor, registry, root }) => {
      monitor.accept({
        id: "evt-001-1",
        type: "permission.asked",
        properties: { sessionID: "s-1", id: "perm-1", permission: "read" },
      });
      monitor.accept({
        id: "evt-001-2",
        type: "permission.replied",
        properties: { sessionID: "s-1", requestID: "perm-1" },
      });
      await sleep(2500); // 越过去抖窗口：若 cancel 生效则仍为 0 条
      const sessions = await readSessions(registry, root);
      if (sessions.length !== 0) {
        throw new Error(
          `expected 0 session records, got ${sessions.length}: ${JSON.stringify(sessions)}`,
        );
      }
    },
  );

  // API-002: 真待审批（仅 permission.asked，无 replied）→ 2.5s 后恰 1 条完整记录。
  await runCase(
    "API-002 pending permission: only asked -> exactly 1 complete record after debounce",
    async ({ monitor, registry, root }) => {
      monitor.accept({
        id: "evt-002-1",
        type: "permission.asked",
        properties: {
          sessionID: "s-1",
          id: "perm-2",
          permission: "read file",
          tool: { callID: "call-1", name: "bash" },
        },
      });
      await sleep(2500); // > WAITING_NOTIFY_DEBOUNCE_MS：去抖窗口过期后写盘
      const sessions = await readSessions(registry, root);
      if (sessions.length !== 1) {
        throw new Error(
          `expected exactly 1 record, got ${sessions.length}: ${JSON.stringify(sessions)}`,
        );
      }
      const rec = sessions[0];
      if (rec.type !== "permission") {
        throw new Error(`expected type=permission, got ${rec.type}`);
      }
      if (rec.send !== false) {
        throw new Error(`expected send=false, got ${rec.send}`);
      }
      if (rec.resolved !== false) {
        throw new Error(`expected resolved=false, got ${rec.resolved}`);
      }
      if (rec.request_id !== "perm-2") {
        throw new Error(`expected request_id=perm-2, got ${rec.request_id}`);
      }
      if (rec.session_id !== "s-1") {
        throw new Error(`expected session_id=s-1, got ${rec.session_id}`);
      }
      if (
        typeof rec.created_at !== "string" ||
        Number.isNaN(Date.parse(rec.created_at))
      ) {
        throw new Error(`created_at not an ISO timestamp: ${rec.created_at}`);
      }
      if (typeof rec.session_name !== "string" || rec.session_name.length === 0) {
        throw new Error(`session_name missing: ${JSON.stringify(rec.session_name)}`);
      }
      if (rec.session_name !== "Test session") {
        throw new Error(
          `session_name should come from ensureSessionInfo title, got ${JSON.stringify(rec.session_name)}`,
        );
      }
      // message = 完整事件 payload JSON：可还原解析且包含关键字段
      let payload;
      try {
        payload = JSON.parse(rec.message);
      } catch (error) {
        throw new Error(`message is not valid JSON: ${rec.message}`);
      }
      if (
        payload.permission !== "read file" ||
        payload.id !== "perm-2" ||
        payload.sessionID !== "s-1" ||
        payload.tool?.callID !== "call-1"
      ) {
        throw new Error(
          `message payload incomplete: ${JSON.stringify(payload)}`,
        );
      }
    },
  );

  // API-003: question.asked → 立即 1 条记录（不去抖），message=完整工具调用内容 JSON。
  await runCase(
    "API-003 question asked -> immediate persisted record (no debounce)",
    async ({ monitor, registry, root }) => {
      monitor.accept({
        id: "evt-003-1",
        type: "question.asked",
        properties: {
          sessionID: "s-1",
          id: "q-1",
          questions: [{ header: "Continue?", question: "Proceed with the plan?" }],
          tool: { callID: "call-2", name: "read" },
        },
      });
      // question 不走 1s 去抖：只需等异步写盘链（ensureSessionInfo + mutate I/O）完成
      await sleep(500);
      let sessions = await readSessions(registry, root);
      if (sessions.length !== 1) {
        throw new Error(
          `expected exactly 1 record right away, got ${sessions.length}: ${JSON.stringify(sessions)}`,
        );
      }
      const rec = sessions[0];
      if (rec.type !== "question") {
        throw new Error(`expected type=question, got ${rec.type}`);
      }
      if (rec.request_id !== "q-1") {
        throw new Error(`expected request_id=q-1, got ${rec.request_id}`);
      }
      const payload = JSON.parse(rec.message);
      if (
        payload.id !== "q-1" ||
        payload.questions?.[0]?.header !== "Continue?" ||
        payload.tool?.callID !== "call-2"
      ) {
        throw new Error(`message payload incomplete: ${JSON.stringify(payload)}`);
      }
      // 再等过 1s 去抖时长：不得产生第二条（不去抖且不重复）
      await sleep(2000);
      sessions = await readSessions(registry, root);
      if (sessions.length !== 1) {
        throw new Error(
          `expected still 1 record after debounce window, got ${sessions.length}`,
        );
      }
    },
  );

  // API-004a: 记录落盘后 permission.replied（标准 requestID 变体）→ 记录被删除
  // （Round 6 §16 supersede：终态 = 删除，不再是置 resolved=true）。
  await runCase(
    "API-004a permission.replied after persist -> record deleted",
    async ({ monitor, registry, root }) => {
      monitor.accept({
        id: "evt-004a-1",
        type: "permission.asked",
        properties: { sessionID: "s-1", id: "perm-4a", permission: "edit" },
      });
      await sleep(2500); // 落盘（去抖窗口已过）
      const before = await readSessions(registry, root);
      if (before.length !== 1 || before[0].resolved !== false) {
        throw new Error(`record should exist unresolved before replied`);
      }
      monitor.accept({
        id: "evt-004a-2",
        type: "permission.replied",
        properties: { sessionID: "s-1", requestID: "perm-4a" },
      });
      await sleep(400); // 删除 mutate 异步完成
      const after = await readSessions(registry, root);
      if (after.length !== 0) {
        throw new Error(
          `expected record deleted after replied, got ${after.length}: ${JSON.stringify(after)}`,
        );
      }
    },
  );

  // API-004b: permission.v2.replied 且 properties 只有 permissionID → 按 permissionID 提取匹配删除。
  await runCase(
    "API-004b permission.v2.replied with permissionID -> record deleted",
    async ({ monitor, registry, root }) => {
      monitor.accept({
        id: "evt-004b-1",
        type: "permission.asked",
        properties: { sessionID: "s-1", id: "perm-4b", permission: "write" },
      });
      await sleep(2500);
      monitor.accept({
        id: "evt-004b-2",
        type: "permission.v2.replied",
        properties: { sessionID: "s-1", permissionID: "perm-4b" },
      });
      await sleep(400);
      const after = await readSessions(registry, root);
      if (after.length !== 0) {
        throw new Error(
          `expected record deleted via permissionID, got ${JSON.stringify(after)}`,
        );
      }
    },
  );

  // API-004c: question.rejected 变体 → 立即落盘后删除记录。
  await runCase(
    "API-004c question.rejected after persist -> record deleted",
    async ({ monitor, registry, root }) => {
      monitor.accept({
        id: "evt-004c-1",
        type: "question.asked",
        properties: {
          sessionID: "s-1",
          id: "q-4c",
          questions: [{ header: "Reject me?" }],
        },
      });
      await sleep(500); // question 立即落盘
      const before = await readSessions(registry, root);
      if (before.length !== 1 || before[0].resolved !== false) {
        throw new Error(`record should exist unresolved before rejected`);
      }
      monitor.accept({
        id: "evt-004c-2",
        type: "question.rejected",
        properties: { sessionID: "s-1", requestID: "q-4c" },
      });
      await sleep(400);
      const after = await readSessions(registry, root);
      if (after.length !== 0) {
        throw new Error(
          `expected record deleted after question.rejected, got ${JSON.stringify(after)}`,
        );
      }
    },
  );

  // API-004d: question.v2.asked + question.v2.replied 变体 → 删除记录。
  await runCase(
    "API-004d question.v2 asked + v2.replied -> record deleted",
    async ({ monitor, registry, root }) => {
      monitor.accept({
        id: "evt-004d-1",
        type: "question.v2.asked",
        properties: {
          sessionID: "s-1",
          id: "q-4d",
          questions: [{ header: "V2 question?" }],
        },
      });
      await sleep(500);
      monitor.accept({
        id: "evt-004d-2",
        type: "question.v2.replied",
        properties: { sessionID: "s-1", requestID: "q-4d" },
      });
      await sleep(400);
      const after = await readSessions(registry, root);
      if (after.length !== 0) {
        throw new Error(
          `expected record deleted after question.v2.replied, got ${JSON.stringify(after)}`,
        );
      }
    },
  );

  // API-005: 短时多个 permission.asked（不同 request_id）→ 全部追加保留，互不覆盖。
  await runCase(
    "API-005 concurrent permissions (distinct request_ids) -> all appended",
    async ({ monitor, registry, root }) => {
      monitor.accept({
        id: "evt-005-1",
        type: "permission.asked",
        properties: { sessionID: "s-1", id: "perm-5a", permission: "read" },
      });
      monitor.accept({
        id: "evt-005-2",
        type: "permission.asked",
        properties: { sessionID: "s-1", id: "perm-5b", permission: "write" },
      });
      monitor.accept({
        id: "evt-005-3",
        type: "permission.asked",
        properties: { sessionID: "s-1", id: "perm-5c", permission: "delete" },
      });
      await sleep(2500);
      const sessions = await readSessions(registry, root);
      if (sessions.length !== 3) {
        throw new Error(
          `expected 3 records, got ${sessions.length}: ${JSON.stringify(sessions)}`,
        );
      }
      const ids = sessions.map((r) => r.request_id).sort();
      if (JSON.stringify(ids) !== JSON.stringify(["perm-5a", "perm-5b", "perm-5c"])) {
        throw new Error(`request_ids not all preserved: ${JSON.stringify(ids)}`);
      }
      if (sessions.some((r) => r.resolved !== false || r.send !== false)) {
        throw new Error(`all records must be pending (send=false, resolved=false)`);
      }
    },
  );

  // API-501: ESC abort（session.error + error.name=MessageAbortedError）→ 该
  // session 已落盘的等待记录被删除（契约 §16 path ②：服务端 abort 不发布
  // permission/question 终结事件，仅 session.error cancelled=true 可观测）。
  await runCase(
    "API-501 ESC abort deletes the persisted session records",
    async ({ monitor, registry, root }) => {
      monitor.accept({
        id: "evt-501-1",
        type: "permission.asked",
        properties: { sessionID: "s-501", id: "perm-501", permission: "read" },
      });
      await sleep(2500); // 落盘（去抖窗口已过）
      monitor.accept({
        id: "evt-501-2",
        type: "question.asked",
        properties: {
          sessionID: "s-501",
          id: "q-501",
          questions: [{ header: "Abort me?" }],
        },
      });
      await sleep(500); // question 立即落盘
      let sessions = await readSessions(registry, root);
      if (sessions.length !== 2) {
        throw new Error(
          `expected 2 records before abort, got ${sessions.length}: ${JSON.stringify(sessions)}`,
        );
      }
      monitor.accept({
        id: "evt-501-3",
        type: "session.error",
        properties: {
          sessionID: "s-501",
          error: { name: "MessageAbortedError" },
        },
      });
      await sleep(400); // cleanup mutate 异步完成
      sessions = await readSessions(registry, root);
      if (sessions.length !== 0) {
        throw new Error(
          `expected all records deleted after ESC abort, got ${sessions.length}: ${JSON.stringify(sessions)}`,
        );
      }
    },
  );

  // API-502: 去抖窗口内 ESC abort → permission 记录从未写入（timer 被取消），
  // question 记录同样删除。
  await runCase(
    "API-502 ESC abort within debounce window -> permission never written",
    async ({ monitor, registry, root }) => {
      monitor.accept({
        id: "evt-502-1",
        type: "permission.asked",
        properties: { sessionID: "s-502", id: "perm-502", permission: "read" },
      });
      // 立即 abort（< WAITING_NOTIFY_DEBOUNCE_MS=1000）：cancelWaitingNotify
      // 取消待写入 timer → 零落盘；cleanupSessionRecords 无记录可删（容忍）。
      monitor.accept({
        id: "evt-502-2",
        type: "session.error",
        properties: {
          sessionID: "s-502",
          error: { name: "MessageAbortedError" },
        },
      });
      await sleep(2500); // 越过去抖窗口：若 timer 未被取消则此处会写入
      const sessions = await readSessions(registry, root);
      if (sessions.length !== 0) {
        throw new Error(
          `expected 0 records (debounce cancelled by abort), got ${sessions.length}: ${JSON.stringify(sessions)}`,
        );
      }
    },
  );

  // API-503: session.deleted → 该 session 的全部落盘记录删除；其它 session
  // 的记录保留。
  await runCase(
    "API-503 session.deleted removes that session's persisted records",
    async ({ monitor, registry, root }) => {
      monitor.accept({
        id: "evt-503-1",
        type: "permission.asked",
        properties: { sessionID: "s-503a", id: "perm-503a", permission: "read" },
      });
      monitor.accept({
        id: "evt-503-2",
        type: "permission.asked",
        properties: { sessionID: "s-503b", id: "perm-503b", permission: "write" },
      });
      await sleep(2500); // 两条 permission 记录都落盘
      let sessions = await readSessions(registry, root);
      if (sessions.length !== 2) {
        throw new Error(
          `expected 2 records before delete, got ${sessions.length}`,
        );
      }
      // session.deleted 需要 info（session() 校验 id+title）。
      monitor.accept({
        id: "evt-503-3",
        type: "session.deleted",
        properties: {
          sessionID: "s-503a",
          info: { id: "s-503a", title: "Deleted session" },
        },
      });
      await sleep(400);
      sessions = await readSessions(registry, root);
      if (sessions.length !== 1 || sessions[0].request_id !== "perm-503b") {
        throw new Error(
          `expected only s-503b record to survive, got ${JSON.stringify(sessions)}`,
        );
      }
      // 残留记录收尾：删除（终端 ttl 兜底不依赖；直接清理避免影响其它用例）
      monitor.accept({
        id: "evt-503-4",
        type: "session.deleted",
        properties: {
          sessionID: "s-503b",
          info: { id: "s-503b", title: "Other session" },
        },
      });
      await sleep(400);
      sessions = await readSessions(registry, root);
      if (sessions.length !== 0) {
        throw new Error(
          `expected all records cleaned, got ${JSON.stringify(sessions)}`,
        );
      }
    },
  );

  const passed = total - failures;
  console.log(`\n${passed}/${total} cases passed`);
  // 显式退出：bootstrap 的 withTimeout 会遗留 8s 探活 timers，让事件循环
  // 空挂约 8s；先 flush stdout 再退出。
  await sleep(20);
  process.exit(failures === 0 ? 0 : 1);
  await sleep(20);
  process.exit(failures === 0 ? 0 : 1);
}

await main();