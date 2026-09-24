// tests/behavior.test.mjs
//
// v2 行为验证脚本（ticket 03，契约 docs/modules/opencode-v2-contract.md §2/§7）：
// 实例化 TelegramSessionMonitor，喂入**原始 v2 envelope**（`{id, created, type,
// data}`，accept 内部把 data 归一化为 properties），断言：
//   API-001 auto-approve（permission.asked + 1s 内 permission.replied）→ 0 条记录
//   API-002 真待审批（仅 asked，等 2.5s）→ 恰 1 条完整记录（v2 data 原样落盘）
//   API-004 permission.replied（窗口后）→ 按 request_id 删除记录
//   API-005 短时多个 permission.asked（不同 request_id）→ 全部追加保留
//   API-006 同 envelope id 重复投递 → 去重（只处理一次）
//   API-501 execution.interrupted（v2 取代 v1 session.error/ESC abort）→
//     去抖窗口内的 permission 不落盘 + 已落盘记录删除 + 终态 cancelled
//   API-503 session.deleted → 该 session 全部落盘记录删除
//   LIFECYCLE-001 execution.started/succeeded + step.* + tool.* + usage →
//     busy/idle 状态、工具投影、token 绝对聚合、终态 completed 通知
//   LIFECYCLE-002 execution.failed → 终态 failed（pendingError 驱动）
//   LIFECYCLE-003 step.failed 落 pendingError → 同轮 succeeded 仍判 failed
//   LIFECYCLE-REAL 真实 5s idle 去抖 → 终态 completed（端到端定时器路径）
//   GUARD-001 awaitingInput 未交付 steer → 推迟 idle 终态（§2.7）
//   USAGE-001 usage.updated 绝对赋值（后到覆盖，非累加）；cost null → hasCost=false
//
// question/form 事件映射与回写属 ticket 04（§2.6/§3.1），本文件不接线、不断言。
//
// 用法：
//   HOME=$(mktemp -d) bun tests/behavior.test.mjs     # 完整断言
//   bun tests/behavior.test.mjs --dry                 # 只检查可载入性
//
// 绝不使用真实 botToken/chatId；运行必须隔离 HOME 以避免写真实 ~/.otg。

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 事件处理链是异步的（accept → track(handleEvent)）；状态断言前让微任务/IO 落地。
const flush = () => sleep(30);

const srcMonitorURL = new URL("../src/monitor.ts", import.meta.url);
const srcRegistryURL = new URL("../src/registry/index.ts", import.meta.url);
const srcMonitorPath = fileURLToPath(srcMonitorURL);

const isDry = process.argv.includes("--dry");

