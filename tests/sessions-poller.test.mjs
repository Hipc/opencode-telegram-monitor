// tests/sessions-poller.test.mjs
//
// API-006：poller 每秒扫描发送（Phase 1.3，契约 docs/modules/sessions-relay.md §8）。
// 语义冻结（决策 #6/#8/#9 + 契约 §6）：
// - 扫描条件 send === false && resolved === false；resolved 终态不补发；
// - 发送成功才置 send=true（markSessionSent）；失败保留 send=false 下轮重试；
// - 消息格式复用等待通知样式：⚠️/❓ 标题 + Type/Session 字段表 + message 节选。
//
// 手法（参照 tests/behavior.test.mjs）：不依赖真实 interval 时钟——构造
// TelegramSessionMonitor 后 stub sendMessage（.mjs 无类型检查可访问私有方法），
// 直接调用 scanSessionQueue()（契约 §6.3 可测试入口）驱动一轮扫描。
//
// 用法：
//   HOME=$(mktemp -d) bun tests/sessions-poller.test.mjs
//
// 绝不使用真实 botToken/chatId；运行必须隔离 HOME 以避免写真实 ~/.otg。

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 契约 §8 动态 import：src/monitor.ts（main 已合入 Phase 1.1，必须存在）。
const srcMonitorURL = new URL("../src/monitor.ts", import.meta.url);
const srcRegistryURL = new URL("../src/registry/index.ts", import.meta.url);
const srcMonitorPath = fileURLToPath(srcMonitorURL);

