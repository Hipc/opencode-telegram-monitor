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

  // 假 client 最小面：scanSessionQueue 只经 sendMessage（被 stub）与
  // this.log（client.app.log）交互；bootstrap 不会被调用（不调 initialize()）。
  // Phase 1.3（API-103/104）：追加 permission reply API stub —— 测试经
  // replyCalls 断言透传、replyError 控制成功/失败（方法名/参数形状以本机 SDK
  // 核验为准：client.postSessionIdPermissionsPermissionId({ path: { id,
  // permissionID }, body: { response } })，契约 §13.8）。
  // Phase 2.1（API-205 改判 / API-206）：运行时实证扁平客户端无任何 question
  // 方法（契约 §14.8.1），删除 Phase 1.4 的两个扁平 question stub 与
  // questionReplyCalls/questionRejectCalls/questionReplyError/
  // questionRejectError 成员；改为 _client.post stub —— postCalls 记录
  // { url, path, query, body, headers, throwOnError }、postError 控制
  // 成功/失败（可传含 status/statusCode 的 Error 对象模拟 404）。
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
    // 分层通道 ②③ 的 transport stub（§14.8.1）：(client as any)._client.post
    // 与 v2 gen 生成方法共用同一 transport，自动继承 baseUrl/auth。
    _client: {
      post: async (options) => {
        fakeClient.postCalls.push({
          url: options?.url,
          path: options?.path,
          query: options?.query,
          body: options?.body,
          headers: options?.headers,
          throwOnError: options?.throwOnError,
        });
        if (fakeClient.postError) throw fakeClient.postError;
        return { data: true };
      },
    },
    replyCalls: [],
    replyError: undefined,
    postCalls: [],
    postError: undefined,
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

  // ---- Phase 1.4 (API-205) ----
  // 契约 docs/modules/sessions-relay.md §14.4/§14.5：消费端 q_answers/q_reject
  // 应用。question 双分支：q_answers != null → applyQuestionReply（透传
  // sessionID/requestID/answers → resolved=true）；q_reject === true →
  // applyQuestionReject；失败不置位下轮重试；已 resolved 跳过（双路径先到先得）；
  // permission 分支（API-103/104）不受影响。
  // API-205-1：q_answers → reply API 透传置位；q_reject → reject API 置位；
  // 未达终态的 question 记录不触发；permission reply 记录仍走原 API。
  await runCase(
    "API-205 question reply/reject apply: answers passthrough, both set resolved=true, permission path unchanged",
    async () => {
      fakeClient.postCalls = [];
      fakeClient.postError = undefined;
      fakeClient.replyCalls = [];
      // q_answers 已写入的 question 记录 → reply API。
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({
            request_id: "req-q1",
            type: "question",
            message: JSON.stringify({
              sessionID: "ses_testp0001",
              id: "req-q1",
              questions: [
                { question: "pick one", header: "H", options: [{ label: "A", description: "desc" }] },
              ],
            }),
            q_answers: [["A"]],
          }),
        ),
      );
      // q_reject=true 的 question 记录 → reject API。
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({
            request_id: "req-q2",
            type: "question",
            message: JSON.stringify({
              sessionID: "ses_testp0001",
              id: "req-q2",
              questions: [{ question: "pick two", options: [{ label: "B" }] }],
            }),
            q_reject: true,
          }),
        ),
      );
      // 未达终态（q_answers 缺失且 q_reject 未置位）→ 不触发任何 API。
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({
            request_id: "req-q3",
            type: "question",
            message: JSON.stringify({ id: "req-q3", questions: [] }),
          }),
        ),
      );
      // permission 回归：reply 记录仍走 permission reply API（分支零改动）。
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({ request_id: "req-q4", reply: "once" }),
        ),
      );
      const monitor = makeMonitor(async () => {});
      const applied = await monitor.scanReplyQueue();
      if (applied !== 3) {
        throw new Error(`expected 3 applied, got ${applied}`);
      }
      // question reply 透传断言（分层通道②：_client.post url/path/body 顶层
      // { answers }；§14.8.1/§14.8.7）。运行时无扁平方法 → typeof 走失败分支。
      const replyCalls = fakeClient.postCalls.filter((call) =>
        call.url === "/api/session/{sessionID}/question/{requestID}/reply",
      );
      if (replyCalls.length !== 1) {
        throw new Error(
          `expected exactly 1 question reply _client.post call, got ${replyCalls.length}`,
        );
      }
      const rc = replyCalls[0];
      if (rc.path?.sessionID !== "ses_testp0001") {
        throw new Error(`question reply sessionID mismatch: ${rc.path?.sessionID}`);
      }
      if (rc.path?.requestID !== "req-q1") {
        throw new Error(`question reply requestID mismatch: ${rc.path?.requestID}`);
      }
      if (JSON.stringify(rc.body) !== JSON.stringify({ answers: [["A"]] })) {
        throw new Error(
          `question reply body must be top-level { answers }, got ${JSON.stringify(rc.body)}`,
        );
      }
      if (rc.body && "questionV2Reply" in rc.body) {
        throw new Error(`question reply body must not nest questionV2Reply`);
      }
      if (rc.throwOnError !== true) {
        throw new Error(`question reply call must set throwOnError: true`);
      }
      // question reject 透传断言（同构：url .../reject、无 body 字段）。
      const rejectCalls = fakeClient.postCalls.filter((call) =>
        call.url === "/api/session/{sessionID}/question/{requestID}/reject",
      );
      if (rejectCalls.length !== 1) {
        throw new Error(
          `expected exactly 1 question reject _client.post call, got ${rejectCalls.length}`,
        );
      }
      const jc = rejectCalls[0];
      if (jc.path?.sessionID !== "ses_testp0001") {
        throw new Error(`question reject sessionID mismatch: ${jc.path?.sessionID}`);
      }
      if (jc.path?.requestID !== "req-q2") {
        throw new Error(`question reject requestID mismatch: ${jc.path?.requestID}`);
      }
      if (jc.body !== undefined) {
        throw new Error(`question reject call must carry no body, got ${JSON.stringify(jc.body)}`);
      }
      // 分层命中通道②：不得有任何 v2 全局路由（/question/...）调用。
      if (fakeClient.postCalls.some((call) => !call.url.startsWith("/api/session/"))) {
        throw new Error(
          `channel 2 must be hit first; unexpected global-route call: ${JSON.stringify(fakeClient.postCalls)}`,
        );
      }
      // permission 回归：permission reply API 仍被调用。
      if (fakeClient.replyCalls.length !== 1) {
        throw new Error(
          `expected 1 permission reply API call (regression), got ${fakeClient.replyCalls.length}`,
        );
      }
      if (fakeClient.replyCalls[0].permissionID !== "req-q4") {
        throw new Error(
          `permission reply requestID mismatch: ${fakeClient.replyCalls[0].permissionID}`,
        );
      }
      // resolved 置位断言（终态）。
      const r1 = await findRecord("req-q1");
      if (!r1 || r1.resolved !== true) {
        throw new Error(
          `q1 resolved not true after reply apply: ${JSON.stringify(r1)}`,
        );
      }
      const r2 = await findRecord("req-q2");
      if (!r2 || r2.resolved !== true) {
        throw new Error(
          `q2 resolved not true after reject apply: ${JSON.stringify(r2)}`,
        );
      }
      const r3 = await findRecord("req-q3");
      if (!r3 || r3.resolved !== false) {
        throw new Error(
          `q3 (no flag) must stay unresolved: ${JSON.stringify(r3)}`,
        );
      }
      // 用例终态纪律（契约 §14.5）：req-q3 无触发标志、无法被扫描器消费，
      // 需显式置 resolved，避免遗留 send=false && resolved=false 的 question
      // 记录污染后续 scanSessionQueue 用例计数。
      await registry.mutate((reg) => markSessionResolved(reg, "req-q3"));
      await monitor.dispose();
    },
  );

  // API-205-2：apply 失败 → resolved 保持 false、下轮重试成功（reply 与
  // reject 双路径各验证一次；postError 使两条记录都失败，单条失败不中断
  // 整轮，成功计数为 0）。
  await runCase(
    "API-205 question apply failure keeps resolved=false and retries to success (reply + reject)",
    async () => {
      fakeClient.postCalls = [];
      fakeClient.postError = undefined;
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({
            request_id: "req-q5",
            type: "question",
            message: JSON.stringify({ id: "req-q5", questions: [] }),
            q_answers: [["X"]],
          }),
        ),
      );
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({
            request_id: "req-q6",
            type: "question",
            message: JSON.stringify({ id: "req-q6", questions: [] }),
            q_reject: true,
          }),
        ),
      );
      // ① apply 失败（postError 抛非 404 错误，如「已决」）→ 两条记录均
      // 不置位（单条失败不中断整轮，成功计数为 0）。
      fakeClient.postError = new Error("question already decided");
      const monitor = makeMonitor(async () => {});
      const first = await monitor.scanReplyQueue();
      if (first !== 0) {
        throw new Error(`expected 0 applied while postError set, got ${first}`);
      }
      let r5 = await findRecord("req-q5");
      if (!r5 || r5.resolved !== false) {
        throw new Error(
          `q5 resolved must stay false after failed reply apply: ${JSON.stringify(r5)}`,
        );
      }
      let r6 = await findRecord("req-q6");
      if (!r6 || r6.resolved !== false) {
        throw new Error(
          `q6 resolved must stay false after failed reject apply: ${JSON.stringify(r6)}`,
        );
      }
      // ② 下轮重试：postError 清除 → 两路径均成功置位。
      fakeClient.postError = undefined;
      const second = await monitor.scanReplyQueue();
      if (second !== 2) {
        throw new Error(`expected 2 applied on retry, got ${second}`);
      }
      r5 = await findRecord("req-q5");
      if (!r5 || r5.resolved !== true) {
        throw new Error(
          `q5 resolved not true after retry success: ${JSON.stringify(r5)}`,
        );
      }
      r6 = await findRecord("req-q6");
      if (!r6 || r6.resolved !== true) {
        throw new Error(
          `q6 resolved not true after retry success: ${JSON.stringify(r6)}`,
        );
      }
      // 每记录每轮：非 404 失败 → 通道② + 降级通道③ 各一次；首轮 2 记录 × 2
      // = 4，重试轮 2 记录 × 1（② 成功） = 2，共 6。
      if (fakeClient.postCalls.length !== 6) {
        throw new Error(
          `expected 6 _client.post calls total (4 failed degrade + 2 success), got ${fakeClient.postCalls.length}`,
        );
      }
      await monitor.dispose();
    },
  );

  // API-205-3：双路径先到先得——question.replied/rejected 事件路径先置位
  // （markSessionResolved）→ 扫描器跳过，不调任何 question API。
  await runCase(
    "API-205 already-resolved question record is skipped (event path first)",
    async () => {
      fakeClient.postCalls = [];
      fakeClient.postError = undefined;
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({
            request_id: "req-q7",
            type: "question",
            message: JSON.stringify({ id: "req-q7", questions: [] }),
            q_answers: [["Y"]],
          }),
        ),
      );
      await registry.mutate((reg) => markSessionResolved(reg, "req-q7"));
      const monitor = makeMonitor(async () => {});
      const applied = await monitor.scanReplyQueue();
      if (applied !== 0) {
        throw new Error(`expected 0 applied for resolved, got ${applied}`);
      }
      if (fakeClient.postCalls.length !== 0) {
        throw new Error(
          `question _client.post must not be called for already-resolved record`,
        );
      }
      await monitor.dispose();
    },
  );

  // ---- Phase 2.1 (API-206) ----
  // 契约 docs/modules/sessions-relay.md §14.8.1/§14.8.2/§14.8.7：消费端通道
  // 修复。运行时扁平客户端无 question 方法（实机实证）→ 分层通道命中 ②
  // （(client as any)._client.post，url/path/body 顶层 { answers }）；① 扁平
  // 方法存在时直用；404 → resolved 终态不再重试；非 404 失败仍重试（② 失败
  // 降级 ③ 后仍失败）；reject 同构（无 body）。
  // API-206-1：分层命中通道②——reply 与 reject 同构（url/path/body 断言、
  // 无 v2 全局路由调用、无 questionV2Reply 嵌套）。
  await runCase(
    "API-206 layered channel 2 hit: _client.post url/path/body top-level {answers}, reject no body, no global route",
    async () => {
      fakeClient.postCalls = [];
      fakeClient.postError = undefined;
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({
            request_id: "req-a1",
            type: "question",
            message: JSON.stringify({ id: "req-a1", questions: [] }),
            q_answers: [["A"]],
          }),
        ),
      );
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({
            request_id: "req-a2",
            type: "question",
            message: JSON.stringify({ id: "req-a2", questions: [] }),
            q_reject: true,
          }),
        ),
      );
      const monitor = makeMonitor(async () => {});
      const applied = await monitor.scanReplyQueue();
      if (applied !== 2) {
        throw new Error(`expected 2 applied, got ${applied}`);
      }
      // 恰 2 次 _client.post，均为 v2 会话级路由（通道②，无 v2 全局降级）。
      if (fakeClient.postCalls.length !== 2) {
        throw new Error(
          `expected exactly 2 _client.post calls, got ${fakeClient.postCalls.length}`,
        );
      }
      for (const call of fakeClient.postCalls) {
        if (!call.url.startsWith("/api/session/")) {
          throw new Error(`unexpected non-session route: ${call.url}`);
        }
      }
      const rc = fakeClient.postCalls.find((c) => c.url.endsWith("/reply"));
      if (!rc) throw new Error("missing reply _client.post call");
      if (rc.path?.sessionID !== "ses_testp0001") {
        throw new Error(`reply path.sessionID mismatch: ${rc.path?.sessionID}`);
      }
      if (rc.path?.requestID !== "req-a1") {
        throw new Error(`reply path.requestID mismatch: ${rc.path?.requestID}`);
      }
      if (JSON.stringify(rc.body) !== JSON.stringify({ answers: [["A"]] })) {
        throw new Error(`reply body must be top-level { answers }, got ${JSON.stringify(rc.body)}`);
      }
      if (rc.body && "questionV2Reply" in rc.body) {
        throw new Error(`reply body must not nest questionV2Reply`);
      }
      if (rc.query !== undefined) {
        throw new Error(`channel 2 reply must not carry query, got ${JSON.stringify(rc.query)}`);
      }
      const jc = fakeClient.postCalls.find((c) => c.url.endsWith("/reject"));
      if (!jc) throw new Error("missing reject _client.post call");
      if (jc.path?.requestID !== "req-a2") {
        throw new Error(`reject path.requestID mismatch: ${jc.path?.requestID}`);
      }
      if (jc.body !== undefined) {
        throw new Error(`reject must carry no body, got ${JSON.stringify(jc.body)}`);
      }
      if (jc.query !== undefined) {
        throw new Error(`channel 2 reject must not carry query, got ${JSON.stringify(jc.query)}`);
      }
      const r1 = await findRecord("req-a1");
      if (!r1 || r1.resolved !== true) {
        throw new Error(`a1 resolved not true after reply apply: ${JSON.stringify(r1)}`);
      }
      const r2 = await findRecord("req-a2");
      if (!r2 || r2.resolved !== true) {
        throw new Error(`a2 resolved not true after reject apply: ${JSON.stringify(r2)}`);
      }
      await monitor.dispose();
    },
  );

  // API-206-2：① 扁平方法存在时直用（用例内临时挂方法，断言命中后清理）。
  await runCase(
    "API-206 flat question methods are used directly when present (channel 1)",
    async () => {
      fakeClient.postCalls = [];
      fakeClient.postError = undefined;
      const flatCalls = [];
      const flatReply = async (options) => {
        flatCalls.push({ kind: "reply", options });
        return { data: true };
      };
      const flatReject = async (options) => {
        flatCalls.push({ kind: "reject", options });
        return { data: true };
      };
      fakeClient.postApiSessionSessionIDQuestionRequestIDReply = flatReply;
      fakeClient.postApiSessionSessionIDQuestionRequestIDReject = flatReject;
      try {
        await registry.mutate((reg) =>
          appendSessionRecord(
            reg,
            root,
            makeRecord({
              request_id: "req-a3",
              type: "question",
              message: JSON.stringify({ id: "req-a3", questions: [] }),
              q_answers: [["B"]],
            }),
          ),
        );
        await registry.mutate((reg) =>
          appendSessionRecord(
            reg,
            root,
            makeRecord({
              request_id: "req-a4",
              type: "question",
              message: JSON.stringify({ id: "req-a4", questions: [] }),
              q_reject: true,
            }),
          ),
        );
        const monitor = makeMonitor(async () => {});
        const applied = await monitor.scanReplyQueue();
        if (applied !== 2) {
          throw new Error(`expected 2 applied via flat methods, got ${applied}`);
        }
        // 扁平方法直用：_client.post 未被调用。
        if (fakeClient.postCalls.length !== 0) {
          throw new Error(
            `_client.post must not be called when flat methods exist, got ${fakeClient.postCalls.length} calls`,
          );
        }
        if (flatCalls.length !== 2) {
          throw new Error(`expected 2 flat method calls, got ${flatCalls.length}`);
        }
        const fr = flatCalls.find((c) => c.kind === "reply");
        if (!fr) throw new Error("flat reply method not called");
        if (fr.options.path?.sessionID !== "ses_testp0001") {
          throw new Error(`flat reply path.sessionID mismatch: ${fr.options.path?.sessionID}`);
        }
        if (fr.options.path?.requestID !== "req-a3") {
          throw new Error(`flat reply path.requestID mismatch: ${fr.options.path?.requestID}`);
        }
        if (JSON.stringify(fr.options.body) !== JSON.stringify({ answers: [["B"]] })) {
          throw new Error(`flat reply body must be top-level { answers }, got ${JSON.stringify(fr.options.body)}`);
        }
        const fj = flatCalls.find((c) => c.kind === "reject");
        if (!fj) throw new Error("flat reject method not called");
        if (fj.options.path?.requestID !== "req-a4") {
          throw new Error(`flat reject path.requestID mismatch: ${fj.options.path?.requestID}`);
        }
        if (fj.options.body !== undefined) {
          throw new Error(`flat reject must carry no body, got ${JSON.stringify(fj.options.body)}`);
        }
        const r3 = await findRecord("req-a3");
        if (!r3 || r3.resolved !== true) {
          throw new Error(`a3 resolved not true after flat reply apply: ${JSON.stringify(r3)}`);
        }
        const r4 = await findRecord("req-a4");
        if (!r4 || r4.resolved !== true) {
          throw new Error(`a4 resolved not true after flat reject apply: ${JSON.stringify(r4)}`);
        }
        await monitor.dispose();
      } finally {
        delete fakeClient.postApiSessionSessionIDQuestionRequestIDReply;
        delete fakeClient.postApiSessionSessionIDQuestionRequestIDReject;
      }
    },
  );

  // API-206-3：404 → resolved 终态，不再重试（下一轮 scan 不再调用）。
  await runCase(
    "API-206 404 marks question resolved (terminal), no retry on next scan",
    async () => {
      fakeClient.postCalls = [];
      fakeClient.postError = Object.assign(new Error("question not found"), {
        status: 404,
      });
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({
            request_id: "req-a5",
            type: "question",
            message: JSON.stringify({ id: "req-a5", questions: [] }),
            q_answers: [["C"]],
          }),
        ),
      );
      const monitor = makeMonitor(async () => {});
      const applied = await monitor.scanReplyQueue();
      // 404 终态：不 rethrow、应用成功计数 +1；仅 1 次通道②调用（404 立即
      // 终态，不继续尝试后续通道）。
      if (applied !== 1) {
        throw new Error(`expected 1 applied (404 terminal), got ${applied}`);
      }
      if (fakeClient.postCalls.length !== 1) {
        throw new Error(
          `expected 1 _client.post call before 404 terminal, got ${fakeClient.postCalls.length}`,
        );
      }
      const r5 = await findRecord("req-a5");
      if (!r5 || r5.resolved !== true) {
        throw new Error(`a5 must be resolved after 404: ${JSON.stringify(r5)}`);
      }
      // 下一轮 scan：resolved=true → 跳过，不再调用 _client.post。
      const callsAfter = fakeClient.postCalls.length;
      const second = await monitor.scanReplyQueue();
      if (second !== 0) {
        throw new Error(`expected 0 applied on next scan, got ${second}`);
      }
      if (fakeClient.postCalls.length !== callsAfter) {
        throw new Error(`_client.post must not be called again after 404 terminal`);
      }
      await monitor.dispose();
    },
  );

  // API-206-4：非 404 失败仍重试——② 失败降级尝试 ③（v2 全局路由，query
  // directory=root）后仍失败 → 不置位；下轮 postError 清除 → 重试成功。
  await runCase(
    "API-206 non-404 failure retries and degrades to channel 3 (global route), then succeeds",
    async () => {
      fakeClient.postCalls = [];
      fakeClient.postError = new Error("boom");
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          makeRecord({
            request_id: "req-a6",
            type: "question",
            message: JSON.stringify({ id: "req-a6", questions: [] }),
            q_answers: [["D"]],
          }),
        ),
      );
      const monitor = makeMonitor(async () => {});
      const first = await monitor.scanReplyQueue();
      if (first !== 0) {
        throw new Error(`expected 0 applied while postError set, got ${first}`);
      }
      // ② 失败 → ③ 也被尝试：两个 url 形态都在 postCalls 中（均失败）。
      const sessionCalls = fakeClient.postCalls.filter((c) =>
        c.url.startsWith("/api/session/"),
      );
      const globalCalls = fakeClient.postCalls.filter((c) =>
        c.url.startsWith("/question/"),
      );
      if (sessionCalls.length !== 1) {
        throw new Error(`expected 1 channel-2 call, got ${sessionCalls.length}`);
      }
      if (globalCalls.length !== 1) {
        throw new Error(`expected 1 channel-3 call (degraded), got ${globalCalls.length}`);
      }
      if (globalCalls[0].path?.requestID !== "req-a6") {
        throw new Error(`channel-3 path.requestID mismatch: ${globalCalls[0].path?.requestID}`);
      }
      if (globalCalls[0].query?.directory !== root) {
        throw new Error(`channel-3 query.directory must be root, got ${JSON.stringify(globalCalls[0].query)}`);
      }
      if (JSON.stringify(globalCalls[0].body) !== JSON.stringify({ answers: [["D"]] })) {
        throw new Error(`channel-3 body mismatch: ${JSON.stringify(globalCalls[0].body)}`);
      }
      const r6 = await findRecord("req-a6");
      if (!r6 || r6.resolved !== false) {
        throw new Error(`a6 must stay unresolved after non-404 failure: ${JSON.stringify(r6)}`);
      }
      // 下轮重试：postError 清除 → 通道②成功置位。
      fakeClient.postError = undefined;
      const second = await monitor.scanReplyQueue();
      if (second !== 1) {
        throw new Error(`expected 1 applied on retry, got ${second}`);
      }
      const r6b = await findRecord("req-a6");
      if (!r6b || r6b.resolved !== true) {
        throw new Error(`a6 resolved not true after retry success: ${JSON.stringify(r6b)}`);
      }
      await monitor.dispose();
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
  // 选项行 + ✏️ Custom + ❌ Cancel。
  // （Round 2 修订：契约 §14.8.4 后 ✏️ Custom 恒显示——本题 payload 无 custom
  // 字段，键盘由「选项 + Cancel」2 行变为「选项 + Custom + Cancel」3 行，
  // 断言最小修正：行数 2→3、cancelRow 索引 1→2；「无导航无提交」断言不变。）
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
      if (rows.length !== 3) {
        throw new Error(
          `expected 3 keyboard rows (options + custom + cancel), got ${rows.length}`,
        );
      }
      const optionRow = rows[0];
      if (optionRow.length !== 2) {
        throw new Error(`expected 2 option buttons, got ${optionRow.length}`);
      }
      const customRow = rows[1];
      if (
        customRow.length !== 1 ||
        customRow[0].text !== "✏️ Custom" ||
        customRow[0].callback_data !== "otg:q:req-201b:custom"
      ) {
        throw new Error(`unexpected custom row: ${JSON.stringify(customRow)}`);
      }
      const cancelRow = rows[2];
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

  // ---- Phase 1.3 (API-202/203/204) ----
  // 契约 docs/modules/sessions-relay.md §14.3/§14.5：question 向导回调状态机
  // （**无内存状态**——每次回调从盘上 registry 重建 q_draft/q_stage，断言一律
  // 以 findRecord 重新 read 的盘上内容为准）+ 纯文本自定义输入捕获 + /cancel
  // 命令。手法同 API-102：真实 handleCallback / handleTelegramUpdate + 全局
  // fetch stub 拦截 answerCallbackQuery / editMessageText。终态纪律（§14.5）：
  // q_answers/q_reject 已置的记录在用例内闭环到 resolved=true，不遗留
  // 可被扫描器拾取的记录；用例相互独立、不依赖执行顺序。
  function questionWizardCallback(id, data, text = "ORIGINAL") {
    return {
      id,
      from: { id: 123 },
      message: { message_id: 7, chat: { id: 123 }, text },
      data,
    };
  }
  function questionWizardRecord(requestID, questions, overrides = {}) {
    return makeRecord({
      request_id: requestID,
      type: "question",
      message: questionMessage(questions),
      ...overrides,
    });
  }
  // 执行一次 q 回调，返回该次产生的全部 telegram fetch 调用。
  async function runQCallback(monitor, data, text = "ORIGINAL") {
    const fetches = [];
    await stubFetch(fetches);
    try {
      await monitor.handleCallback(questionWizardCallback(`cb-${data}`, data, text));
    } finally {
      restoreFetch();
    }
    return fetches;
  }
  function answersOf(fetches) {
    return fetches.filter((call) => call.url.includes("answerCallbackQuery"));
  }
  function lastEdit(fetches) {
    const edits = fetches.filter((call) => call.url.includes("editMessageText"));
    return edits[edits.length - 1];
  }
  function editCount(fetches) {
    return fetches.filter((call) => call.url.includes("editMessageText")).length;
  }

  // API-202-1：单选多题自动跳下一题——q_draft/q_stage 落盘 + 编辑下一题
  // （键盘保留）→ 最后一题自动进总结（键盘变 Submit）。
  await runCase(
    "API-202-1 single-select auto-advance persists q_draft/q_stage and renders next question",
    async () => {
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          questionWizardRecord("req-202a", [
            { question: "请选择操作方式", options: [{ label: "读取" }, { label: "写入" }] },
            { question: "请确认改动范围", options: [{ label: "全局" }, { label: "局部" }] },
          ]),
        ),
      );
      const monitor = new TelegramSessionMonitor(fakeClient, fakeConfig, root, registry);
      try {
        // Q1 单选点选 → 自动跳 Q2（stage 0→1）。
        let fetches = await runQCallback(monitor, "otg:q:req-202a:o0");
        let persisted = await findRecord("req-202a");
        if (
          !persisted ||
          JSON.stringify(persisted.q_draft) !== JSON.stringify([["读取"], []])
        ) {
          throw new Error(`q_draft not persisted after Q1: ${JSON.stringify(persisted)}`);
        }
        if (persisted.q_stage !== 1) {
          throw new Error(`q_stage expected 1, got ${persisted.q_stage}`);
        }
        let ans = answersOf(fetches);
        if (
          ans.length !== 1 ||
          ans[0].body.text !== "已选「读取」" ||
          ans[0].body.show_alert !== false
        ) {
          throw new Error(`unexpected Q1 answer: ${JSON.stringify(fetches)}`);
        }
        let edit = lastEdit(fetches);
        if (!edit || !edit.body.text.includes("Question 2/2")) {
          throw new Error(`expected next-question edit, got ${JSON.stringify(fetches)}`);
        }
        if (!edit.body.reply_markup?.inline_keyboard) {
          throw new Error(`non-terminal edit must keep keyboard: ${JSON.stringify(edit.body)}`);
        }
        // Q2 单选点选 → 自动进总结（stage=2 = questions.length）。
        const fetches2 = await runQCallback(monitor, "otg:q:req-202a:o0");
        persisted = await findRecord("req-202a");
        if (
          !persisted ||
          persisted.q_stage !== 2 ||
          JSON.stringify(persisted.q_draft) !== JSON.stringify([["读取"], ["全局"]])
        ) {
          throw new Error(`summary state not persisted: ${JSON.stringify(persisted)}`);
        }
        const edit2 = lastEdit(fetches2);
        const text2 = edit2?.body?.text ?? "";
        if (!edit2 || !text2.includes("Question 1/2") || !text2.includes("Question 2/2")) {
          throw new Error(`summary edit must render all questions: ${JSON.stringify(fetches2)}`);
        }
        const buttons2 = edit2.body.reply_markup?.inline_keyboard?.flatMap((row) => row) ?? [];
        if (!buttons2.some((button) => button.text === "✅ Submit")) {
          throw new Error(`summary keyboard must contain Submit: ${JSON.stringify(edit2.body)}`);
        }
      } finally {
        // 终态纪律：q_answers 未置 → 用例内闭环到 resolved。
        await registry.mutate((reg) => markSessionResolved(reg, "req-202a"));
        await monitor.dispose();
      }
    },
  );

  // API-202-2：多选题 toggle ✓ 落盘 + 编辑刷新（✅ 前缀）；单问题多选不触发
  // 直接提交。
  await runCase(
    "API-202-2 multi-select toggle persists q_draft, refresh edit shows ✅ prefix, no direct submit",
    async () => {
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          questionWizardRecord("req-202b", [
            {
              question: "多选影响范围",
              options: [{ label: "A" }, { label: "B" }],
              multiple: true,
            },
          ]),
        ),
      );
      const monitor = new TelegramSessionMonitor(fakeClient, fakeConfig, root, registry);
      try {
        // 选 A → 已选 1 项；编辑文本刷新出 ✅ A。
        let fetches = await runQCallback(monitor, "otg:q:req-202b:o0");
        let persisted = await findRecord("req-202b");
        if (!persisted || JSON.stringify(persisted.q_draft) !== JSON.stringify([["A"]])) {
          throw new Error(`toggle-on not persisted: ${JSON.stringify(persisted)}`);
        }
        let ans = answersOf(fetches);
        if (ans.length !== 1 || ans[0].body.text !== "已选 1 项") {
          throw new Error(`unexpected toggle-on answer: ${JSON.stringify(fetches)}`);
        }
        let edit = lastEdit(fetches);
        if (!edit || !edit.body.text.includes("✅ A")) {
          throw new Error(`refresh edit must show ✅ prefix: ${JSON.stringify(fetches)}`);
        }
        // 再点 A → toggle 掉：已选 0 项，✅ 前缀消失。
        const fetches2 = await runQCallback(monitor, "otg:q:req-202b:o0");
        persisted = await findRecord("req-202b");
        if (!persisted || JSON.stringify(persisted.q_draft) !== JSON.stringify([[]])) {
          throw new Error(`toggle-off not persisted: ${JSON.stringify(persisted)}`);
        }
        ans = answersOf(fetches2);
        if (ans.length !== 1 || ans[0].body.text !== "已选 0 项") {
          throw new Error(`unexpected toggle-off answer: ${JSON.stringify(fetches2)}`);
        }
        edit = lastEdit(fetches2);
        if (!edit || edit.body.text.includes("✅ A")) {
          throw new Error(`refresh edit must drop ✅ prefix: ${JSON.stringify(fetches2)}`);
        }
        // 点 B → 已选 1 项。
        const fetches3 = await runQCallback(monitor, "otg:q:req-202b:o1");
        persisted = await findRecord("req-202b");
        if (!persisted || JSON.stringify(persisted.q_draft) !== JSON.stringify([["B"]])) {
          throw new Error(`toggle B not persisted: ${JSON.stringify(persisted)}`);
        }
        if (persisted.q_answers != null) {
          throw new Error(`single-question multi-select must not auto-submit: ${JSON.stringify(persisted)}`);
        }
      } finally {
        await registry.mutate((reg) => markSessionResolved(reg, "req-202b"));
        await monitor.dispose();
      }
    },
  );

  // API-202-3：prev/next 阶段钳制（next 上限=总结阶段；prev 下限 0），答案
  // 保留不丢；每步落盘。
  await runCase(
    "API-202-3 prev/next clamp q_stage at 0..questions.length and keep answers",
    async () => {
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          questionWizardRecord("req-202c", [
            { question: "Q1", options: [{ label: "A1" }, { label: "A2" }] },
            { question: "Q2", options: [{ label: "B1" }, { label: "B2" }] },
            { question: "Q3", options: [{ label: "C1" }, { label: "C2" }] },
          ]),
        ),
      );
      const monitor = new TelegramSessionMonitor(fakeClient, fakeConfig, root, registry);
      try {
        // 起点 stage 0：prev 钳制在 0。
        let fetches = await runQCallback(monitor, "otg:q:req-202c:prev");
        let persisted = await findRecord("req-202c");
        if (!persisted || persisted.q_stage !== 0) {
          throw new Error(`prev at 0 must clamp to 0: ${JSON.stringify(persisted)}`);
        }
        if (editCount(fetches) !== 1 || !lastEdit(fetches).body.text.includes("Question 1/3")) {
          throw new Error(`prev edit should render Q1: ${JSON.stringify(fetches)}`);
        }
        // next ×3 → 3（总结阶段；=questions.length）。
        for (let step = 1; step <= 3; step++) {
          await runQCallback(monitor, "otg:q:req-202c:next");
        }
        persisted = await findRecord("req-202c");
        if (!persisted || persisted.q_stage !== 3) {
          throw new Error(`next ×3 should reach summary stage 3: ${JSON.stringify(persisted)}`);
        }
        // 总结阶段再 next → 仍 3（上界钳制）。
        fetches = await runQCallback(monitor, "otg:q:req-202c:next");
        persisted = await findRecord("req-202c");
        if (!persisted || persisted.q_stage !== 3) {
          throw new Error(`next at summary must clamp to 3: ${JSON.stringify(persisted)}`);
        }
        if (!lastEdit(fetches).body.text.includes("Question 1/3")) {
          throw new Error(`summary edit must render answer rows: ${JSON.stringify(fetches)}`);
        }
        // prev → 2。
        fetches = await runQCallback(monitor, "otg:q:req-202c:prev");
        persisted = await findRecord("req-202c");
        if (!persisted || persisted.q_stage !== 2) {
          throw new Error(`prev from summary should reach 2: ${JSON.stringify(persisted)}`);
        }
        const ans = answersOf(fetches);
        if (ans.length !== 1 || ans[0].body.text !== "已跳转") {
          throw new Error(`nav answer must be 已跳转: ${JSON.stringify(fetches)}`);
        }
        if (!lastEdit(fetches).body.text.includes("Question 3/3")) {
          throw new Error(`prev edit should render Q3 (stage 2): ${JSON.stringify(fetches)}`);
        }
      } finally {
        await registry.mutate((reg) => markSessionResolved(reg, "req-202c"));
        await monitor.dispose();
      }
    },
  );

  // API-202-4：Submit 守卫——任意阶段可提交（Phase 1.5 修订，契约 §14.3.1；
  // 原先非总结阶段 Unknown action 已取消）；带未答题提交 → 提示题号、
  // 不提交不编辑；全答 → q_answers 写入 + ✅ 编辑（键盘移除）。
  await runCase(
    "API-202-4 submit gate: reject unanswered with question number, then submit all → q_answers + ✅ edit",
    async () => {
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          questionWizardRecord("req-202d", [
            { question: "操作方式", options: [{ label: "读取" }, { label: "写入" }] },
            { question: "改动范围", options: [{ label: "全局" }, { label: "局部" }] },
          ]),
        ),
      );
      const monitor = new TelegramSessionMonitor(fakeClient, fakeConfig, root, registry);
      try {
        // 进入总结（stage 2）后 Submit：第 1 题未答 → 拒绝、不编辑。
        await runQCallback(monitor, "otg:q:req-202d:next");
        await runQCallback(monitor, "otg:q:req-202d:next");
        let fetches = await runQCallback(monitor, "otg:q:req-202d:submit");
        let ans = answersOf(fetches);
        if (
          ans.length !== 1 ||
          ans[0].body.text !== "第 1 题未作答，请先作答" ||
          ans[0].body.show_alert !== false
        ) {
          throw new Error(`unanswered hint expected: ${JSON.stringify(fetches)}`);
        }
        if (editCount(fetches) !== 0) {
          throw new Error(`rejected submit must not edit: ${JSON.stringify(fetches)}`);
        }
        let persisted = await findRecord("req-202d");
        if (persisted.q_answers != null) {
          throw new Error(`q_answers must not be written on rejected submit: ${JSON.stringify(persisted)}`);
        }
        // 非总结阶段 submit：守卫已放宽为任意 stage（Phase 1.5，契约 §14.3.1
        // 修订）——不再 Unknown action，仍走 draft 非空校验：Q1 未答 → 提示题号。
        await runQCallback(monitor, "otg:q:req-202d:prev");
        fetches = await runQCallback(monitor, "otg:q:req-202d:submit");
        ans = answersOf(fetches);
        if (ans.length !== 1 || ans[0].body.text !== "第 1 题未作答，请先作答") {
          throw new Error(`non-summary submit must answer unanswered hint: ${JSON.stringify(fetches)}`);
        }
        if (editCount(fetches) !== 0) {
          throw new Error(`non-summary submit must not edit: ${JSON.stringify(fetches)}`);
        }
        // 答 Q2（stage 1）→ 自动进总结 → Submit 仍提示第 1 题未答。
        await runQCallback(monitor, "otg:q:req-202d:o1");
        fetches = await runQCallback(monitor, "otg:q:req-202d:submit");
        ans = answersOf(fetches);
        if (ans.length !== 1 || ans[0].body.text !== "第 1 题未作答，请先作答") {
          throw new Error(`still-unanswered Q1 hint expected: ${JSON.stringify(fetches)}`);
        }
        if (editCount(fetches) !== 0) {
          throw new Error(`still-unanswered submit must not edit: ${JSON.stringify(fetches)}`);
        }
        // 回 Q1 作答（prev×2 到 0，点 o1=写入）→ 进总结 → Submit 全答 →
        // q_answers 写入 + ✅ 编辑（键盘移除）。
        await runQCallback(monitor, "otg:q:req-202d:prev");
        await runQCallback(monitor, "otg:q:req-202d:prev");
        await runQCallback(monitor, "otg:q:req-202d:o1");
        await runQCallback(monitor, "otg:q:req-202d:next");
        fetches = await runQCallback(monitor, "otg:q:req-202d:submit");
        persisted = await findRecord("req-202d");
        if (
          !persisted ||
          JSON.stringify(persisted.q_answers) !== JSON.stringify([["写入"], ["局部"]])
        ) {
          throw new Error(`q_answers not persisted on submit: ${JSON.stringify(persisted)}`);
        }
        ans = answersOf(fetches);
        if (ans.length !== 1 || ans[0].body.text !== "已提交") {
          throw new Error(`submit confirm expected: ${JSON.stringify(fetches)}`);
        }
        const edit = lastEdit(fetches);
        if (!edit || edit.body.text !== "ORIGINAL\n✅ Submitted") {
          throw new Error(`submit edit must append ✅ Submitted: ${JSON.stringify(fetches)}`);
        }
        if (edit.body.reply_markup !== undefined) {
          throw new Error(`terminal edit must drop keyboard: ${JSON.stringify(edit.body)}`);
        }
      } finally {
        await registry.mutate((reg) => markSessionResolved(reg, "req-202d"));
        await monitor.dispose();
      }
    },
  );

  // API-202-5：单问题请求点选项 → 直接提交（q_answers + ✅ 编辑，键盘移除；
  // 不写 q_draft/q_stage）。
  await runCase(
    "API-202-5 single-question option click directly submits q_answers",
    async () => {
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          questionWizardRecord("req-202e", [
            { question: "是否允许读取", options: [{ label: "允许" }, { label: "拒绝" }] },
          ]),
        ),
      );
      const monitor = new TelegramSessionMonitor(fakeClient, fakeConfig, root, registry);
      try {
        const fetches = await runQCallback(monitor, "otg:q:req-202e:o1");
        const persisted = await findRecord("req-202e");
        if (!persisted || JSON.stringify(persisted.q_answers) !== JSON.stringify([["拒绝"]])) {
          throw new Error(`direct submit not persisted: ${JSON.stringify(persisted)}`);
        }
        if (persisted.q_draft !== undefined || persisted.q_stage !== undefined) {
          throw new Error(`single-question direct submit must not write draft/stage: ${JSON.stringify(persisted)}`);
        }
        const ans = answersOf(fetches);
        if (ans.length !== 1 || ans[0].body.text !== "已提交") {
          throw new Error(`direct submit confirm expected: ${JSON.stringify(fetches)}`);
        }
        const edit = lastEdit(fetches);
        if (!edit || edit.body.text !== "ORIGINAL\n✅ Submitted" || edit.body.reply_markup !== undefined) {
          throw new Error(`direct submit edit must be ✅ without keyboard: ${JSON.stringify(fetches)}`);
        }
      } finally {
        await registry.mutate((reg) => markSessionResolved(reg, "req-202e"));
        await monitor.dispose();
      }
    },
  );

  // API-202-6：失效路径——记录不存在 / 已 resolved / 已 q_answers / 已
  // q_reject / message 解析失败 → 「记录不存在或已失效」(alert) + 不编辑；
  // 选项越界 → 「选项无效」；正则不命中 → Unknown action。
  await runCase(
    "API-202-6 stale/invalid callbacks answer invalid, do not edit",
    async () => {
      // 预置各类失效记录。
      await registry.mutate((reg) => {
        let next = reg;
        next = appendSessionRecord(reg, root, questionWizardRecord("req-202f1", [
          { question: "Q", options: [{ label: "A" }] },
        ], { resolved: true }));
        next = appendSessionRecord(next, root, questionWizardRecord("req-202f2", [
          { question: "Q", options: [{ label: "A" }] },
        ], { q_answers: [["A"]] }));
        next = appendSessionRecord(next, root, questionWizardRecord("req-202f3", [
          { question: "Q", options: [{ label: "A" }] },
        ], { q_reject: true }));
        return appendSessionRecord(next, root, questionWizardRecord("req-202f4", [
          { question: "Q", options: [{ label: "A" }] },
        ], { message: "not-a-json" }));
      });
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          questionWizardRecord("req-202f5", [
            { question: "正常题", options: [{ label: "A" }, { label: "B" }] },
          ]),
        ),
      );
      const monitor = new TelegramSessionMonitor(fakeClient, fakeConfig, root, registry);
      try {
        for (const data of [
          "otg:q:req-none:o0",
          "otg:q:req-202f1:o0",
          "otg:q:req-202f2:o0",
          "otg:q:req-202f3:o0",
          "otg:q:req-202f4:o0",
        ]) {
          const fetches = await runQCallback(monitor, data);
          const ans = answersOf(fetches);
          if (
            ans.length !== 1 ||
            ans[0].body.text !== "记录不存在或已失效" ||
            ans[0].body.show_alert !== true
          ) {
            throw new Error(`expected invalid answer for ${data}: ${JSON.stringify(fetches)}`);
          }
          if (editCount(fetches) !== 0) {
            throw new Error(`no edit expected for ${data}: ${JSON.stringify(fetches)}`);
          }
        }
        // 选项越界（合法记录 req-202f5）。
        const fetches = await runQCallback(monitor, "otg:q:req-202f5:o9");
        const ans = answersOf(fetches);
        if (ans.length !== 1 || ans[0].body.text !== "选项无效") {
          throw new Error(`out-of-range option must answer 选项无效: ${JSON.stringify(fetches)}`);
        }
        if (editCount(fetches) !== 0) {
          throw new Error(`out-of-range option must not edit: ${JSON.stringify(fetches)}`);
        }
        // 正则不命中（非法后缀）。
        const bad = await runQCallback(monitor, "otg:q:req-202f5:foobar");
        const badAns = answersOf(bad);
        if (badAns.length !== 1 || badAns[0].body.text !== "Unknown action") {
          throw new Error(`regex-miss must answer Unknown action: ${JSON.stringify(bad)}`);
        }
        if (editCount(bad) !== 0) {
          throw new Error(`regex-miss must not edit: ${JSON.stringify(bad)}`);
        }
      } finally {
        for (const requestID of ["req-202f1", "req-202f2", "req-202f3", "req-202f4", "req-202f5"]) {
          await registry.mutate((reg) => markSessionResolved(reg, requestID));
        }
        await monitor.dispose();
      }
    },
  );

  // API-202-7：重启重建——直接构造带 q_draft/q_stage 的记录（模拟盘上旧状态）
  // → 回调继续从该状态前进并可提交。
  await runCase(
    "API-202-7 restart rebuild: record with persisted q_draft/q_stage resumes wizard",
    async () => {
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          questionWizardRecord("req-202g", [
            { question: "操作方式", options: [{ label: "读取" }, { label: "写入" }] },
            { question: "改动范围", options: [{ label: "全局" }, { label: "局部" }] },
          ], { q_draft: [["读取"], []], q_stage: 1 }),
        ),
      );
      const monitor = new TelegramSessionMonitor(fakeClient, fakeConfig, root, registry);
      try {
        // 从 stage 1 继续：点 Q2 选项 → 进总结。
        const fetches = await runQCallback(monitor, "otg:q:req-202g:o0");
        const persisted = await findRecord("req-202g");
        if (
          !persisted ||
          persisted.q_stage !== 2 ||
          JSON.stringify(persisted.q_draft) !== JSON.stringify([["读取"], ["全局"]])
        ) {
          throw new Error(`resumed wizard state wrong: ${JSON.stringify(persisted)}`);
        }
        const ans = answersOf(fetches);
        if (ans.length !== 1 || ans[0].body.text !== "已选「全局」") {
          throw new Error(`resumed answer expected: ${JSON.stringify(fetches)}`);
        }
        // 提交 → q_answers。
        const fetches2 = await runQCallback(monitor, "otg:q:req-202g:submit");
        const persisted2 = await findRecord("req-202g");
        if (!persisted2 || JSON.stringify(persisted2.q_answers) !== JSON.stringify([["读取"], ["全局"]])) {
          throw new Error(`resumed submit failed: ${JSON.stringify(persisted2)}`);
        }
        const edit = lastEdit(fetches2);
        if (!edit || edit.body.text !== "ORIGINAL\n✅ Submitted") {
          throw new Error(`resumed submit edit expected: ${JSON.stringify(fetches2)}`);
        }
      } finally {
        await registry.mutate((reg) => markSessionResolved(reg, "req-202g"));
        await monitor.dispose();
      }
    },
  );

  // API-203-1：✏️ Custom → q_input 落盘 + 提示编辑（键盘保留）→ 纯文本消息
  // → draft[q_input] 写入 + 清输入 + 推进（多问题）+ 回复确认。
  await runCase(
    "API-203-1 custom input: q_input persisted, plain text writes draft, advances, confirms",
    async () => {
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          questionWizardRecord("req-203a", [
            {
              question: "补充说明",
              options: [{ label: "默认" }],
              custom: true,
            },
            { question: "后续问题", options: [{ label: "是" }, { label: "否" }] },
          ], { q_msg_id: 42 }),
        ),
      );
      const monitor = new TelegramSessionMonitor(fakeClient, fakeConfig, root, registry);
      const sent = [];
      monitor.sendMessage = async (text) => {
        sent.push(text);
      };
      try {
        // 点 ✏️ Custom → q_input=0 落盘；answer 提示；编辑含输入提示行、键盘保留。
        let fetches = await runQCallback(monitor, "otg:q:req-203a:custom");
        let persisted = await findRecord("req-203a");
        if (!persisted || persisted.q_input !== 0) {
          throw new Error(`q_input not persisted: ${JSON.stringify(persisted)}`);
        }
        let ans = answersOf(fetches);
        if (ans.length !== 1 || ans[0].body.text !== "直接回复文本作为答案，/cancel 取消") {
          throw new Error(`custom entry answer expected: ${JSON.stringify(fetches)}`);
        }
        let edit = lastEdit(fetches);
        if (!edit || !edit.body.text.includes("✏️ 回复文本作为答案，/cancel 取消")) {
          throw new Error(`custom edit must show input hint: ${JSON.stringify(fetches)}`);
        }
        if (!edit.body.reply_markup?.inline_keyboard) {
          throw new Error(`custom edit must keep keyboard: ${JSON.stringify(edit.body)}`);
        }
        // 纯文本回复 → 写入 draft[0]、清 q_input、推进到 Q2（编辑渲染下一题）。
        const textFetches = [];
        await stubFetch(textFetches);
        try {
          await monitor.handleTelegramUpdate({
            update_id: 1,
            message: {
              message_id: 99,
              text: "我的自由回答",
              from: { id: 123 },
              chat: { id: 123, type: "private" },
            },
          });
        } finally {
          restoreFetch();
        }
        persisted = await findRecord("req-203a");
        if (!persisted || JSON.stringify(persisted.q_draft) !== JSON.stringify([["我的自由回答"], []])) {
          throw new Error(`text answer not persisted: ${JSON.stringify(persisted)}`);
        }
        if (persisted.q_input !== null && persisted.q_input !== undefined) {
          throw new Error(`q_input must be cleared after text answer: ${JSON.stringify(persisted)}`);
        }
        if (persisted.q_stage !== 1) {
          throw new Error(`q_stage must advance to 1: ${JSON.stringify(persisted)}`);
        }
        const textEdit = lastEdit(textFetches);
        if (!textEdit || !textEdit.body.text.includes("Question 2/2")) {
          throw new Error(`text input must edit to next question: ${JSON.stringify(textFetches)}`);
        }
        if (textEdit.body.message_id !== 42) {
          throw new Error(`text input edit must target record.q_msg_id: ${JSON.stringify(textEdit.body)}`);
        }
        if (!textEdit.body.reply_markup?.inline_keyboard) {
          throw new Error(`text input edit must keep keyboard: ${JSON.stringify(textEdit.body)}`);
        }
        await monitor.dispose(); // flush enqueueMessage tail
        if (!sent.join(" ").includes("已记录第 1 题答案")) {
          throw new Error(`confirmation message missing: ${JSON.stringify(sent)}`);
        }
      } finally {
        await registry.mutate((reg) => markSessionResolved(reg, "req-203a"));
        await monitor.dispose();
      }
    },
  );

  // API-203-2：单问题 custom → 纯文本直接提交（q_answers + ✅ 编辑键盘移除 +
  // 确认文案）。
  await runCase(
    "API-203-2 single-question custom text directly submits q_answers",
    async () => {
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          questionWizardRecord("req-203b", [
            { question: "请补充路径", options: [], custom: true },
          ], { q_msg_id: 42 }),
        ),
      );
      const monitor = new TelegramSessionMonitor(fakeClient, fakeConfig, root, registry);
      const sent = [];
      monitor.sendMessage = async (text) => {
        sent.push(text);
      };
      try {
        await runQCallback(monitor, "otg:q:req-203b:custom");
        const fetches = [];
        await stubFetch(fetches);
        try {
          await monitor.handleTelegramUpdate({
            update_id: 1,
            message: {
              message_id: 100,
              text: "   /home/hipc/project  ",
              from: { id: 123 },
              chat: { id: 123, type: "private" },
            },
          });
        } finally {
          restoreFetch();
        }
        const persisted = await findRecord("req-203b");
        if (!persisted || JSON.stringify(persisted.q_answers) !== JSON.stringify([["/home/hipc/project"]])) {
          throw new Error(`single-question text submit failed: ${JSON.stringify(persisted)}`);
        }
        if (persisted.q_input !== null && persisted.q_input !== undefined) {
          throw new Error(`q_input must be cleared: ${JSON.stringify(persisted)}`);
        }
        const edit = lastEdit(fetches);
        if (!edit || !edit.body.text.includes("✅ Submitted")) {
          throw new Error(`single-question text submit edit expected: ${JSON.stringify(fetches)}`);
        }
        if (edit.body.message_id !== 42) {
          throw new Error(`text submit edit must target record.q_msg_id: ${JSON.stringify(edit.body)}`);
        }
        if (edit.body.reply_markup !== undefined) {
          throw new Error(`terminal edit must drop keyboard: ${JSON.stringify(edit.body)}`);
        }
        await monitor.dispose();
        if (!sent.join(" ").includes("已记录第 1 题答案")) {
          throw new Error(`confirmation message missing: ${JSON.stringify(sent)}`);
        }
      } finally {
        await registry.mutate((reg) => markSessionResolved(reg, "req-203b"));
        await monitor.dispose();
      }
    },
  );

  // API-203-3：/cancel 命令清除全部 q_input + 确认文案；无输入态纯文本静默。
  await runCase(
    "API-203-3 /cancel clears all q_input and confirms; plain text without pending input is silent",
    async () => {
      const monitor = new TelegramSessionMonitor(fakeClient, fakeConfig, root, registry);
      const sent = [];
      monitor.sendMessage = async (text) => {
        sent.push(text);
      };
      try {
        // 先做无输入态静默检查（此刻 registry 无任何 q_input 待输入记录——
        // 既有记录全部已 resolved，handleQuestionTextInput 扫描不命中）。
        const silentFetches = [];
        await stubFetch(silentFetches);
        try {
          await monitor.handleTelegramUpdate({
            update_id: 1,
            message: {
              message_id: 101,
              text: "随便说点什么",
              from: { id: 123 },
              chat: { id: 123, type: "private" },
            },
          });
        } finally {
          restoreFetch();
        }
        if (editCount(silentFetches) !== 0) {
          throw new Error(`no edit expected for idle text: ${JSON.stringify(silentFetches)}`);
        }
        if (sent.length !== 0) {
          throw new Error(`no confirmation expected for idle text: ${JSON.stringify(sent)}`);
        }
        // 再建两条 q_input 待输入记录，/cancel → 全部清除（键删除）＋ 确认文案。
        await registry.mutate((reg) => {
          let next = reg;
          next = appendSessionRecord(next, root, questionWizardRecord("req-203c", [
            { question: "Q", options: [], custom: true },
          ], { q_input: 0 }));
          return appendSessionRecord(next, root, questionWizardRecord("req-203d", [
            { question: "Q", options: [], custom: true },
          ], { q_input: 1 }));
        });
        // 注意：必须先 handleTelegramUpdate 再 dispose（enqueueMessage 在
        // disposed 后短路）。
        await monitor.handleTelegramUpdate({
          update_id: 2,
          message: {
            message_id: 102,
            text: "/cancel",
            from: { id: 123 },
            chat: { id: 123, type: "private" },
          },
        });
        const c = await findRecord("req-203c");
        const d = await findRecord("req-203d");
        if ((c && c.q_input !== undefined) || (d && d.q_input !== undefined)) {
          throw new Error(`/cancel must clear all q_input: ${JSON.stringify({ c, d })}`);
        }
        await monitor.dispose();
        if (!sent.join(" ").includes("已取消输入模式")) {
          throw new Error(`/cancel confirmation missing: ${JSON.stringify(sent)}`);
        }
      } finally {
        await registry.mutate((reg) => markSessionResolved(reg, "req-203c"));
        await registry.mutate((reg) => markSessionResolved(reg, "req-203d"));
        await monitor.dispose();
      }
    },
  );

  // API-203-4：Round 2 修订（契约 §14.8.4 测试影响）——custom **恒可用**：
  // payload 无 custom 字段的普通题点 ✏️ Custom 同样进入输入模式（q_input
  // 落盘 + 提示 + 编辑键盘保留）。原「该题不支持自定义输入 + 不落盘不编辑」
  // 语义不再成立（真实 question payload 从不带 custom 标志）。
  await runCase(
    "API-203-4 custom on non-custom question enters input mode (always available)",
    async () => {
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          questionWizardRecord("req-203e", [
            { question: "普通题", options: [{ label: "A" }] },
          ]),
        ),
      );
      const monitor = new TelegramSessionMonitor(fakeClient, fakeConfig, root, registry);
      try {
        const fetches = await runQCallback(monitor, "otg:q:req-203e:custom");
        const ans = answersOf(fetches);
        if (
          ans.length !== 1 ||
          ans[0].body.text !== "直接回复文本作为答案，/cancel 取消"
        ) {
          throw new Error(`custom entry answer expected: ${JSON.stringify(fetches)}`);
        }
        const edit = lastEdit(fetches);
        if (!edit || !edit.body.text.includes("✏️ 回复文本作为答案，/cancel 取消")) {
          throw new Error(`custom edit must show input hint: ${JSON.stringify(fetches)}`);
        }
        if (!edit.body.reply_markup?.inline_keyboard) {
          throw new Error(`custom edit must keep keyboard: ${JSON.stringify(edit.body)}`);
        }
        const persisted = await findRecord("req-203e");
        if (!persisted || persisted.q_input !== 0) {
          throw new Error(`q_input must be set to 0: ${JSON.stringify(persisted)}`);
        }
      } finally {
        await registry.mutate((reg) => markSessionResolved(reg, "req-203e"));
        await monitor.dispose();
      }
    },
  );

  // API-204-1：任意阶段 ❌ → q_reject 落盘 + answer + 编辑 ❌（键盘移除）；
  // 已取消记录再点按钮 → 失效提示。
  await runCase(
    "API-204-1 cancel writes q_reject, edits ❌ without keyboard, later clicks answer invalid",
    async () => {
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          questionWizardRecord("req-204a", [
            { question: "Q1", options: [{ label: "A" }, { label: "B" }] },
            { question: "Q2", options: [{ label: "C" }, { label: "D" }] },
          ]),
        ),
      );
      const monitor = new TelegramSessionMonitor(fakeClient, fakeConfig, root, registry);
      try {
        const fetches = await runQCallback(monitor, "otg:q:req-204a:cancel");
        const persisted = await findRecord("req-204a");
        if (!persisted || persisted.q_reject !== true) {
          throw new Error(`q_reject not persisted: ${JSON.stringify(persisted)}`);
        }
        const ans = answersOf(fetches);
        if (ans.length !== 1 || ans[0].body.text !== "已取消") {
          throw new Error(`cancel answer expected: ${JSON.stringify(fetches)}`);
        }
        const edit = lastEdit(fetches);
        if (!edit || edit.body.text !== "ORIGINAL\n❌ Cancelled") {
          throw new Error(`cancel edit must append ❌ Cancelled: ${JSON.stringify(fetches)}`);
        }
        if (edit.body.reply_markup !== undefined) {
          throw new Error(`cancel edit must drop keyboard: ${JSON.stringify(edit.body)}`);
        }
        // 已取消记录再点选项 → 失效提示、不编辑。
        const later = await runQCallback(monitor, "otg:q:req-204a:o0");
        const laterAns = answersOf(later);
        if (laterAns.length !== 1 || laterAns[0].body.text !== "记录不存在或已失效") {
          throw new Error(`cancelled record must answer invalid: ${JSON.stringify(later)}`);
        }
        if (editCount(later) !== 0) {
          throw new Error(`cancelled record click must not edit: ${JSON.stringify(later)}`);
        }
      } finally {
        await registry.mutate((reg) => markSessionResolved(reg, "req-204a"));
        await monitor.dispose();
      }
    },
  );

  // API-204-2：总结阶段/输入模式下 ❌ 同样生效（任意阶段可用）。
  await runCase(
    "API-204-2 cancel works from summary stage and from custom input mode",
    async () => {
      await registry.mutate((reg) => {
        let next = reg;
        next = appendSessionRecord(next, root, questionWizardRecord("req-204b", [
          { question: "Q1", options: [{ label: "A" }] },
          { question: "Q2", options: [{ label: "B" }] },
        ], { q_draft: [["A"], ["B"]], q_stage: 2 }));
        return appendSessionRecord(next, root, questionWizardRecord("req-204c", [
          { question: "Q1", options: [], custom: true },
        ], { q_input: 0 }));
      });
      const monitor = new TelegramSessionMonitor(fakeClient, fakeConfig, root, registry);
      try {
        // 总结阶段取消。
        const fetches = await runQCallback(monitor, "otg:q:req-204b:cancel");
        let persisted = await findRecord("req-204b");
        if (!persisted || persisted.q_reject !== true) {
          throw new Error(`summary cancel not persisted: ${JSON.stringify(persisted)}`);
        }
        if (editCount(fetches) !== 1 || !lastEdit(fetches).body.text.includes("❌ Cancelled")) {
          throw new Error(`summary cancel edit expected: ${JSON.stringify(fetches)}`);
        }
        // 输入模式下取消。
        const fetches2 = await runQCallback(monitor, "otg:q:req-204c:cancel");
        persisted = await findRecord("req-204c");
        if (!persisted || persisted.q_reject !== true) {
          throw new Error(`input-mode cancel not persisted: ${JSON.stringify(persisted)}`);
        }
        if (editCount(fetches2) !== 1 || !lastEdit(fetches2).body.text.includes("❌ Cancelled")) {
          throw new Error(`input-mode cancel edit expected: ${JSON.stringify(fetches2)}`);
        }
      } finally {
        await registry.mutate((reg) => markSessionResolved(reg, "req-204b"));
        await registry.mutate((reg) => markSessionResolved(reg, "req-204c"));
        await monitor.dispose();
      }
    },
  );

  // API-202-8：单问题多选死角修复（Phase 1.5，契约 §14.2.1/§14.3.1 修订）——
  // 单问题 multiple 请求键盘含 ✅ Submit（callback_data `otg:q:<req>:submit`）：
  // 未选任何项 Submit → 提示第 1 题未作答、不提交不编辑；toggle 两个选项后
  // Submit → q_answers=[[A,B]] 落盘 + ✅ 编辑（键盘移除）终态闭环；toggle
  // 本身仍不自动提交（原 API-202-2 断言保留）。
  await runCase(
    "API-202-8 single-question multi-select: submit button present, empty submit rejected, toggle+submit persists q_answers",
    async () => {
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          questionWizardRecord("req-202h", [
            {
              question: "多选影响范围",
              options: [{ label: "A" }, { label: "B" }],
              multiple: true,
            },
          ]),
        ),
      );
      const monitor = new TelegramSessionMonitor(fakeClient, fakeConfig, root, registry);
      let sentKeyboard;
      monitor.sendMessage = async () => {};
      monitor.sendMessageWithKeyboard = async (text, keyboard) => {
        sentKeyboard = keyboard;
        return 42;
      };
      try {
        // 发送阶段：键盘 = 选项行 + ✏️ Custom + [✅ Submit, ❌ Cancel]（单问题
        // 多选不再无提交路径；Round 2 修订：custom 恒显示后 3 行，submitRow
        // 索引 1→2）。
        await monitor.scanSessionQueue();
        if (!sentKeyboard) {
          throw new Error("single-question multi-select must be sent via keyboard");
        }
        const rows = sentKeyboard.inline_keyboard;
        if (rows.length !== 3) {
          throw new Error(
            `expected 3 keyboard rows (options + custom + submit/cancel), got ${rows.length}`,
          );
        }
        const optionRow = rows[0];
        if (optionRow.length !== 2) {
          throw new Error(`expected 2 option buttons, got ${optionRow.length}`);
        }
        const submitRow = rows[2];
        if (
          submitRow.length !== 2 ||
          submitRow[0].text !== "✅ Submit" ||
          submitRow[0].callback_data !== "otg:q:req-202h:submit" ||
          submitRow[1].text !== "❌ Cancel" ||
          submitRow[1].callback_data !== "otg:q:req-202h:cancel"
        ) {
          throw new Error(`unexpected submit row: ${JSON.stringify(submitRow)}`);
        }
        // 未选任何项 Submit → 提示、不提交不编辑。
        let fetches = await runQCallback(monitor, "otg:q:req-202h:submit");
        let ans = answersOf(fetches);
        if (ans.length !== 1 || ans[0].body.text !== "第 1 题未作答，请先作答") {
          throw new Error(`empty submit must be rejected: ${JSON.stringify(fetches)}`);
        }
        if (editCount(fetches) !== 0) {
          throw new Error(`empty submit must not edit: ${JSON.stringify(fetches)}`);
        }
        let persisted = await findRecord("req-202h");
        if (persisted.q_answers != null) {
          throw new Error(
            `empty submit must not write q_answers: ${JSON.stringify(persisted)}`,
          );
        }
        // toggle A → 1 项；toggle B → 2 项（仍不自动提交，原 API-202-2 语义）。
        await runQCallback(monitor, "otg:q:req-202h:o0");
        fetches = await runQCallback(monitor, "otg:q:req-202h:o1");
        ans = answersOf(fetches);
        if (ans.length !== 1 || ans[0].body.text !== "已选 2 项") {
          throw new Error(`toggle B answer expected: ${JSON.stringify(fetches)}`);
        }
        persisted = await findRecord("req-202h");
        if (
          !persisted ||
          JSON.stringify(persisted.q_draft) !== JSON.stringify([["A", "B"]]) ||
          persisted.q_answers != null
        ) {
          throw new Error(
            `toggle must persist draft without auto-submit: ${JSON.stringify(persisted)}`,
          );
        }
        // Submit → q_answers=[[A,B]] + ✅ 编辑（键盘移除）。
        fetches = await runQCallback(monitor, "otg:q:req-202h:submit");
        persisted = await findRecord("req-202h");
        if (
          !persisted ||
          JSON.stringify(persisted.q_answers) !== JSON.stringify([["A", "B"]])
        ) {
          throw new Error(
            `q_answers not persisted on submit: ${JSON.stringify(persisted)}`,
          );
        }
        ans = answersOf(fetches);
        if (ans.length !== 1 || ans[0].body.text !== "已提交") {
          throw new Error(`submit confirm expected: ${JSON.stringify(fetches)}`);
        }
        const edit = lastEdit(fetches);
        if (!edit || edit.body.text !== "ORIGINAL\n✅ Submitted") {
          throw new Error(`submit edit must append ✅ Submitted: ${JSON.stringify(fetches)}`);
        }
        if (edit.body.reply_markup !== undefined) {
          throw new Error(`terminal edit must drop keyboard: ${JSON.stringify(edit.body)}`);
        }
      } finally {
        await registry.mutate((reg) => markSessionResolved(reg, "req-202h"));
        await monitor.dispose();
      }
    },
  );

  // ---- API-207: interaction fixes (round 2) ----
  // 契约 docs/modules/sessions-relay.md §14.8.7：① 任意题键盘恒含 ✏️ Custom
  // （payload 无 custom 字段也含，§14.8.4）；② 汇总页导航含 ⬅️ Prev 且点击回
  // 最后一题（§14.8.5）；③ 自定义输入后无 q_msg_id → 发新向导消息（多问题含
  // 键盘 + 新 id 回写 / 单问题 ✅ Submitted 无键盘，§14.8.6）。
  // 每个用例自包含 + 终态（resolved=true）。

  // API-207-1：payload 无 custom 字段 → 初始发送键盘也含 ✏️ Custom 行。
  await runCase(
    "API-207-1 any question keyboard always contains Custom even without custom flag",
    async () => {
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          questionWizardRecord("req-207a", [
            {
              question: "题一",
              options: [{ label: "A" }, { label: "B" }],
            },
            {
              question: "题二",
              options: [{ label: "C" }],
            },
          ]),
        ),
      );
      const monitor = new TelegramSessionMonitor(fakeClient, fakeConfig, root, registry);
      let sentKeyboard;
      monitor.sendMessage = async () => {};
      monitor.sendMessageWithKeyboard = async (text, keyboard) => {
        sentKeyboard = keyboard;
        return 42;
      };
      try {
        await monitor.scanSessionQueue();
        if (!sentKeyboard) {
          throw new Error("question must be sent via keyboard");
        }
        const rows = sentKeyboard.inline_keyboard;
        if (rows.length !== 3) {
          throw new Error(
            `expected 3 keyboard rows (options + custom + nav), got ${rows.length}`,
          );
        }
        const customRow = rows[1];
        if (
          customRow.length !== 1 ||
          customRow[0].text !== "✏️ Custom" ||
          customRow[0].callback_data !== "otg:q:req-207a:custom"
        ) {
          throw new Error(
            `custom row must always render without custom flag: ${JSON.stringify(customRow)}`,
          );
        }
      } finally {
        await registry.mutate((reg) => markSessionResolved(reg, "req-207a"));
        await monitor.dispose();
      }
    },
  );

  // API-207-2：多问题答完进总结 → 键盘含 ⬅️ Prev/✅ Submit/❌ Cancel；点击
  // prev 从总结回最后一题（q_stage=length → length-1 落盘，答案保留）。
  await runCase(
    "API-207-2 summary nav has Prev and prev click returns to last question",
    async () => {
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          questionWizardRecord("req-207b", [
            { question: "题一", options: [{ label: "A" }, { label: "B" }] },
            { question: "题二", options: [{ label: "C" }] },
          ]),
        ),
      );
      const monitor = new TelegramSessionMonitor(fakeClient, fakeConfig, root, registry);
      monitor.sendMessage = async () => {};
      try {
        // Q1 单选 → 自动跳 Q2。
        await runQCallback(monitor, "otg:q:req-207b:o0");
        // Q2 单选 → 自动进总结（stage=2）；编辑渲染总结键盘。
        const fetches = await runQCallback(monitor, "otg:q:req-207b:o0");
        const edit = lastEdit(fetches);
        const rows = edit?.body?.reply_markup?.inline_keyboard ?? [];
        const navRow = rows[rows.length - 1];
        const navTexts = (navRow ?? []).map((button) => button.text).join("|");
        if (navTexts !== "⬅️ Prev|✅ Submit|❌ Cancel") {
          throw new Error(
            `summary nav must be Prev/Submit/Cancel: ${navTexts} (${JSON.stringify(rows)})`,
          );
        }
        // 总结点 prev → 回最后一题（stage=1），答案保留。
        const prevFetches = await runQCallback(monitor, "otg:q:req-207b:prev");
        const ans = answersOf(prevFetches);
        if (ans.length !== 1 || ans[0].body.text !== "已跳转") {
          throw new Error(`prev answer expected: ${JSON.stringify(prevFetches)}`);
        }
        const persisted = await findRecord("req-207b");
        if (!persisted || persisted.q_stage !== 1) {
          throw new Error(
            `q_stage must return to 1 after summary prev: ${JSON.stringify(persisted)}`,
          );
        }
        if (
          !persisted ||
          JSON.stringify(persisted.q_draft) !== JSON.stringify([["A"], ["C"]])
        ) {
          throw new Error(
            `answers must be preserved: ${JSON.stringify(persisted)}`,
          );
        }
        const prevEdit = lastEdit(prevFetches);
        if (!prevEdit || !prevEdit.body.text.includes("Question 2/2")) {
          throw new Error(
            `prev must render last question: ${JSON.stringify(prevFetches)}`,
          );
        }
      } finally {
        await registry.mutate((reg) => markSessionResolved(reg, "req-207b"));
        await monitor.dispose();
      }
    },
  );

  // API-207-3：多问题自定义输入后 q_msg_id 缺失 → 发一条新的当前阶段向导消息
  // （含键盘）→ 新 message_id 回写；旧消息不动（无 editMessageText）。
  await runCase(
    "API-207-3 multi-question custom text without q_msg_id sends new wizard message with keyboard and writeback",
    async () => {
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          questionWizardRecord("req-207c", [
            { question: "题一", options: [{ label: "A" }, { label: "B" }] },
            { question: "题二", options: [{ label: "C" }] },
          ]),
        ),
      );
      const monitor = new TelegramSessionMonitor(fakeClient, fakeConfig, root, registry);
      const sent = [];
      let sentKeyboard;
      monitor.sendMessage = async (text) => {
        sent.push(text);
      };
      monitor.sendMessageWithKeyboard = async (text, keyboard) => {
        sentKeyboard = keyboard;
        sent.push(text);
        return 777;
      };
      try {
        // 进入输入模式（q_input=0）。
        await runQCallback(monitor, "otg:q:req-207c:custom");
        // 纯文本回复 → 推进到 Q2；无 q_msg_id → 兜底发新向导消息。
        const fetches = [];
        await stubFetch(fetches);
        try {
          await monitor.handleTelegramUpdate({
            update_id: 1,
            message: {
              message_id: 99,
              text: "自由回答",
              from: { id: 123 },
              chat: { id: 123, type: "private" },
            },
          });
        } finally {
          restoreFetch();
        }
        const persisted = await findRecord("req-207c");
        if (
          !persisted ||
          JSON.stringify(persisted.q_draft) !== JSON.stringify([["自由回答"], []])
        ) {
          throw new Error(
            `text answer not persisted: ${JSON.stringify(persisted)}`,
          );
        }
        if (persisted.q_stage !== 1) {
          throw new Error(`q_stage must advance to 1: ${JSON.stringify(persisted)}`);
        }
        // 旧消息不动：纯文本路径无 q_msg_id 无 callback 可兜底，不得编辑。
        if (editCount(fetches) !== 0) {
          throw new Error(`old message must not be edited: ${JSON.stringify(fetches)}`);
        }
        // 新向导消息：文本渲染 Q2 阶段 + 键盘（含 ✏️ Custom）。
        if (!sent.some((text) => text.includes("Question 2/2"))) {
          throw new Error(
            `new wizard message must render question 2: ${JSON.stringify(sent)}`,
          );
        }
        if (!sentKeyboard) {
          throw new Error("new wizard message must carry keyboard");
        }
        const rowLabels = sentKeyboard.inline_keyboard.flatMap((row) =>
          row.map((button) => button.text),
        );
        if (!rowLabels.includes("✏️ Custom")) {
          throw new Error(
            `new wizard keyboard must include Custom: ${JSON.stringify(sentKeyboard)}`,
          );
        }
        // 新 message_id 回写（后续编辑/回调指向新消息）。
        if (persisted.q_msg_id !== 777) {
          throw new Error(
            `q_msg_id must be written back: ${JSON.stringify(persisted)}`,
          );
        }
        await monitor.dispose();
        if (!sent.join(" ").includes("已记录第 1 题答案")) {
          throw new Error(`confirmation missing: ${JSON.stringify(sent)}`);
        }
      } finally {
        await registry.mutate((reg) => markSessionResolved(reg, "req-207c"));
        await monitor.dispose();
      }
    },
  );

  // API-207-4：单问题自定义输入直接提交，q_msg_id 缺失 → 新消息含
  // ✅ Submitted 终态文本、无键盘 + 回写新 message_id。
  await runCase(
    "API-207-4 single-question custom text without q_msg_id sends terminal message with Submitted and no keyboard",
    async () => {
      await registry.mutate((reg) =>
        appendSessionRecord(
          reg,
          root,
          questionWizardRecord("req-207d", [
            { question: "请补充", options: [] },
          ]),
        ),
      );
      const monitor = new TelegramSessionMonitor(fakeClient, fakeConfig, root, registry);
      const sent = [];
      let sentKeyboard = "unset";
      monitor.sendMessage = async (text) => {
        sent.push(text);
      };
      monitor.sendMessageWithKeyboard = async (text, keyboard) => {
        sent.push(text);
        sentKeyboard = keyboard === undefined ? "no-keyboard" : "keyboard";
        return 888;
      };
      try {
        await runQCallback(monitor, "otg:q:req-207d:custom");
        const fetches = [];
        await stubFetch(fetches);
        try {
          await monitor.handleTelegramUpdate({
            update_id: 1,
            message: {
              message_id: 100,
              text: "/home/hipc/project",
              from: { id: 123 },
              chat: { id: 123, type: "private" },
            },
          });
        } finally {
          restoreFetch();
        }
        const persisted = await findRecord("req-207d");
        if (
          !persisted ||
          JSON.stringify(persisted.q_answers) !==
            JSON.stringify([["/home/hipc/project"]])
        ) {
          throw new Error(
            `single-question text submit failed: ${JSON.stringify(persisted)}`,
          );
        }
        if (editCount(fetches) !== 0) {
          throw new Error(`old message must not be edited: ${JSON.stringify(fetches)}`);
        }
        if (!sent.some((text) => text.includes("✅ Submitted"))) {
          throw new Error(
            `new message must contain Submitted: ${JSON.stringify(sent)}`,
          );
        }
        if (sentKeyboard !== "no-keyboard") {
          throw new Error(`terminal message must have no keyboard: ${sentKeyboard}`);
        }
        if (persisted.q_msg_id !== 888) {
          throw new Error(
            `q_msg_id must be written back: ${JSON.stringify(persisted)}`,
          );
        }
        await monitor.dispose();
        if (!sent.join(" ").includes("已记录第 1 题答案")) {
          throw new Error(`confirmation missing: ${JSON.stringify(sent)}`);
        }
      } finally {
        await registry.mutate((reg) => markSessionResolved(reg, "req-207d"));
        await monitor.dispose();
      }
    },
  );

  await rm(baseDir, { recursive: true, force: true });
  const passed = total - failures;
  console.log(`\n${passed}/${total} cases passed`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();