async function dryCheck() {
  if (!existsSync(srcMonitorPath)) {
    console.log("[dry] tests/behavior.test.mjs: src/monitor.ts not merged yet");
    console.log("[dry] skipping behavioral assertions (expected during round A)");
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
  const { ProjectRegistryStore, registerProject, setProjectEnabled } =
    registryModule;

  // 契约 §7.1 冻结 fake v2 client：方法返回直接对象（非 {data} 包装）。
  function makeFakeClient() {
    const fakeClient = {
      app: { name: "cli", version: "2.0.15", channel: "latest" },
      location: {
        directory: "/tmp",
        workspaceID: undefined,
        project: { id: "proj-test", directory: "/tmp", canonical: "/tmp" },
      },
      event: { subscribe: async () => [] },
      permission: {
        reply: async ({ sessionID, requestID, decision, message }) => {
          fakeClient.replyCalls.push({ sessionID, requestID, decision, message });
          if (fakeClient.replyError) throw fakeClient.replyError;
        },
        list: async () => [],
        get: async ({ sessionID, requestID }) => ({
          id: requestID,
          sessionID,
          action: "shell",
          resources: [],
        }),
      },
      session: {
        get: async ({ sessionID }) => ({
          id: sessionID,
          projectID: "proj-test",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
          title: "Test session",
          location: { directory: "/tmp" },
        }),
        create: async ({ title }) => ({ id: "ses-test", title }),
        context: async () => [],
      },
      replyCalls: [],
      replyError: undefined,
    };
    return fakeClient;
  }

  // 假配置（字面值）；绝不真发。
  const fakeConfig = {
    botToken: "123456789:TESTTOKEN_DO_NOT_USE_abcdefg",
    chatId: "123",
  };

  let eventSeq = 0;
  // 原始 v2 envelope（§2.0）：accept() 原样收，parseRuntimeEvent 取 data。
  function envelope(type, data, id) {
    eventSeq += 1;
    return {
      id: id ?? `evt-behavior-${eventSeq}`,
      created: Date.now(),
      type,
      data,
    };
  }

  let failures = 0;
  let total = 0;

  // 每用例独立环境：独立临时目录 + registry 文件 + monitor（sessions 互不污染）。
  // 打桩：runTelegram/scheduleRegistration/scheduleSelfUpdate 置 no-op，
  // 避免真实网络轮询/注册/自更新；enqueueMessage 收集通知文本。
  async function makeEnv() {
    const baseDir = await mkdtemp(join(tmpdir(), "otg-behavior-test-"));
    const root = join(baseDir, "project");
    const registry = new ProjectRegistryStore(join(baseDir, "projects.json"));
    // 模拟 monitor 自注册（周期 reassertRegistration 等价物）：root 条目必须存在，
    // 否则写入端按「未注册项目」跳过写盘；enabled=true 让终态通知路径可达。
    await registry.mutate((reg) => registerProject(reg, root));
    await registry.mutate((reg) => setProjectEnabled(reg, root, true));
    const fakeClient = makeFakeClient();
    const sent = [];
    const monitor = new TelegramSessionMonitor(
      fakeClient,
      fakeConfig,
      root,
      registry,
    );
    monitor.enqueueMessage = (text) => {
      sent.push(text);
    };
    monitor.enqueueMessageWithKeyboard = async () => {};
    monitor.runTelegram = async () => {};
    monitor.scheduleRegistration = () => {};
    monitor.scheduleSelfUpdate = () => {};
    monitor.initialize();
    return { baseDir, root, registry, monitor, sent, fakeClient };
  }

  // 从 registry 读 root 条目下的 session 记录（无 sessions 键 → 空数组）。
  async function readSessions(registry, root) {
    const reg = await registry.read();
    const entry = reg.projects.find((e) => e.path === root);
    return entry?.sessions ?? [];
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message);
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
  await runCase(
    "API-001 auto-approve: permission.asked + immediate replied -> 0 persisted records",
    async ({ monitor, registry, root }) => {
      monitor.accept(
        envelope(
          "permission.asked",
          { sessionID: "s-1", id: "perm-1", action: "read", resources: ["*"] },
          "evt-001-1",
        ),
      );
      monitor.accept(
        envelope(
          "permission.replied",
          { sessionID: "s-1", requestID: "perm-1", reply: "once" },
          "evt-001-2",
        ),
      );
      await sleep(2500); // 越过去抖窗口：若 cancel 生效则仍为 0 条
      const sessions = await readSessions(registry, root);
      assert(
        sessions.length === 0,
        `expected 0 session records, got ${sessions.length}: ${JSON.stringify(sessions)}`,
      );
    },
  );

  // API-002: 真待审批（仅 permission.asked，无 replied）→ 2.5s 后恰 1 条完整记录。
  await runCase(
    "API-002 pending permission: only asked -> exactly 1 complete record after debounce",
    async ({ monitor, registry, root }) => {
      monitor.accept(
        envelope(
          "permission.asked",
          {
            sessionID: "s-1",
            id: "perm-2",
            action: "read file",
            resources: ["src/**"],
            save: ["echo *"],
            source: { type: "tool", messageID: "msg-1", id: "call-1" },
          },
          "evt-002-1",
        ),
      );
      await sleep(2500); // > WAITING_NOTIFY_DEBOUNCE_MS：去抖窗口过期后写盘
      const sessions = await readSessions(registry, root);
      assert(
        sessions.length === 1,
        `expected exactly 1 record, got ${sessions.length}: ${JSON.stringify(sessions)}`,
      );
      const rec = sessions[0];
      assert(rec.type === "permission", `expected type=permission, got ${rec.type}`);
      assert(rec.send === false, `expected send=false, got ${rec.send}`);
      assert(rec.resolved === false, `expected resolved=false, got ${rec.resolved}`);
      assert(
        rec.request_id === "perm-2",
        `expected request_id=perm-2, got ${rec.request_id}`,
      );
      assert(rec.session_id === "s-1", `expected session_id=s-1, got ${rec.session_id}`);
      assert(
        typeof rec.created_at === "string" && !Number.isNaN(Date.parse(rec.created_at)),
        `created_at not an ISO timestamp: ${rec.created_at}`,
      );
      assert(
        rec.session_name === "Test session",
        `session_name should come from session.get title, got ${JSON.stringify(rec.session_name)}`,
      );
      // message = 完整 v2 data payload JSON（原样落盘，供消费端渲染）
      const payload = JSON.parse(rec.message);
      assert(
        payload.action === "read file" &&
          payload.id === "perm-2" &&
          payload.sessionID === "s-1" &&
          payload.resources?.[0] === "src/**" &&
          payload.source?.id === "call-1",
        `message payload incomplete: ${JSON.stringify(payload)}`,
      );
    },
  );

  // API-004: 记录落盘后 permission.replied → 记录被删除（终态 = 删除）。
  await runCase(
    "API-004 permission.replied after persist -> record deleted",
    async ({ monitor, registry, root }) => {
      monitor.accept(
        envelope(
          "permission.asked",
          { sessionID: "s-1", id: "perm-4", action: "edit" },
          "evt-004-1",
        ),
      );
      await sleep(2500); // 落盘（去抖窗口已过）
      const before = await readSessions(registry, root);
      assert(
        before.length === 1 && before[0].resolved === false,
        "record should exist unresolved before replied",
      );
      monitor.accept(
        envelope(
          "permission.replied",
          { sessionID: "s-1", requestID: "perm-4", reply: "reject" },
          "evt-004-2",
        ),
      );
      await sleep(400); // 删除 mutate 异步完成
      const after = await readSessions(registry, root);
      assert(
        after.length === 0,
        `expected record deleted after replied, got ${after.length}: ${JSON.stringify(after)}`,
      );
    },
  );

  // API-005: 短时多个 permission.asked（不同 request_id）→ 全部追加保留，互不覆盖。
  await runCase(
    "API-005 concurrent permissions (distinct request_ids) -> all appended",
    async ({ monitor, registry, root }) => {
      for (const [index, requestID] of ["perm-5a", "perm-5b", "perm-5c"].entries()) {
        monitor.accept(
          envelope(
            "permission.asked",
            { sessionID: "s-1", id: requestID, action: "read" },
            `evt-005-${index}`,
          ),
        );
      }
      await sleep(2500);
      const sessions = await readSessions(registry, root);
      assert(
        sessions.length === 3,
        `expected 3 records, got ${sessions.length}: ${JSON.stringify(sessions)}`,
      );
      const ids = sessions.map((r) => r.request_id).sort();
      assert(
        JSON.stringify(ids) === JSON.stringify(["perm-5a", "perm-5b", "perm-5c"]),
        `request_ids not all preserved: ${JSON.stringify(ids)}`,
      );
      assert(
        sessions.every((r) => r.resolved === false && r.send === false),
        "all records must be pending (send=false, resolved=false)",
      );
    },
  );

  // API-006: 同 envelope id 重复投递 → rememberEvent 去重，只处理一次。
  await runCase(
    "API-006 duplicate envelope id -> deduplicated (single record)",
    async ({ monitor, registry, root }) => {
      const duplicate = envelope(
        "permission.asked",
        { sessionID: "s-6", id: "perm-6", action: "read" },
        "evt-006-1",
      );
      monitor.accept(duplicate);
      monitor.accept(duplicate);
      await sleep(2500);
      const sessions = await readSessions(registry, root);
      assert(
        sessions.length === 1,
        `expected 1 record after duplicate delivery, got ${sessions.length}`,
      );
    },
  );

  // API-501: execution.interrupted（v2 取代 v1 session.error ESC abort）→
  // 去抖窗口内的 permission 不落盘、pendingError.cancelled=true、终态 cancelled。
  await runCase(
    "API-501 execution.interrupted cancels pending notify and commits cancelled",
    async ({ monitor, registry, root }) => {
      monitor.accept(
        envelope("session.execution.started", { sessionID: "s-501" }, "evt-501-1"),
      );
      monitor.accept(
        envelope(
          "permission.asked",
          { sessionID: "s-501", id: "perm-501", action: "read" },
          "evt-501-2",
        ),
      );
      // 立即中断（< WAITING_NOTIFY_DEBOUNCE_MS=1000）：cancelWaitingNotify
      // 取消待写入 timer → 零落盘。
      monitor.accept(
        envelope(
          "session.execution.interrupted",
          { sessionID: "s-501", reason: "user" },
          "evt-501-3",
        ),
      );
      await sleep(2500); // 越过去抖窗口：若 timer 未被取消则此处会写入
      const sessions = await readSessions(registry, root);
      assert(
        sessions.length === 0,
        `expected 0 records (debounce cancelled by interrupt), got ${sessions.length}`,
      );
      const projection = monitor.sessions.get("s-501");
      assert(
        projection?.pendingError?.cancelled === true,
        `expected pendingError.cancelled=true, got ${JSON.stringify(projection?.pendingError)}`,
      );
      assert(projection.status === "idle", `expected idle, got ${projection.status}`);
      await monitor.finalizeIdle("s-501", projection.turn);
      assert(
        projection.outcome === "cancelled",
        `expected outcome cancelled, got ${projection.outcome}`,
      );
    },
  );

  // API-502: 已落盘的 permission 记录在 execution.interrupted 后被删除。
  await runCase(
    "API-502 execution.interrupted removes already persisted session records",
    async ({ monitor, registry, root }) => {
      monitor.accept(
        envelope(
          "permission.asked",
          { sessionID: "s-502", id: "perm-502", action: "read" },
          "evt-502-1",
        ),
      );
      await sleep(2500); // 落盘（去抖窗口已过）
      const before = await readSessions(registry, root);
      assert(before.length === 1, `expected 1 record before interrupt, got ${before.length}`);
      monitor.accept(
        envelope(
          "session.execution.interrupted",
          { sessionID: "s-502", reason: "user" },
          "evt-502-2",
        ),
      );
      await sleep(400); // cleanup mutate 异步完成
      const after = await readSessions(registry, root);
      assert(
        after.length === 0,
        `expected all records deleted after interrupt, got ${after.length}`,
      );
    },
  );

  // API-503: session.deleted（v2 data 仅 sessionID）→ 该 session 全部记录删除；
  // 其它 session 的记录保留。
  await runCase(
    "API-503 session.deleted removes that session's persisted records",
    async ({ monitor, registry, root }) => {
      monitor.accept(
        envelope(
          "permission.asked",
          { sessionID: "s-503a", id: "perm-503a", action: "read" },
          "evt-503-1",
        ),
      );
      monitor.accept(
        envelope(
          "permission.asked",
          { sessionID: "s-503b", id: "perm-503b", action: "write" },
          "evt-503-2",
        ),
      );
      await sleep(2500); // 两条 permission 记录都落盘
      let sessions = await readSessions(registry, root);
      assert(sessions.length === 2, `expected 2 records before delete, got ${sessions.length}`);
      monitor.accept(
        envelope("session.deleted", { sessionID: "s-503a" }, "evt-503-3"),
      );
      await sleep(400);
      sessions = await readSessions(registry, root);
      assert(
        sessions.length === 1 && sessions[0].request_id === "perm-503b",
        `expected only s-503b record to survive, got ${JSON.stringify(sessions)}`,
      );
      monitor.accept(
        envelope("session.deleted", { sessionID: "s-503b" }, "evt-503-4"),
      );
      await sleep(400);
      sessions = await readSessions(registry, root);
      assert(sessions.length === 0, `expected all records cleaned, got ${JSON.stringify(sessions)}`);
    },
  );

  // LIFECYCLE-001: execution.started/succeeded + step/tool/usage 全链路 →
  // busy/idle、turn=1、工具投影、token 绝对聚合、终态 completed + 通知。
  await runCase(
    "LIFECYCLE-001 busy/idle + step/tool/usage projection + completed outcome",
    async ({ monitor, sent }) => {
      const id = "s-l1";
      monitor.accept(envelope("session.execution.started", { sessionID: id }, "evt-l1-1"));
      await flush();
      let projection = monitor.sessions.get(id);
      assert(projection.status === "busy", `expected busy, got ${projection.status}`);
      assert(projection.turn === 1, `expected turn=1, got ${projection.turn}`);

      monitor.accept(
        envelope(
          "session.step.started",
          { sessionID: id, assistantMessageID: "msg-l1", agent: "build", model: { id: "m", providerID: "p" }, started: Date.now() },
          "evt-l1-2",
        ),
      );
      monitor.accept(
        envelope(
          "session.tool.input.started",
          { sessionID: id, assistantMessageID: "msg-l1", id: "call-l1", name: "bash" },
          "evt-l1-3",
        ),
      );
      monitor.accept(
        envelope(
          "session.tool.input.ended",
          { sessionID: id, assistantMessageID: "msg-l1", id: "call-l1", text: '{"command":"echo hi"}' },
          "evt-l1-4",
        ),
      );
      await flush();
      projection = monitor.sessions.get(id);
      assert(
        projection.currentAssistantMessageID === "msg-l1",
        `expected currentAssistantMessageID=msg-l1, got ${projection.currentAssistantMessageID}`,
      );
      assert(projection.agent === "build", `expected agent=build, got ${projection.agent}`);
      let tool = projection.toolsByCallID.get("call-l1");
      assert(tool?.state === "pending", `expected tool pending, got ${tool?.state}`);
      assert(tool?.tool === "bash", `expected tool=bash, got ${tool?.tool}`);
      assert(
        tool?.target === "command: echo",
        `expected target "command: echo", got ${JSON.stringify(tool?.target)}`,
      );

      monitor.accept(
        envelope(
          "session.tool.called",
          { sessionID: id, assistantMessageID: "msg-l1", id: "call-l1", input: { command: "echo hi" }, executed: false },
          "evt-l1-5",
        ),
      );
      monitor.accept(
        envelope(
          "session.tool.progress",
          { sessionID: id, assistantMessageID: "msg-l1", id: "call-l1", metadata: { shellID: "sh_l1" } },
          "evt-l1-6",
        ),
      );
      await flush();
      tool = monitor.sessions.get(id).toolsByCallID.get("call-l1");
      assert(tool?.state === "running", `expected tool running, got ${tool?.state}`);
      assert(tool?.progress === "sh_l1", `expected progress sh_l1, got ${tool?.progress}`);

      monitor.accept(
        envelope(
          "session.tool.success",
          {
            sessionID: id,
            assistantMessageID: "msg-l1",
            id: "call-l1",
            content: [{ type: "text", text: "hi" }],
            metadata: { status: "completed", truncated: false, exit: 0 },
            executed: false,
          },
          "evt-l1-7",
        ),
      );
      // usage.updated：绝对聚合值
      monitor.accept(
        envelope(
          "session.usage.updated",
          {
            sessionID: id,
            cost: 0.0123,
            tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 7, write: 3 } },
          },
          "evt-l1-8",
        ),
      );
      await flush();
      projection = monitor.sessions.get(id);
      assert(
        projection.toolsByCallID.get("call-l1")?.state === "completed",
        "expected tool completed after success",
      );
      assert(
        projection.tokens.input === 100 &&
          projection.tokens.output === 20 &&
          projection.tokens.reasoning === 5 &&
          projection.tokens.cacheRead === 7 &&
          projection.tokens.cacheWrite === 3 &&
          projection.tokens.cost === 0.0123 &&
          projection.tokens.hasCost === true,
        `usage.updated mapping wrong: ${JSON.stringify(projection.tokens)}`,
      );

      // step.ended：同款绝对聚合值覆盖（非累加）
      monitor.accept(
        envelope(
          "session.step.ended",
          {
            sessionID: id,
            assistantMessageID: "msg-l1",
            finish: "stop",
            rawFinish: "stop",
            cost: 0.05,
            tokens: { input: 200, output: 30, reasoning: 6, cache: { read: 8, write: 4 } },
          },
          "evt-l1-9",
        ),
      );
      await flush();
      projection = monitor.sessions.get(id);
      assert(
        projection.tokens.input === 200 && projection.tokens.cost === 0.05,
        `step.ended must overwrite (absolute), got ${JSON.stringify(projection.tokens)}`,
      );

      monitor.accept(envelope("session.execution.succeeded", { sessionID: id }, "evt-l1-10"));
      await flush();
      projection = monitor.sessions.get(id);
      assert(projection.status === "idle", `expected idle, got ${projection.status}`);
      assert(projection.idleTimer !== undefined, "expected idle debounce timer scheduled");

      await monitor.finalizeIdle(id, projection.turn);
      assert(
        projection.outcome === "completed",
        `expected completed, got ${projection.outcome}`,
      );
      assert(projection.observedRunning === false, "expected observedRunning=false after finalize");
      const notification = sent[sent.length - 1] ?? "";
      assert(notification.includes("✅"), `terminal notification missing ✅: ${notification}`);
      assert(notification.includes("200"), `terminal notification missing token total: ${notification}`);
      assert(notification.includes("Cost"), `terminal notification missing cost row: ${notification}`);
    },
  );

  // LIFECYCLE-002: execution.failed → pendingError 驱动终态 failed + ❌ 通知。
  await runCase(
    "LIFECYCLE-002 execution.failed -> pendingError -> failed outcome",
    async ({ monitor, sent }) => {
      const id = "s-l2";
      monitor.accept(envelope("session.execution.started", { sessionID: id }, "evt-l2-1"));
      monitor.accept(
        envelope(
          "session.step.started",
          { sessionID: id, assistantMessageID: "msg-l2", agent: "build" },
          "evt-l2-2",
        ),
      );
      monitor.accept(
        envelope(
          "session.execution.failed",
          { sessionID: id, error: { type: "provider.no-route", message: "Model unavailable: nope" } },
          "evt-l2-3",
        ),
      );
      await flush();
      const projection = monitor.sessions.get(id);
      assert(
        projection.pendingError?.name === "provider.no-route",
        `expected pendingError name provider.no-route, got ${JSON.stringify(projection.pendingError)}`,
      );
      assert(projection.status === "idle", `expected idle, got ${projection.status}`);
      await monitor.finalizeIdle(id, projection.turn);
      assert(projection.outcome === "failed", `expected failed, got ${projection.outcome}`);
      const notification = sent[sent.length - 1] ?? "";
      assert(notification.includes("❌"), `terminal notification missing ❌: ${notification}`);
      assert(
        notification.includes("provider.no-route"),
        `terminal notification missing error name: ${notification}`,
      );
    },
  );

  // LIFECYCLE-003: step.failed 落 pendingError → 同轮 execution.succeeded 仍判 failed
  // （§2.1 冻结：step.failed 的 error 参与终态判定）。
  await runCase(
    "LIFECYCLE-003 step.failed error feeds the terminal outcome",
    async ({ monitor }) => {
      const id = "s-l3";
      monitor.accept(envelope("session.execution.started", { sessionID: id }, "evt-l3-1"));
      monitor.accept(
        envelope(
          "session.step.started",
          { sessionID: id, assistantMessageID: "msg-l3", agent: "build" },
          "evt-l3-2",
        ),
      );
      monitor.accept(
        envelope(
          "session.step.failed",
          { sessionID: id, assistantMessageID: "msg-l3", error: { type: "step.broken" } },
          "evt-l3-3",
        ),
      );
      monitor.accept(envelope("session.execution.succeeded", { sessionID: id }, "evt-l3-4"));
      await flush();
      const projection = monitor.sessions.get(id);
      await monitor.finalizeIdle(id, projection.turn);
      assert(
        projection.outcome === "failed",
        `expected failed from step.failed pendingError, got ${projection.outcome}`,
      );
    },
  );

  // LIFECYCLE-REAL: 真实 idle 去抖定时器（5s）→ 终态 completed（端到端路径）。
  await runCase(
    "LIFECYCLE-REAL idle debounce timer commits completed end-to-end",
    async ({ monitor }) => {
      const id = "s-lr";
      monitor.accept(envelope("session.execution.started", { sessionID: id }, "evt-lr-1"));
      monitor.accept(
        envelope(
          "session.step.started",
          { sessionID: id, assistantMessageID: "msg-lr", agent: "build" },
          "evt-lr-2",
        ),
      );
      monitor.accept(envelope("session.execution.succeeded", { sessionID: id }, "evt-lr-3"));
      await sleep(5600); // > IDLE_DEBOUNCE_MS=5000
      const projection = monitor.sessions.get(id);
      assert(
        projection.outcome === "completed",
        `expected completed after real debounce, got ${projection.outcome}`,
      );
      assert(projection.observedRunning === false, "expected observedRunning=false");
    },
  );

  // GUARD-001: awaitingInput（未交付 steer，§2.7）推迟 idle 终态；清标记后恢复。
  await runCase(
    "GUARD-001 awaitingInput postpones idle finalization",
    async ({ monitor }) => {
      const id = "s-g1";
      monitor.accept(envelope("session.execution.started", { sessionID: id }, "evt-g1-1"));
      monitor.accept(
        envelope(
          "session.step.started",
          { sessionID: id, assistantMessageID: "msg-g1", agent: "build" },
          "evt-g1-2",
        ),
      );
      monitor.accept(envelope("session.execution.succeeded", { sessionID: id }, "evt-g1-3"));
      await flush();
      const projection = monitor.sessions.get(id);
      projection.awaitingInput = true;
      await monitor.finalizeIdle(id, projection.turn);
      assert(
        projection.outcome === undefined,
        `expected no outcome while awaitingInput, got ${projection.outcome}`,
      );
      projection.awaitingInput = false;
      await monitor.finalizeIdle(id, projection.turn);
      assert(
        projection.outcome === "completed",
        `expected completed after awaitingInput cleared, got ${projection.outcome}`,
      );
    },
  );

  // USAGE-001: cost null → hasCost=false（绝对赋值语义）。
  await runCase(
    "USAGE-001 usage.updated absolute assignment and null cost -> hasCost=false",
    async ({ monitor }) => {
      const id = "s-u1";
      monitor.accept(
        envelope(
          "session.usage.updated",
          {
            sessionID: id,
            cost: null,
            tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
          },
          "evt-u1-1",
        ),
      );
      await flush();
      const tokens = monitor.sessions.get(id).tokens;
      assert(
        tokens.input === 1 &&
          tokens.output === 2 &&
          tokens.reasoning === 3 &&
          tokens.cacheRead === 4 &&
          tokens.cacheWrite === 5 &&
          tokens.hasCost === false &&
          tokens.cost === 0,
        `null-cost mapping wrong: ${JSON.stringify(tokens)}`,
      );
    },
  );

  const passed = total - failures;
  console.log(`\n${passed}/${total} cases passed`);
  // 显式退出：startReplyScan 的 1s interval 与 idle 定时器由 dispose 清理；
  // 先 flush stdout 再退出。
  await sleep(20);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