async function main() {
  if (!existsSync(srcMonitorPath)) {
    console.error(
      "src/monitor.ts not merged yet; cannot run sessions-poller tests",
    );
    process.exit(1);
  }

  const { TelegramSessionMonitor } = await import(srcMonitorURL.href);
  const registryModule = await import(srcRegistryURL.href);
  const { ProjectRegistryStore } = registryModule;
  const { appendSessionRecord, markSessionResolved, registerProject } =
    registryModule;

  // fake client 最小面：scanSessionQueue 只经 sendMessage（被 stub）与
  // this.log（client.app.log）交互；bootstrap 不会被调用（不调 initialize()）。
  // Phase 1.3（API-103/104）：追加 permission reply API stub —— 测试经
  // replyCalls 断言透传、replyError 控制成功/失败（方法名/参数形状以本机 SDK
  // 核验为准：client.postSessionIdPermissionsPermissionId({ path: { id,
  // permissionID }, body: { response } })，契约 §13.8）。
  const fakeClient = {
    app: { log: async () => {} },
    session: {
      list: async () => ({ data: [] }),
      status: async () => ({ data: {} }),
      get: async ({ path }) => ({ data: { id: path.id, title: "Test session" } }),
    },
    postSessionIdPermissionsPermissionId: async (options) => {
      fakeClient.replyCalls.push({
        id: options?.path?.id,
        permissionID: options?.path?.permissionID,
        response: options?.body?.response,
      });
      if (fakeClient.replyError) throw fakeClient.replyError;
      return { data: true };
    },
    replyCalls: [],
    replyError: undefined,
  };

  // 假配置（字面值）；绝不真发。
  const fakeConfig = {
    botToken: "123456789:TESTTOKEN_DO_NOT_USE_abcdefg",
    chatId: "123",
  };

  const baseDir = await mkdtemp(join(tmpdir(), "otg-poller-test-"));
  const root = join(baseDir, "project");
  const registry = new ProjectRegistryStore(join(baseDir, "projects.json"));
  // 写入端按 path===root 追加记录，这里只须保证条目存在（enabled 与扫描无关）。
  await registry.mutate((reg) => registerProject(reg, root));

  let failures = 0;
  let total = 0;

  async function runCase(name, fn) {
    total += 1;
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${name}: ${error.message}`);
    }
  }

  // 构造 monitor 并把私有发送入口替换为 stub；不调 initialize()，
  // 避免真实网络轮询/注册/自更新副作用。
  function makeMonitor(sendStub) {
    const monitor = new TelegramSessionMonitor(
      fakeClient,
      fakeConfig,
      root,
      registry,
    );
    monitor.sendMessage = sendStub;
    return monitor;
  }

  function makeRecord(overrides = {}) {
    return {
      session_id: "ses_testp0001",
      session_name: "Test session",
      type: "permission",
      message: JSON.stringify({
        permission: "read file",
        tool: "read",
      }),
      send: false,
      resolved: false,
      request_id: "req-1",
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  async function findRecord(requestID) {
    const reg = await registry.read();
    for (const entry of reg.projects) {
      for (const session of entry.sessions ?? []) {
        if (session.request_id === requestID) return session;
      }
    }
    return undefined;
  }

  // API-006-1：send=false && resolved=false → 发送恰 1 次（格式含 ⚠️/
  // Type/Session/message 节选）→ 置位 send=true。
  await runCase(
    "API-006-1 pending permission -> sent once with ⚠️/Session/excerpt, then send=true",
    async () => {
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({ request_id: "req-p1" }),
        ),
      );
      const sent = [];
      const monitor = makeMonitor(async (text) => {
        sent.push(text);
      });
      const handled = await monitor.scanSessionQueue();
      if (handled !== 1) {
        throw new Error(`expected 1 handled, got ${handled}`);
      }
      if (sent.length !== 1) {
        throw new Error(`expected 1 send, got ${sent.length}`);
      }
      const text = sent[0];
      if (!text.includes("⚠️")) {
        throw new Error(`missing ⚠️ title line: ${text}`);
      }
      if (!text.includes("Type") || !text.includes("Session")) {
        throw new Error(`missing Type/Session table fields: ${text}`);
      }
      if (!text.includes("read file")) {
        throw new Error(`missing message excerpt: ${text}`);
      }
      const persisted = await findRecord("req-p1");
      if (!persisted || persisted.send !== true) {
        throw new Error(
          `send not set to true after successful send: ${JSON.stringify(persisted)}`,
        );
      }
      await monitor.dispose();
    },
  );

  // API-006-2：发送失败（stub 抛错）→ send 保持 false；下一轮扫描重试成功。
  await runCase(
    "API-006-2 send failure keeps send=false; next scan retries to success",
    async () => {
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({ request_id: "req-p2" }),
        ),
      );
      let calls = 0;
      const monitor = makeMonitor(async () => {
        calls += 1;
        if (calls === 1) throw new Error("telegram send boom");
      });
      const first = await monitor.scanSessionQueue();
      if (first !== 0) {
        throw new Error(`expected 0 handled on failure, got ${first}`);
      }
      if (calls !== 1) {
        throw new Error(`expected 1 send attempt, got ${calls}`);
      }
      let persisted = await findRecord("req-p2");
      if (!persisted || persisted.send !== false) {
        throw new Error(
          `send must stay false after failed send: ${JSON.stringify(persisted)}`,
        );
      }
      const second = await monitor.scanSessionQueue();
      if (second !== 1) {
        throw new Error(`expected 1 handled on retry, got ${second}`);
      }
      if (calls !== 2) {
        throw new Error(`expected 2 send attempts total, got ${calls}`);
      }
      persisted = await findRecord("req-p2");
      if (!persisted || persisted.send !== true) {
        throw new Error(
          `send not true after retry success: ${JSON.stringify(persisted)}`,
        );
      }
      await monitor.dispose();
    },
  );

  // ---- API-103/104: reply apply loop (phase 1.3) ----
  // 契约 docs/modules/sessions-relay.md §13.6/§13.9：消费端扫描器直接驱动
  // scanReplyQueue()（不真实起轮询），stub reply API 断言透传与置位。
  // API-103：reply 记录被应用（sessionID/requestID/response 透传正确）→
  // resolved=true；reply=null 或已 resolved 的记录不触发调用。
  await runCase(
    "API-103 reply apply passes sessionID/requestID/response, sets resolved=true, skips reply=null and already-resolved",
    async () => {
      fakeClient.replyCalls = [];
      fakeClient.replyError = undefined;
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({ request_id: "req-r1", reply: "once" }),
        ),
      );
      // reply=null（显式未回复）与已 resolved 的记录：均不触发调用。
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({ request_id: "req-r2", reply: null }),
        ),
      );
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({ request_id: "req-r3", reply: "always", resolved: true }),
        ),
      );
      const monitor = makeMonitor(async () => {});
      const applied = await monitor.scanReplyQueue();
      if (applied !== 1) {
        throw new Error(`expected 1 applied, got ${applied}`);
      }
      if (fakeClient.replyCalls.length !== 1) {
        throw new Error(
          `expected exactly 1 reply API call, got ${fakeClient.replyCalls.length}`,
        );
      }
      const call = fakeClient.replyCalls[0];
      if (call.id !== "ses_testp0001") {
        throw new Error(`sessionID mismatch: ${call.id}`);
      }
      if (call.permissionID !== "req-r1") {
        throw new Error(`requestID mismatch: ${call.permissionID}`);
      }
      if (call.response !== "once") {
        throw new Error(`response mismatch: ${call.response}`);
      }
      const persisted = await findRecord("req-r1");
      if (!persisted || persisted.resolved !== true) {
        throw new Error(
          `resolved not true after successful apply: ${JSON.stringify(persisted)}`,
        );
      }
      const r2 = await findRecord("req-r2");
      if (!r2 || r2.resolved !== false) {
        throw new Error(
          `reply=null record must stay unresolved: ${JSON.stringify(r2)}`,
        );
      }
      const r3 = await findRecord("req-r3");
      if (!r3 || r3.resolved !== true) {
        throw new Error(
          `already-resolved record state must not change: ${JSON.stringify(r3)}`,
        );
      }
      // 用例终态（契约 §13.9）：req-r2 是 reply=null 且未 resolved 的记录，
      // 不能被扫描器消费；但需显式置 resolved，避免遗留 send=false &&
      // resolved=false 的记录污染后续 scanSessionQueue 用例计数。
      await registry.mutate((reg) => markSessionResolved(reg, "req-r2"));
      await monitor.dispose();
    },
  );

  // API-104：① apply 失败 → resolved 保持 false，下轮 ticker 重试成功；
  // ② 记录先被 replied 事件路径（markSessionResolved）置 resolved → 扫描器
  // 跳过不调 API（双路径，决策 #6）。
  await runCase(
    "API-104 apply failure keeps resolved=false and retries to success; TUI-resolved record is skipped",
    async () => {
      fakeClient.replyCalls = [];
      // ① 首轮 apply 失败（stub 抛错，如 permission 已被 TUI 处理）→ 不置位。
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({ request_id: "req-r4", reply: "reject" }),
        ),
      );
      fakeClient.replyError = new Error("permission already decided (404)");
      const monitor = makeMonitor(async () => {});
      const first = await monitor.scanReplyQueue();
      if (first !== 0) {
        throw new Error(`expected 0 applied on failure, got ${first}`);
      }
      let persisted = await findRecord("req-r4");
      if (!persisted || persisted.resolved !== false) {
        throw new Error(
          `resolved must stay false after failed apply: ${JSON.stringify(persisted)}`,
        );
      }
      // 下轮重试：stub 恢复成功 → resolved=true。
      fakeClient.replyError = undefined;
      const second = await monitor.scanReplyQueue();
      if (second !== 1) {
        throw new Error(`expected 1 applied on retry, got ${second}`);
      }
      persisted = await findRecord("req-r4");
      if (!persisted || persisted.resolved !== true) {
        throw new Error(
          `resolved not true after retry success: ${JSON.stringify(persisted)}`,
        );
      }
      if (fakeClient.replyCalls.length !== 2) {
        throw new Error(
          `expected 2 reply API calls total, got ${fakeClient.replyCalls.length}`,
        );
      }
      await monitor.dispose();

      // ② replied 事件路径先置位（markSessionResolved）→ 扫描器跳过不调 API。
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({ request_id: "req-r5", reply: "always" }),
        ),
      );
      await registry.mutate((reg) => markSessionResolved(reg, "req-r5"));
      const callsBefore = fakeClient.replyCalls.length;
      const monitor2 = makeMonitor(async () => {});
      const third = await monitor2.scanReplyQueue();
      if (third !== 0) {
        throw new Error(`expected 0 applied for TUI-resolved, got ${third}`);
      }
      if (fakeClient.replyCalls.length !== callsBefore) {
        throw new Error(
          `reply API must not be called for already-resolved record`,
        );
      }
      await monitor2.dispose();
    },
  );

  // API-006-3：resolved=true 的记录不发送、send 保持 false（终态不补发）。
  await runCase(
    "API-006-3 resolved=true record is skipped, send stays false",
    async () => {
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({ request_id: "req-p3", resolved: true }),
        ),
      );
      const sent = [];
      const monitor = makeMonitor(async (text) => {
        sent.push(text);
      });
      const handled = await monitor.scanSessionQueue();
      if (handled !== 0) {
        throw new Error(`expected 0 handled, got ${handled}`);
      }
      if (sent.length !== 0) {
        throw new Error(`expected 0 sends, got ${sent.length}`);
      }
      const persisted = await findRecord("req-p3");
      if (!persisted || persisted.send !== false) {
        throw new Error(
          `resolved record send must stay false: ${JSON.stringify(persisted)}`,
        );
      }
      await monitor.dispose();
    },
  );

  // API-006-4：send=true 的记录不重复发送。
  await runCase(
    "API-006-4 send=true record is not re-sent",
    async () => {
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({ request_id: "req-p4", send: true }),
        ),
      );
      const sent = [];
      const monitor = makeMonitor(async (text) => {
        sent.push(text);
      });
      const handled = await monitor.scanSessionQueue();
      if (handled !== 0) {
        throw new Error(`expected 0 handled, got ${handled}`);
      }
      if (sent.length !== 0) {
        throw new Error(`expected 0 sends, got ${sent.length}`);
      }
      await monitor.dispose();
    },
  );

  // API-006-5：混合队列——permission + question 各一条 pending + 一条
  // resolved → 只发 2 条（⚠️ 与 ❓ 各一，串行按数组序），resolved 不补发。
  await runCase(
    "API-006-5 mixed queue: permission+question sent with ⚠️/❓, resolved skipped",
    async () => {
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({
            request_id: "req-p5a",
            type: "permission",
            message: JSON.stringify({ permission: "cat secret file" }),
          }),
        ),
      );
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({
            request_id: "req-p5b",
            type: "question",
            message: JSON.stringify({ tool: "bash", command: "ls -la" }),
          }),
        ),
      );
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({ request_id: "req-p5c", resolved: true }),
        ),
      );
      const sent = [];
      const monitor = makeMonitor(async (text) => {
        sent.push(text);
      });
      const handled = await monitor.scanSessionQueue();
      if (handled !== 2) {
        throw new Error(`expected 2 handled, got ${handled}`);
      }
      if (sent.length !== 2) {
        throw new Error(`expected 2 sends, got ${sent.length}`);
      }
      const permissionText = sent[0];
      const questionText = sent[1];
      if (!permissionText.includes("⚠️")) {
        throw new Error(`permission send missing ⚠️: ${permissionText}`);
      }
      if (!questionText.includes("❓")) {
        throw new Error(`question send missing ❓: ${questionText}`);
      }
      if (!permissionText.includes("Session") || !permissionText.includes("Type")) {
        throw new Error(`permission send missing table fields: ${permissionText}`);
      }
      if (!questionText.includes("ls -la")) {
        throw new Error(`question send missing message excerpt: ${questionText}`);
      }
      await monitor.dispose();
    },
  );

  // ---- Phase 1.2 (API-101/102) ----
  // 覆盖 makeMonitor（函数声明 hoisted，同一函数作用域内最后声明者胜出）：
  // scanSessionQueue 的 permission 记录现经 sendMessageWithKeyboard 发送
  // （契约 §13.3），既有 API-006-1/2/5 的 permission 用例也走该通道——覆盖后
  // 把键盘发送统一委派给 sendStub，保持 API-006 回归绿（仅追加，不触碰文件
  // 中段既有代码；1.3 后续用例同样受益，避免真实网络调用）。
  function makeMonitor(sendStub) {
    const monitor = new TelegramSessionMonitor(
      fakeClient,
      fakeConfig,
      root,
      registry,
    );
    monitor.sendMessage = sendStub;
    monitor.sendMessageWithKeyboard = async (text, keyboard) => sendStub(text);
    return monitor;
  }

  // API-101-1：permission 记录发送带三按钮键盘（Allow once / Allow always /
  // Deny），callback_data 格式 `otg:perm:<requestID>:<once|always|reject>` 且
  // 每个 ≤ 64 字节；发送后置位 send=true。
  await runCase(
    "API-101-1 permission sent with 3-button keyboard, callback_data format & <=64B",
    async () => {
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({ request_id: "req-b101p", type: "permission" }),
        ),
      );
      const calls = [];
      const monitor = new TelegramSessionMonitor(
        fakeClient,
        fakeConfig,
        root,
        registry,
      );
      monitor.sendMessage = async (text) => {
        calls.push({ kind: "plain", text });
      };
      monitor.sendMessageWithKeyboard = async (text, keyboard) => {
        calls.push({ kind: "keyboard", text, keyboard });
      };
      const handled = await monitor.scanSessionQueue();
      if (handled !== 1) {
        throw new Error(`expected 1 handled, got ${handled}`);
      }
      const kbCall = calls.find((call) => call.kind === "keyboard");
      if (!kbCall) {
        throw new Error(
          `permission record must be sent via keyboard: ${JSON.stringify(calls)}`,
        );
      }
      if (calls.some((call) => call.kind === "plain")) {
        throw new Error("permission record must not use plain sendMessage");
      }
      const rows = kbCall.keyboard.inline_keyboard;
      if (rows.length !== 1 || rows[0].length !== 3) {
        throw new Error(
          `expected 1 row of 3 buttons, got ${JSON.stringify(rows)}`,
        );
      }
      const labels = rows[0].map((button) => button.text);
      if (labels.join("|") !== "Allow once|Allow always|Deny") {
        throw new Error(`unexpected labels: ${labels.join("|")}`);
      }
      const datas = rows[0].map((button) => button.callback_data);
      const expected = [
        "otg:perm:req-b101p:once",
        "otg:perm:req-b101p:always",
        "otg:perm:req-b101p:reject",
      ];
      if (datas.join("|") !== expected.join("|")) {
        throw new Error(`unexpected callback_data: ${JSON.stringify(datas)}`);
      }
      for (const data of datas) {
        if (Buffer.byteLength(data, "utf8") > 64) {
          throw new Error(`callback_data exceeds 64 bytes: ${data}`);
        }
      }
      const persisted = await findRecord("req-b101p");
      if (!persisted || persisted.send !== true) {
        throw new Error(
          `send not set after keyboard send: ${JSON.stringify(persisted)}`,
        );
      }
      await monitor.dispose();
    },
  );

  // API-101-2：question 记录发送无键盘（plain sendMessage）。
  await runCase(
    "API-101-2 question sent without keyboard",
    async () => {
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({
            request_id: "req-b101q",
            type: "question",
            message: JSON.stringify({ tool: "bash", command: "ls -la" }),
          }),
        ),
      );
      const calls = [];
      const monitor = new TelegramSessionMonitor(
        fakeClient,
        fakeConfig,
        root,
        registry,
      );
      monitor.sendMessage = async (text) => {
        calls.push({ kind: "plain", text });
      };
      monitor.sendMessageWithKeyboard = async (text, keyboard) => {
        calls.push({ kind: "keyboard", text, keyboard });
      };
      const handled = await monitor.scanSessionQueue();
      if (handled !== 1) {
        throw new Error(`expected 1 handled, got ${handled}`);
      }
      if (calls.length !== 1 || calls[0].kind !== "plain") {
        throw new Error(
          `question must be sent via plain sendMessage: ${JSON.stringify(calls)}`,
        );
      }
      await monitor.dispose();
    },
  );

  // API-101-3：超长 requestID（ASCII 60 字符）→ 键盘用 44 字符短 ID，
  // permShortMap 登记短 ID → 完整 requestID；callback_data 仍 ≤ 64 字节。
  await runCase(
    "API-101-3 long requestID uses 44-char shortID + permShortMap mapping",
    async () => {
      const longID = "x".repeat(60);
      const shortID = longID.slice(0, 44);
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({ request_id: longID, type: "permission" }),
        ),
      );
      const calls = [];
      const monitor = new TelegramSessionMonitor(
        fakeClient,
        fakeConfig,
        root,
        registry,
      );
      monitor.sendMessage = async (text) => {
        calls.push({ kind: "plain", text });
      };
      monitor.sendMessageWithKeyboard = async (text, keyboard) => {
        calls.push({ kind: "keyboard", text, keyboard });
      };
      const handled = await monitor.scanSessionQueue();
      if (handled !== 1) {
        throw new Error(`expected 1 handled, got ${handled}`);
      }
      const kbCall = calls.find((call) => call.kind === "keyboard");
      if (!kbCall) {
        throw new Error("long requestID must still send with keyboard");
      }
      const datas = kbCall.keyboard.inline_keyboard[0].map(
        (button) => button.callback_data,
      );
      if (datas[0] !== `otg:perm:${shortID}:once`) {
        throw new Error(`unexpected shorted data: ${JSON.stringify(datas)}`);
      }
      for (const data of datas) {
        if (Buffer.byteLength(data, "utf8") > 64) {
          throw new Error(`shorted callback_data exceeds 64 bytes: ${data}`);
        }
      }
      if (monitor.permShortMap.get(shortID) !== longID) {
        throw new Error(
          `permShortMap must map shortID -> full requestID, got ${monitor.permShortMap.get(shortID)}`,
        );
      }
      await monitor.dispose();
    },
  );

  // API-101-4：多字节 requestID 致 44 字符仍超限 → 不发按钮（退化为无键盘
  // 普通消息），保证 callback_data 可解析性。
  await runCase(
    "API-101-4 multi-byte requestID over-limit falls back to plain send",
    async () => {
      const multiByte = "🔔".repeat(40); // 40 × 4 字节 = 160 字节
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({ request_id: multiByte, type: "permission" }),
        ),
      );
      const calls = [];
      const monitor = new TelegramSessionMonitor(
        fakeClient,
        fakeConfig,
        root,
        registry,
      );
      monitor.sendMessage = async (text) => {
        calls.push({ kind: "plain", text });
      };
      monitor.sendMessageWithKeyboard = async (text, keyboard) => {
        calls.push({ kind: "keyboard", text, keyboard });
      };
      const handled = await monitor.scanSessionQueue();
      if (handled !== 1) {
        throw new Error(`expected 1 handled, got ${handled}`);
      }
      if (calls.length !== 1 || calls[0].kind !== "plain") {
        throw new Error(
          `over-limit permission must fall back to plain send: ${JSON.stringify(calls)}`,
        );
      }
      await monitor.dispose();
    },
  );

  // API-102：handleCallback perm 分支——真实 answerCallback / editPermissionResultMessage
  // 经全局 fetch stub 拦截（不真发 Telegram），断言：三值写入 reply + answer 文案冻结
  // + 编辑（键盘移除 + 结果行）+ 非法 chatId 拒绝 + 无匹配记录失败分支。
  const realFetch = globalThis.fetch;
  async function stubFetch(calls) {
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
  }
  function restoreFetch() {
    globalThis.fetch = realFetch;
  }

  // 单个 perm 值完整回写流程：写入 reply + answer 文案 + 编辑消息去键盘加结果行；
  // 记录以 resolved=true 收尾（终态纪律契约 §13.9，避免遗留 reply!=null 未决记录
  // 干扰后续用例——1.3 的 scanReplyQueue 会扫到）。
  async function runPermCallback(value, expectedNotice, expectedResultLine, requestId) {
    const fetches = [];
    await stubFetch(fetches);
    try {
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({ request_id: requestId, type: "permission" }),
        ),
      );
      const monitor = new TelegramSessionMonitor(
        fakeClient,
        fakeConfig,
        root,
        registry,
      );
      await monitor.handleCallback({
        id: `cb-${requestId}`,
        from: { id: 123 },
        message: { message_id: 7, chat: { id: 123 }, text: "ORIGINAL" },
        data: `otg:perm:${requestId}:${value}`,
      });
      const persisted = await findRecord(requestId);
      if (!persisted || persisted.reply !== value) {
        throw new Error(
          `reply not written for ${value}: ${JSON.stringify(persisted)}`,
        );
      }
      const answerCalls = fetches.filter((call) =>
        call.url.includes("answerCallbackQuery"),
      );
      if (answerCalls.length !== 1) {
        throw new Error(
          `expected exactly 1 answer call for ${value}, got ${answerCalls.length}: ${JSON.stringify(fetches)}`,
        );
      }
      const answerCall = answerCalls[0];
      if (answerCall.body.text !== expectedNotice || answerCall.body.show_alert !== false) {
        throw new Error(
          `unexpected answer for ${value}: ${JSON.stringify(answerCall.body)}`,
        );
      }
      const editCalls = fetches.filter((call) =>
        call.url.includes("editMessageText"),
      );
      if (editCalls.length !== 1) {
        throw new Error(
          `expected exactly 1 edit call for ${value}, got ${editCalls.length}: ${JSON.stringify(fetches)}`,
        );
      }
      const editCall = editCalls[0];
      if (editCall.body.text !== `ORIGINAL\n${expectedResultLine}`) {
        throw new Error(
          `unexpected edit text for ${value}: ${JSON.stringify(editCall.body.text)}`,
        );
      }
      if (editCall.body.reply_markup !== undefined) {
        throw new Error(
          `edit must drop reply_markup (remove keyboard) for ${value}: ${JSON.stringify(editCall.body)}`,
        );
      }
      if (editCall.body.chat_id !== 123 || editCall.body.message_id !== 7) {
        throw new Error(
          `unexpected edit target for ${value}: ${JSON.stringify(editCall.body)}`,
        );
      }
      // 终态纪律（契约 §13.9）：resolved=true 收尾，防遗留干扰后续用例。
      await registry.mutate((reg) =>
        registryModule.markSessionResolved(reg, requestId),
      );
      await monitor.dispose();
    } finally {
      restoreFetch();
    }
  }

  await runCase(
    "API-102-1 callback once: writes reply, answers, edits (no keyboard + result line)",
    () => runPermCallback("once", "已允许一次", "✅ Allowed once", "req-b102o"),
  );
  await runCase(
    "API-102-2 callback always: writes reply, answers, edits",
    () => runPermCallback("always", "已允许总是", "✅ Allowed always", "req-b102a"),
  );
  await runCase(
    "API-102-3 callback reject: writes reply, answers, edits",
    () => runPermCallback("reject", "已拒绝", "❌ Rejected", "req-b102j"),
  );

  // API-102-4：非法 chatId → 直接拒绝（无 answer / 无 edit / 不写 reply）。
  await runCase(
    "API-102-4 callback from wrong chatId is rejected",
    async () => {
      const fetches = [];
      await stubFetch(fetches);
      try {
        const monitor = new TelegramSessionMonitor(
          fakeClient,
          fakeConfig,
          root,
          registry,
        );
        await monitor.handleCallback({
          id: "cb-b102w",
          from: { id: 999 },
          message: { message_id: 8, chat: { id: 123 }, text: "ORIGINAL" },
          data: "otg:perm:req-b102w:once",
        });
        const persisted = await findRecord("req-b102w");
        if (persisted && persisted.reply !== undefined) {
          throw new Error(
            `reply must not be written for wrong chatId: ${JSON.stringify(persisted)}`,
          );
        }
        if (fetches.length !== 0) {
          throw new Error(
            `no telegram calls expected for wrong chatId, got ${JSON.stringify(fetches)}`,
          );
        }
        await monitor.dispose();
      } finally {
        restoreFetch();
      }
    },
  );

  // API-102-5：无匹配记录 → answer「记录不存在或已失效」(alert) + 不编辑消息。
  await runCase(
    "API-102-5 callback with no matching record answers invalid, no edit",
    async () => {
      const fetches = [];
      await stubFetch(fetches);
      try {
        const monitor = new TelegramSessionMonitor(
          fakeClient,
          fakeConfig,
          root,
          registry,
        );
        await monitor.handleCallback({
          id: "cb-b102n",
          from: { id: 123 },
          message: { message_id: 9, chat: { id: 123 }, text: "ORIGINAL" },
          data: "otg:perm:req-does-not-exist:once",
        });
        const answerCalls = fetches.filter((call) =>
          call.url.includes("answerCallbackQuery"),
        );
        if (
          answerCalls.length !== 1 ||
          answerCalls[0].body.text !== "记录不存在或已失效" ||
          answerCalls[0].body.show_alert !== true
        ) {
          throw new Error(
            `expected single invalid-record answer, got ${JSON.stringify(fetches)}`,
          );
        }
        if (fetches.some((call) => call.url.includes("editMessageText"))) {
          throw new Error("no edit expected for no-match callback");
        }
        await monitor.dispose();
      } finally {
        restoreFetch();
      }
    },
  );

  await rm(baseDir, { recursive: true, force: true });
  const passed = total - failures;
  console.log(`\n${passed}/${total} cases passed`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();