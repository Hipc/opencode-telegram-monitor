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
    // 契约 §14.6：stub 返回固定 message_id（42），供 question 向导 q_msg_id
    // 回写断言（API-201）；permission 发送忽略返回值，兼容。
    monitor.sendMessageWithKeyboard = async (text, keyboard) => {
      await sendStub(text);
      return 42;
    };
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

  // ---- Phase 1.2 (API-201) ----
  // 契约 docs/modules/sessions-relay.md §14.2/§14.5：question 记录发送改走向导
  // 渲染（supersede API-006-5/API-101-2 的「原文节选/无键盘」断言——两者因
  // message 无 questions 字段仍走退化路径，断言原样成立，本区块显式覆盖新行为）：
  // 初始消息 = Q1 阶段单表（Type/Session/Question m/n/Header/问题文本/选项行
  // label+description）+ 键盘（选项 o<idx>；custom 题 ✏️；多题导航
  // ⬅️/➡️/❌；单问题无导航直接提交形态）；sendMessageWithKeyboard 返回
  // message_id → q_msg_id 回写；发送条件防御（q_answers!=null /
  // q_reject=true 不发送）；message 无 questions → 退化原文节选 plain 发送。
  function questionMessage(questions) {
    return JSON.stringify({ questions });
  }

  // API-201-1：多问题请求（Q1 为 multiple + custom）→ 键盘发送恰 1 次；文本
  // 含 Type/Session/Question 1/2/Header/问题文本/Option 1 label+description；
  // 键盘行序冻结（选项 / ✏️ Custom / ⬅️ Prev+➡️ Next+❌ Cancel）；callback_data
  // 全部 ≤ 64 字节；发送后 send=true 且 q_msg_id 回写（stub 返回 42）。
  await runCase(
    "API-201-1 question wizard initial send: single-table text + option/custom/nav keyboard + q_msg_id persisted",
    async () => {
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({
            request_id: "req-201a",
            type: "question",
            message: questionMessage([
              {
                question: "请选择操作方式",
                header: "操作选择",
                options: [
                  { label: "读取", description: "读取项目文件" },
                  { label: "写入", description: "写入项目文件" },
                ],
                multiple: true,
                custom: true,
              },
              {
                question: "请确认改动范围",
                options: [
                  { label: "全局", description: "影响所有文件" },
                  { label: "局部", description: "仅当前文件" },
                ],
              },
            ]),
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
        return 42;
      };
      const handled = await monitor.scanSessionQueue();
      await monitor.dispose();
      if (handled !== 1) {
        throw new Error(`expected 1 handled, got ${handled}`);
      }
      if (calls.length !== 1 || calls[0].kind !== "keyboard") {
        throw new Error(
          `question must be sent via keyboard: ${JSON.stringify(calls)}`,
        );
      }
      const text = calls[0].text;
      if (!text.includes("❓")) {
        throw new Error(`missing ❓ title line: ${text}`);
      }
      if (!text.includes("Type") || !text.includes("Session")) {
        throw new Error(`missing Type/Session table fields: ${text}`);
      }
      if (!text.includes("Question 1/2")) {
        throw new Error(`missing Question m/n row: ${text}`);
      }
      if (!text.includes("请选择操作方式")) {
        throw new Error(`missing question text: ${text}`);
      }
      if (!text.includes("Header") || !text.includes("操作选择")) {
        throw new Error(`missing Header row: ${text}`);
      }
      if (
        !text.includes("Option 1") ||
        !text.includes("读取 — 读取项目文件")
      ) {
        throw new Error(`missing option label+description row: ${text}`);
      }
      if (
        !text.includes("Option 2") ||
        !text.includes("写入 — 写入项目文件")
      ) {
        throw new Error(`missing second option row: ${text}`);
      }
      const rows = calls[0].keyboard.inline_keyboard;
      if (rows.length !== 3) {
        throw new Error(`expected 3 keyboard rows, got ${rows.length}`);
      }
      const optionRow = rows[0];
      if (optionRow.length !== 2) {
        throw new Error(`expected 2 option buttons, got ${optionRow.length}`);
      }
      if (optionRow[0].callback_data !== "otg:q:req-201a:o0") {
        throw new Error(`unexpected option data: ${optionRow[0].callback_data}`);
      }
      if (optionRow[1].callback_data !== "otg:q:req-201a:o1") {
        throw new Error(`unexpected option data: ${optionRow[1].callback_data}`);
      }
      const customRow = rows[1];
      if (
        customRow.length !== 1 ||
        customRow[0].text !== "✏️ Custom" ||
        customRow[0].callback_data !== "otg:q:req-201a:custom"
      ) {
        throw new Error(`unexpected custom row: ${JSON.stringify(customRow)}`);
      }
      const navRow = rows[2];
      if (
        navRow.length !== 3 ||
        navRow[0].text !== "⬅️ Prev" ||
        navRow[1].text !== "➡️ Next" ||
        navRow[2].text !== "❌ Cancel"
      ) {
        throw new Error(`unexpected nav row: ${JSON.stringify(navRow)}`);
      }
      if (
        navRow[0].callback_data !== "otg:q:req-201a:prev" ||
        navRow[1].callback_data !== "otg:q:req-201a:next" ||
        navRow[2].callback_data !== "otg:q:req-201a:cancel"
      ) {
        throw new Error(`unexpected nav data: ${JSON.stringify(navRow)}`);
      }
      const allData = rows.flatMap((row) =>
        row.map((button) => button.callback_data ?? ""),
      );
      for (const data of allData) {
        if (Buffer.byteLength(data, "utf8") > 64) {
          throw new Error(`callback_data exceeds 64 bytes: ${data}`);
        }
      }
      const persisted = await findRecord("req-201a");
      if (!persisted || persisted.send !== true) {
        throw new Error(
          `send not set after wizard send: ${JSON.stringify(persisted)}`,
        );
      }
      if (!persisted || persisted.q_msg_id !== 42) {
        throw new Error(
          `q_msg_id not written back (expected 42): ${JSON.stringify(persisted)}`,
        );
      }
    },
  );

  // API-201-2：单问题请求 → 键盘**无导航无 Submit**（直接提交形态）——只有
  // 选项行 + ❌ Cancel。
  await runCase(
    "API-201-2 single-question request keyboard has options + Cancel only (no nav/no submit)",
    async () => {
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({
            request_id: "req-201b",
            type: "question",
            message: questionMessage([
              {
                question: "是否允许读取该目录",
                header: "确认",
                options: [
                  { label: "允许", description: "允许读取" },
                  { label: "拒绝", description: "拒绝读取" },
                ],
              },
            ]),
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
        return 42;
      };
      const handled = await monitor.scanSessionQueue();
      await monitor.dispose();
      if (handled !== 1) {
        throw new Error(`expected 1 handled, got ${handled}`);
      }
      if (calls.length !== 1 || calls[0].kind !== "keyboard") {
        throw new Error(
          `single question must be sent via keyboard: ${JSON.stringify(calls)}`,
        );
      }
      const text = calls[0].text;
      if (!text.includes("Question 1/1")) {
        throw new Error(`missing Question 1/1 row: ${text}`);
      }
      if (!text.includes("是否允许读取该目录")) {
        throw new Error(`missing question text: ${text}`);
      }
      const rows = calls[0].keyboard.inline_keyboard;
      if (rows.length !== 2) {
        throw new Error(`expected 2 keyboard rows (options + cancel), got ${rows.length}`);
      }
      const optionRow = rows[0];
      if (optionRow.length !== 2) {
        throw new Error(`expected 2 option buttons, got ${optionRow.length}`);
      }
      const cancelRow = rows[1];
      if (
        cancelRow.length !== 1 ||
        cancelRow[0].text !== "❌ Cancel" ||
        cancelRow[0].callback_data !== "otg:q:req-201b:cancel"
      ) {
        throw new Error(`unexpected cancel row: ${JSON.stringify(cancelRow)}`);
      }
      const navLabels = [
        "⬅️ Prev",
        "➡️ Next",
        "✅ Submit",
      ];
      const allLabels = rows.flatMap((row) => row.map((button) => button.text));
      if (navLabels.some((label) => allLabels.includes(label))) {
        throw new Error(
          `single-question keyboard must not contain nav/submit: ${JSON.stringify(allLabels)}`,
        );
      }
    },
  );

  // API-201-3：发送条件防御——q_answers != null / q_reject === true 的未发送
  // 记录不发送初始消息（走消费端 apply，契约 §14.2.2）；记录留在用例内闭环
  // 到 resolved=true（终态纪律 §14.5，避免 1.4 扫描器扫到）。
  await runCase(
    "API-201-3 records with q_answers set or q_reject=true are not sent",
    async () => {
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({
            request_id: "req-201c",
            type: "question",
            send: false,
            resolved: false,
            q_answers: [["允许"]],
            message: questionMessage([
              {
                question: "是否允许读取",
                options: [{ label: "允许", description: "允许读取" }],
              },
            ]),
          }),
        ),
      );
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({
            request_id: "req-201d",
            type: "question",
            send: false,
            resolved: false,
            q_reject: true,
            message: questionMessage([
              {
                question: "是否允许读取",
                options: [{ label: "允许", description: "允许读取" }],
              },
            ]),
          }),
        ),
      );
      const calls = [];
      const monitor = makeMonitor(async (text) => {
        calls.push(text);
      });
      const handled = await monitor.scanSessionQueue();
      await monitor.dispose();
      if (handled !== 0) {
        throw new Error(`expected 0 handled, got ${handled}`);
      }
      if (calls.length !== 0) {
        throw new Error(`expected 0 sends, got ${calls.length}`);
      }
      // 终态纪律：用例内闭环到 resolved，避免遗留 q_* 已置且 unresolved 记录。
      await registry.mutate((reg) => markSessionResolved(reg, "req-201c"));
      await registry.mutate((reg) => markSessionResolved(reg, "req-201d"));
    },
  );

  // API-201-4：message 无 questions（非向导 payload）→ 退化原文节选
  // plain 发送（防御，question 记录永远可达）；无键盘、无 q_msg_id 回写。
  await runCase(
    "API-201-4 question without questions array falls back to plain excerpt send",
    async () => {
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({
            request_id: "req-201e",
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
        return 42;
      };
      const handled = await monitor.scanSessionQueue();
      await monitor.dispose();
      if (handled !== 1) {
        throw new Error(`expected 1 handled, got ${handled}`);
      }
      if (calls.length !== 1 || calls[0].kind !== "plain") {
        throw new Error(
          `no-questions message must fall back to plain send: ${JSON.stringify(calls)}`,
        );
      }
      if (!calls[0].text.includes("ls -la")) {
        throw new Error(`fallback excerpt missing payload text: ${calls[0].text}`);
      }
      const persisted = await findRecord("req-201e");
      if (!persisted || persisted.send !== true) {
        throw new Error(
          `send not set after fallback send: ${JSON.stringify(persisted)}`,
        );
      }
      if (persisted.q_msg_id !== undefined) {
        throw new Error(
          `q_msg_id must not be written on fallback path: ${JSON.stringify(persisted)}`,
        );
      }
    },
  );

  // ---- API-105: structured rendering (round 3, single-table) ----
  // 契约 docs/modules/sessions-relay.md §13.12（supersede §13.11）：permission
  // 记录 message JSON 解析 → Permission/Pattern 行并入 Type/Session 所在的
  // **同一张** fieldTable（单表），Pattern 逐项单独一行（单 `Pattern` / 多
  // `Pattern 1`/`Pattern 2`/…），Title 行移除，值经 safeTextKeepPaths 展示
  // 真实路径；非法 JSON / 合法但无可识别字段（如 {}）→ 退回 300 字符原文节选。
  // question 记录渲染不变（API-006-5/API-101-2 既有断言覆盖，不新增）。
  let api105Seq = 0;
  async function renderedText(overrides = {}) {
    api105Seq += 1;
    const requestID = `req-105-${api105Seq}`;
    await registry.mutate((reg) =>
      appendSessionRecord(
        reg,
        root,
        makeRecord({ request_id: requestID, ...overrides }),
      ),
    );
    const sent = [];
    const monitor = makeMonitor(async (text) => {
      sent.push(text);
    });
    const handled = await monitor.scanSessionQueue();
    await monitor.dispose();
    if (handled !== 1 || sent.length !== 1) {
      throw new Error(
        `expected 1 send for rendering, got handled=${handled} sent=${sent.length}`,
      );
    }
    return sent[0];
  }

  function countSubstring(haystack, needle) {
    return haystack.split(needle).length - 1;
  }

  // API-105-1：合法 JSON（permission + 多 patterns + title）→ 渲染为**单张**
  // fieldTable，含 Permission 行与 `Pattern 1`/`Pattern 2` 编号行、两个 pattern
  // 项内容；**不含** Title 行、不含未解析的 JSON dump、不含 id 泄漏。
  await runCase(
    "API-105-1 permission valid JSON renders single table with Permission/Pattern 1/Pattern 2 rows, no Title row, no raw JSON dump",
    async () => {
      const rawMessage = JSON.stringify({
        id: "req-105a",
        permission: "external_directory",
        patterns: ["*.ts", "*.md"],
        title: "Allow access to external directory",
        metadata: { provider: "fs" },
      });
      const text = await renderedText({ message: rawMessage });
      const tableCount = countSubstring(text, "<table");
      if (tableCount !== 1) {
        throw new Error(
          `expected exactly 1 <table (single table), got ${tableCount}: ${text}`,
        );
      }
      if (!text.includes("Permission") || !text.includes("external_directory")) {
        throw new Error(`missing Permission row: ${text}`);
      }
      if (!text.includes("Pattern 1") || !text.includes("Pattern 2")) {
        throw new Error(`missing numbered Pattern rows: ${text}`);
      }
      if (!text.includes("*.ts") || !text.includes("*.md")) {
        throw new Error(`missing pattern items: ${text}`);
      }
      if (text.includes("Title")) {
        throw new Error(`Title row must not be rendered: ${text}`);
      }
      if (text.includes("Allow access to external directory")) {
        throw new Error(`Title value must not be rendered: ${text}`);
      }
      if (text.includes(rawMessage)) {
        throw new Error(`raw JSON dump must not appear: ${text}`);
      }
      if (text.includes("req-105a")) {
        throw new Error(`raw JSON id leaked into rendered text: ${text}`);
      }
    },
  );

  // API-105-2：非法 JSON → 退回原文节选（含截断 JSON 文本）。
  await runCase(
    "API-105-2 permission invalid JSON falls back to message excerpt",
    async () => {
      const badMessage = '{"permission": "read file", "patterns": ["a"]';
      const text = await renderedText({ message: badMessage });
      if (!text.includes(badMessage)) {
        throw new Error(`fallback excerpt missing raw text: ${text}`);
      }
      if (text.includes("Permission")) {
        throw new Error(`no structured rows expected on invalid JSON: ${text}`);
      }
    },
  );

  // API-105-3：合法 JSON 但无可识别字段（{}）→ 退回原文节选。
  await runCase(
    "API-105-3 permission empty-object JSON falls back to message excerpt",
    async () => {
      const text = await renderedText({ message: "{}" });
      if (!text.includes("{}")) {
        throw new Error(`fallback excerpt missing on empty object: ${text}`);
      }
      if (text.includes("Permission")) {
        throw new Error(`no structured rows expected for {}: ${text}`);
      }
    },
  );

  // ---- API-106: real pattern paths (round 3) ----
  // 契约 docs/modules/sessions-relay.md §13.12.3：pattern 为绝对路径（40+ 字符
  // 长）→ safeTextKeepPaths 保留完整真实路径，**不含** `<external-path>` /
  // `<project>` / `[REDACTED_VALUE]`（决策 #1：放开路径脱敏）。
  await runCase(
    "API-106 absolute pattern paths appear verbatim, no path redaction markers",
    async () => {
      const longPath = "/home/hipc/work/git-clone/some-project/src/index.ts";
      const otherPath = "/etc/opencode/plugins/telegram-session-monitor.ts";
      if (longPath.length < 40 || otherPath.length < 40) {
        throw new Error(
          `test paths must be 40+ chars to exercise long-blob rule: ${longPath.length}/${otherPath.length}`,
        );
      }
      const rawMessage = JSON.stringify({
        permission: "read_file",
        patterns: [longPath, otherPath],
      });
      const text = await renderedText({ message: rawMessage });
      if (!text.includes(longPath)) {
        throw new Error(`long absolute path must appear verbatim: ${text}`);
      }
      if (!text.includes(otherPath)) {
        throw new Error(`other absolute path must appear verbatim: ${text}`);
      }
      if (text.includes("<external-path>")) {
        throw new Error(`external-path redaction must not apply: ${text}`);
      }
      if (text.includes("<project>")) {
        throw new Error(`project redaction must not apply: ${text}`);
      }
      if (text.includes("[REDACTED_VALUE]")) {
        throw new Error(`long-blob redaction must not apply: ${text}`);
      }
    },
  );

  await rm(baseDir, { recursive: true, force: true });
  const passed = total - failures;
  console.log(`\n${passed}/${total} cases passed`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();