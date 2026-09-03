// tests/registry-sessions.test.mjs
//
// 纯函数测试：SessionRecord 承载（sessions-relay.md §3/§4，REG-101；Round 2
// 扩展 §13.1/§13.2，REG-201；Round 6 扩展 §16，REG-401~403）。
// 覆盖：parse/serialize 白名单往返保留全字段、旧文件无 sessions 键、非数组丢弃、
// 损坏记录容错、append 追加不覆盖、mark* 按 request_id 精确匹配（无匹配
// undefined / 已置位幂等原引用 / 两字段互不联动）、既有 parse 语义保持、
// mutate 集成（写盘 + undefined 不写盘）、reply 字段四态往返与容错、
// setSessionReply 三态（写入/无匹配 undefined/幂等原引用/send、resolved 不受影响）、
// Round 6 删除三函数（removeSessionRecord / removeSessionRecordsForSession /
// removeExpiredSessionRecords 三态 + TTL 边界，supersede markSessionResolved）。
//
// 用例全部使用 mkdtemp 临时目录隔离，绝不触碰真实 ~/.otg。
// 运行：bun tests/registry-sessions.test.mjs

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const registryURL = new URL("../src/registry/index.ts", import.meta.url);
const {
  parseRegistry,
  serializeRegistry,
  appendSessionRecord,
  removeSessionRecord,
  removeSessionRecordsForSession,
  removeExpiredSessionRecords,
  markSessionSent,
  setSessionReply,
  setQuestionDraft,
  setQuestionInput,
  submitQuestionAnswers,
  rejectQuestion,
  setQuestionMessageID,
  clearQuestionInputs,
  ProjectRegistryStore,
  registerProject,
} = await import(registryURL.href);

let failures = 0;
let total = 0;

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function runCase(name, fn) {
  total += 1;
  const baseDir = await mkdtemp(join(tmpdir(), "otg-registry-sessions-"));
  try {
    await fn(baseDir);
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error.message}`);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
}

function makeRecord(overrides = {}) {
  return {
    session_id: "sess-1",
    session_name: "My Session",
    type: "permission",
    message: '{"tool":"bash","id":"req-1"}',
    send: false,
    resolved: false,
    request_id: "req-1",
    created_at: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function regWith(entries) {
  return { projects: entries };
}

// REG-101: sessions 往返 parse→serialize→parse，8 字段逐项一致（含 created_at/request_id），
// message 保持原 JSON 字符串可还原。
await runCase("REG-101 round-trip keeps all session fields", async (baseDir) => {
  const record = makeRecord({
    session_id: "sess-round",
    session_name: "Round Trip",
    type: "question",
    message: '{"tool":"read","id":"req-round","permission":"auto"}',
    send: true,
    resolved: false,
    request_id: "req-round",
    created_at: "2026-09-02T12:00:00.000Z",
  });
  const reg = regWith([
    {
      path: join(baseDir, "p"),
      enabled: true,
      addedAt: "2026-01-01T00:00:00.000Z",
      sessions: [record],
    },
  ]);
  const text = serializeRegistry(reg);
  const parsed = parseRegistry(text);
  assert(parsed !== undefined, "parseRegistry returned undefined");
  const entry = parsed.projects[0];
  assert(
    Array.isArray(entry.sessions) && entry.sessions.length === 1,
    "sessions lost in round-trip",
  );
  const got = entry.sessions[0];
  for (const key of Object.keys(record)) {
    assert(
      got[key] === record[key],
      `field ${key} changed in round-trip: ${JSON.stringify(got[key])} !== ${JSON.stringify(record[key])}`,
    );
  }
  assert(JSON.parse(got.message).tool === "read", "message JSON not preserved");
  // 二次往返（parse→serialize→parse）
  const reparsed = parseRegistry(serializeRegistry(parsed));
  const got2 = reparsed.projects[0].sessions[0];
  for (const key of Object.keys(record)) {
    assert(
      got2[key] === record[key],
      `field ${key} changed after 2nd round-trip`,
    );
  }
});

// REG-101: 旧文件无 sessions 键 → 字段 undefined；序列化不新增键；再解析仍无键。
await runCase("REG-101 old file without sessions parses without the key", async (baseDir) => {
  const text = JSON.stringify({
    projects: [
      {
        path: join(baseDir, "p"),
        enabled: true,
        addedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
  const parsed = parseRegistry(text);
  assert(parsed !== undefined, "parse failed");
  assert(parsed.projects[0].sessions === undefined, "sessions should be undefined");
  const out = serializeRegistry(parsed);
  assert(!out.includes('"sessions"'), "serialize must not add sessions key");
  const reparsed = parseRegistry(out);
  assert(
    reparsed.projects[0].sessions === undefined,
    "re-parse must not add sessions key",
  );
});

// REG-101: sessions 存在但非数组 → 丢弃该字段（整字段忽略），条目本身保留，不抛错。
await runCase("REG-101 non-array sessions dropped, entry kept", async (baseDir) => {
  for (const bad of ["oops", 42, null, true]) {
    const parsed = parseRegistry(
      JSON.stringify({
        projects: [
          {
            path: join(baseDir, "p"),
            enabled: true,
            addedAt: "2026-01-01T00:00:00.000Z",
            sessions: bad,
          },
        ],
      }),
    );
    assert(parsed !== undefined, "parse failed for non-array sessions");
    assert(parsed.projects.length === 1, "entry should be kept");
    assert(
      parsed.projects[0].sessions === undefined,
      `sessions (${JSON.stringify(bad)}) should be dropped`,
    );
  }
  const parsed = parseRegistry(
    JSON.stringify({
      projects: [
        {
          path: join(baseDir, "p"),
          enabled: true,
          addedAt: "2026-01-01T00:00:00.000Z",
          sessions: "oops",
        },
      ],
    }),
  );
  const out = serializeRegistry(parsed);
  assert(!out.includes('"sessions"'), "dropped sessions must not serialize");
});

// REG-101: sessions 数组中字段类型不符的记录被丢弃（严格校验，不推断默认值），
// 合法记录保留；全部非法 → 保留空数组。任何情况不抛错。
await runCase("REG-101 invalid records dropped without throwing", async (baseDir) => {
  const good = makeRecord({ request_id: "req-good", session_id: "sess-good" });
  const bad = [
    { ...makeRecord({ request_id: "req-bad-1" }), send: "yes" }, // send 非 boolean
    { ...makeRecord({ request_id: "req-bad-2" }), resolved: 1 }, // resolved 非 boolean
    { ...makeRecord({ request_id: "req-bad-3" }), type: "chat" }, // type 非法
    { ...makeRecord({ request_id: "req-bad-4" }), request_id: 42 }, // request_id 非 string
    { ...makeRecord({ request_id: "req-bad-5" }), session_id: undefined }, // 缺 session_id
    { ...makeRecord({ request_id: "req-bad-6" }), created_at: null }, // created_at 非 string
    { ...makeRecord({ request_id: "req-bad-7" }), message: 7 }, // message 非 string
    { ...makeRecord({ request_id: "req-bad-8" }), session_name: {} }, // session_name 非 string
    "not-an-object",
    null,
    42,
  ];
  const parsed = parseRegistry(
    JSON.stringify({
      projects: [
        {
          path: join(baseDir, "p"),
          enabled: true,
          addedAt: "2026-01-01T00:00:00.000Z",
          sessions: [good, ...bad],
        },
      ],
    }),
  );
  assert(parsed !== undefined, "parse threw/failed");
  const sessions = parsed.projects[0].sessions;
  assert(Array.isArray(sessions), "sessions should remain an array");
  assert(
    sessions.length === 1,
    `expected 1 valid record, got ${sessions.length}`,
  );
  assert(sessions[0].request_id === "req-good", "wrong record survived");

  const allBad = parseRegistry(
    JSON.stringify({
      projects: [
        {
          path: join(baseDir, "q"),
          enabled: true,
          addedAt: "2026-01-01T00:00:00.000Z",
          sessions: [{ ...makeRecord(), type: "nope" }],
        },
      ],
    }),
  );
  assert(
    Array.isArray(allBad.projects[0].sessions) &&
      allBad.projects[0].sessions.length === 0,
    "all-invalid sessions should leave an empty array",
  );
});

// REG-101: appendSessionRecord 按 path 定位条目追加，追加不覆盖、不去重；
// 无 sessions 键的条目从空数组起步。
await runCase("REG-101 appendSessionRecord appends without overwrite", async (baseDir) => {
  const p = join(baseDir, "p");
  const reg = regWith([
    {
      path: p,
      enabled: true,
      addedAt: "2026-01-01T00:00:00.000Z",
      sessions: [makeRecord({ request_id: "req-1" })],
    },
  ]);
  const next = appendSessionRecord(reg, p, makeRecord({ request_id: "req-2" }));
  assert(next !== reg, "append must return a new registry object");
  assert(next.projects !== reg.projects, "projects array must be new");
  const next2 = appendSessionRecord(
    next,
    p,
    makeRecord({ request_id: "req-3" }),
  );
  const sessions = next2.projects[0].sessions;
  assert(sessions.length === 3, `expected 3 sessions, got ${sessions.length}`);
  assert(
    sessions[0].request_id === "req-1" &&
      sessions[1].request_id === "req-2" &&
      sessions[2].request_id === "req-3",
    "append must not overwrite or reorder",
  );
  // 同一 request_id 重复 append 不去重（去重是写入端 seenWaitingRequestIDs 的职责）
  const dup = appendSessionRecord(
    next2,
    p,
    makeRecord({ request_id: "req-3" }),
  );
  assert(
    dup.projects[0].sessions.length === 4,
    "append must not deduplicate",
  );
  // 无 sessions 键的条目追加
  const regNoSessions = regWith([
    { path: join(baseDir, "q"), enabled: true, addedAt: "2026-01-01T00:00:00.000Z" },
  ]);
  const appended = appendSessionRecord(
    regNoSessions,
    join(baseDir, "q"),
    makeRecord({ request_id: "req-q" }),
  );
  assert(
    appended.projects[0].sessions.length === 1 &&
      appended.projects[0].sessions[0].request_id === "req-q",
    "append to entry without sessions failed",
  );
});

// REG-101: append 条目不存在 → 返回原 registry 引用（mutate 短路不写盘）。
await runCase("REG-101 append with missing path returns original registry", async (baseDir) => {
  const reg = regWith([
    { path: join(baseDir, "p"), enabled: true, addedAt: "2026-01-01T00:00:00.000Z" },
  ]);
  const next = appendSessionRecord(reg, join(baseDir, "nope"), makeRecord());
  assert(next === reg, "must return original reference for missing path");
});

// REG-401: removeSessionRecord 按 request_id 全局删除（supersede
// markSessionResolved，契约 §16）：无匹配 undefined；单条删除；
// 同 request_id 多副本（跨条目/同条目）全删；空 sessions 数组保留键；
// 前缀不匹配；其它记录与条目不动。
await runCase("REG-401 removeSessionRecord deletes by request_id (all copies, keeps empty key)", async (baseDir) => {
  const reg = regWith([
    {
      path: join(baseDir, "p"),
      enabled: true,
      addedAt: "2026-01-01T00:00:00.000Z",
      sessions: [
        makeRecord({ request_id: "req-1", send: false }),
        makeRecord({ request_id: "req-2", resolved: true }), // 终态记录同样可删
      ],
    },
    {
      path: join(baseDir, "q"),
      enabled: true,
      addedAt: "2026-01-01T00:00:00.000Z",
      sessions: [makeRecord({ request_id: "req-2" })], // 跨条目副本
    },
  ]);
  assert(
    removeSessionRecord(reg, "req-missing") === undefined,
    "no match must return undefined",
  );
  assert(
    removeSessionRecord(reg, "req-") === undefined,
    "prefix must not match (exact match only)",
  );
  // 单条删除：跨条目匹配 req-2 → 两条副本全删，其它记录不动。
  const next = removeSessionRecord(reg, "req-2");
  assert(next !== reg, "must return a new registry object");
  assert(
    next.projects[0].sessions.length === 1 &&
      next.projects[0].sessions[0].request_id === "req-1",
    "req-1 must stay, req-2 must be removed from first entry",
  );
  assert(
    next.projects[1].sessions.length === 0,
    "second entry must end with empty sessions array (key retained)",
  );
  assert(
    Array.isArray(next.projects[1].sessions),
    "empty sessions must keep the sessions: [] key",
  );
  // 同条目内多副本（跨进程竞态）全删
  const dup = regWith([
    {
      path: join(baseDir, "p"),
      enabled: true,
      addedAt: "2026-01-01T00:00:00.000Z",
      sessions: [
        makeRecord({ request_id: "req-dup", send: true }),
        makeRecord({ request_id: "req-dup" }),
      ],
    },
  ]);
  const dedup = removeSessionRecord(dup, "req-dup");
  assert(
    dedup !== undefined && dedup.projects[0].sessions.length === 0,
    "all duplicate copies must be removed",
  );
  assert(
    dedup.projects[0].path === join(baseDir, "p"),
    "entry itself must be kept",
  );
  // 无 sessions 的条目不参与匹配，也不被触碰
  const regMixed = regWith([
    { path: join(baseDir, "z"), enabled: true, addedAt: "2026-01-01T00:00:00.000Z" },
    { path: join(baseDir, "p"), enabled: true, addedAt: "2026-01-01T00:00:00.000Z" },
  ]);
  assert(
    removeSessionRecord(regMixed, "req-z") === undefined,
    "entries without sessions key are skipped, not broken",
  );
  assert(
    regMixed.projects[0].sessions === undefined,
    "entries without sessions key must keep reference untouched",
  );
});

// REG-101: markSessionSent 同样语义；resolved 保持不动；互不联动。
await runCase("REG-101 markSessionSent matches by request_id", async (baseDir) => {
  const p = join(baseDir, "p");
  const reg = regWith([
    {
      path: p,
      enabled: true,
      addedAt: "2026-01-01T00:00:00.000Z",
      sessions: [makeRecord({ request_id: "req-1", resolved: false })],
    },
  ]);
  assert(
    markSessionSent(reg, "req-missing") === undefined,
    "no match must return undefined",
  );
  const next = markSessionSent(reg, "req-1");
  assert(next !== reg, "must return a new registry object");
  assert(next.projects[0].sessions[0].send === true, "send not set");
  assert(
    next.projects[0].sessions[0].resolved === false,
    "resolved must stay untouched by markSessionSent",
  );
  assert(markSessionSent(next, "req-1") === next, "idempotent must return same reference");
  // resolved 的记录仍可置 send（标记函数本身互不联动；跳过逻辑在 poller 筛选侧）
  const resolvedRec = regWith([
    {
      path: p,
      enabled: true,
      addedAt: "2026-01-01T00:00:00.000Z",
      sessions: [makeRecord({ request_id: "req-r", resolved: true })],
    },
  ]);
  const sentAfterResolved = markSessionSent(resolvedRec, "req-r");
  assert(
    sentAfterResolved.projects[0].sessions[0].send === true &&
      sentAfterResolved.projects[0].sessions[0].resolved === true,
    "markSessionSent must not clear resolved",
  );
});

// REG-101: 既有 parse 语义保持（sessions 校验不得放宽/收紧总入口行为）。
await runCase("REG-101 existing parse semantics preserved", async (baseDir) => {
  assert(
    parseRegistry(
      JSON.stringify({
        projects: [
          { enabled: true, addedAt: "2026-01-01T00:00:00.000Z", sessions: [] },
        ],
      }),
    ) === undefined,
    "entry missing path must yield undefined",
  );
  assert(parseRegistry("{not json") === undefined, "invalid json must yield undefined");
  const empty = parseRegistry("   ");
  assert(empty !== undefined && empty.projects.length === 0, "blank text must yield empty registry");
  assert(parseRegistry("[]") === undefined, "top-level array must yield undefined");
  assert(
    parseRegistry(JSON.stringify({ projects: "nope" })) === undefined,
    "non-array projects must yield undefined",
  );
});

// REG-401 (集成): mutate(appendSessionRecord/removeSessionRecord) 写盘持久化、
// 无匹配 remove 经 mutate 返回 undefined 且文件内容不变、删除后再删返回
// undefined（原「幂等 mark 原引用」语义在删除下不存在——删除后无匹配）。
await runCase("REG-401 mutate integration: append/remove persist, no-match no-op", async (baseDir) => {
  const filePath = join(baseDir, "projects.json");
  const store = new ProjectRegistryStore(filePath);
  await store.ensureDir();
  const p = join(baseDir, "project", "demo");
  const seeded = await store.mutate((reg) => registerProject(reg, p));
  assert(seeded !== undefined, "seed mutate failed");

  const record = makeRecord({ request_id: "req-int", session_id: "sess-int" });
  const appended = await store.mutate((reg) =>
    appendSessionRecord(reg, p, record),
  );
  assert(
    appended !== undefined && appended.projects[0].sessions.length === 1,
    "append mutate failed",
  );
  const reader = new ProjectRegistryStore(filePath);
  const reread = await reader.read();
  const got = reread.projects[0].sessions[0];
  for (const key of Object.keys(record)) {
    assert(got[key] === record[key], `persisted field ${key} mismatch`);
  }

  const removed = await store.mutate((reg) =>
    removeSessionRecord(reg, "req-int"),
  );
  assert(
    removed !== undefined && removed.projects[0].sessions.length === 0,
    "remove not persisted",
  );
  const afterRemoved = await reader.read();
  assert(
    Array.isArray(afterRemoved.projects[0].sessions) &&
      afterRemoved.projects[0].sessions.length === 0,
    "sessions must be empty array (key retained) after remove persist",
  );

  // 无匹配 → mutate 返回 undefined 且文件内容不变
  const before = JSON.stringify(await reader.read());
  const none = await store.mutate((reg) => markSessionSent(reg, "req-nope"));
  assert(none === undefined, "no-match mark must yield undefined from mutate");
  const afterNoop = JSON.stringify(await reader.read());
  assert(afterNoop === before, "file must not change for no-match mark");

  // 删除后再删除（原「幂等已置位」语义已不存在）→ mutate 返回 undefined 且内容不变
  const again = await store.mutate((reg) =>
    removeSessionRecord(reg, "req-int"),
  );
  assert(again === undefined, "re-remove after deletion must yield undefined");
  assert(
    JSON.stringify(await reader.read()) === before,
    "file must not change for re-remove",
  );
});

// REG-201: reply 字段往返——显式 null 与三合法值逐字段一致（parse→serialize→parse）。
// 来源：决策 #8 / 契约 sessions-relay.md §13.1（Round 2）。
await runCase("REG-201 reply round-trip preserves null and valid values", async (baseDir) => {
  const records = [
    makeRecord({ request_id: "req-null", reply: null }),
    makeRecord({ request_id: "req-once", reply: "once" }),
    makeRecord({ request_id: "req-always", reply: "always" }),
    makeRecord({ request_id: "req-reject", reply: "reject" }),
  ];
  const reg = regWith([
    {
      path: join(baseDir, "p"),
      enabled: true,
      addedAt: "2026-01-01T00:00:00.000Z",
      sessions: records,
    },
  ]);
  const parsed = parseRegistry(serializeRegistry(reg));
  assert(parsed !== undefined, "parse failed");
  const sessions = parsed.projects[0].sessions;
  assert(sessions.length === 4, `expected 4 records, got ${sessions.length}`);
  for (let i = 0; i < records.length; i++) {
    assert(
      Object.prototype.hasOwnProperty.call(sessions[i], "reply"),
      `record ${i} must keep the reply key`,
    );
    assert(
      sessions[i].reply === records[i].reply,
      `reply mismatch for ${records[i].request_id}: ${JSON.stringify(sessions[i].reply)}`,
    );
  }
  // 二次往返（parse→serialize→parse）
  const reparsed = parseRegistry(serializeRegistry(parsed));
  for (let i = 0; i < records.length; i++) {
    assert(
      reparsed.projects[0].sessions[i].reply === records[i].reply,
      `reply mismatch after 2nd round-trip`,
    );
  }
});

// REG-201: 无 reply 键的旧记录往返不新增键（serialize 自动省略，键缺失态保持）。
await runCase("REG-201 old record without reply key round-trips without adding key", async (baseDir) => {
  const record = makeRecord({ request_id: "req-old" });
  assert(!("reply" in record), "fixture must not carry reply key");
  const text = serializeRegistry(
    regWith([
      {
        path: join(baseDir, "p"),
        enabled: true,
        addedAt: "2026-01-01T00:00:00.000Z",
        sessions: [record],
      },
    ]),
  );
  assert(!text.includes('"reply"'), "serialize must not add reply key");
  const parsed = parseRegistry(text);
  const got = parsed.projects[0].sessions[0];
  assert(got.request_id === "req-old", "record lost in round-trip");
  assert(!("reply" in got), "parse must not add reply key to old record");
  const out2 = serializeRegistry(parsed);
  assert(!out2.includes('"reply"'), "2nd serialize must not add reply key");
});

// REG-201: 非法 reply 值（非三合法值/非 null）→ 丢弃整条记录，不抛错、合法记录保留。
await runCase("REG-201 invalid reply value drops the record without throwing", async (baseDir) => {
  const good = makeRecord({ request_id: "req-good", reply: "once" });
  const bad = ["maybe", "", "ONCE", 42, true, false, {}, [], { once: true }];
  const parsed = parseRegistry(
    JSON.stringify({
      projects: [
        {
          path: join(baseDir, "p"),
          enabled: true,
          addedAt: "2026-01-01T00:00:00.000Z",
          sessions: [
            good,
            ...bad.map((reply, i) =>
              makeRecord({ request_id: `req-bad-${i}`, reply }),
            ),
          ],
        },
      ],
    }),
  );
  assert(parsed !== undefined, "parse threw/failed");
  const sessions = parsed.projects[0].sessions;
  assert(
    sessions.length === 1,
    `expected 1 valid record, got ${sessions.length}`,
  );
  assert(sessions[0].request_id === "req-good", "wrong record survived");
  assert(sessions[0].reply === "once", "valid reply not preserved");
});

// REG-201: setSessionReply 三态——全局 request_id 精确匹配写入；无匹配 undefined；
// 幂等同值返回原引用；只改 reply、send/resolved 不动（跨条目、已 resolved 也允许写）。
// 来源：决策 #8 / 契约 sessions-relay.md §13.2。
await runCase("REG-201 setSessionReply writes, no-match undefined, idempotent", async (baseDir) => {
  const reg = regWith([
    {
      path: join(baseDir, "p"),
      enabled: true,
      addedAt: "2026-01-01T00:00:00.000Z",
      sessions: [
        makeRecord({ request_id: "req-1", send: false, resolved: false }),
        makeRecord({ request_id: "req-2", send: true, resolved: false }),
      ],
    },
    {
      path: join(baseDir, "q"),
      enabled: true,
      addedAt: "2026-01-01T00:00:00.000Z",
      sessions: [makeRecord({ request_id: "req-3", send: false, resolved: true })],
    },
  ]);
  assert(
    setSessionReply(reg, "req-missing", "once") === undefined,
    "no match must return undefined",
  );
  assert(
    setSessionReply(reg, "req-", "once") === undefined,
    "prefix must not match (exact match only)",
  );

  // 写入 once：新 registry，仅该记录 reply 变化
  const next = setSessionReply(reg, "req-2", "once");
  assert(next !== reg, "must return a new registry object");
  assert(next.projects[0].sessions[1].reply === "once", "reply not written");
  assert(
    next.projects[0].sessions[1].send === true &&
      next.projects[0].sessions[1].resolved === false,
    "setSessionReply must not touch send/resolved",
  );
  assert(
    next.projects[0].sessions[0].reply === undefined,
    "other record must not be touched",
  );

  // 幂等：同值返回原引用
  const idem = setSessionReply(next, "req-2", "once");
  assert(idem === next, "idempotent same-value must return same reference");

  // 跨条目匹配 + 已 resolved 记录仍允许写 reply（纯字段写、无状态检查）
  const cross = setSessionReply(reg, "req-3", "reject");
  assert(cross !== reg, "cross-entry must return a new registry object");
  assert(
    cross.projects[1].sessions[0].reply === "reject",
    "cross-entry reply not written",
  );
  assert(
    cross.projects[1].sessions[0].resolved === true,
    "resolved must stay untouched even when writing reply",
  );

  // 从无 reply 键的记录写入：新增键
  const add = setSessionReply(reg, "req-1", "always");
  assert(add.projects[0].sessions[0].reply === "always", "reply key not added");
  assert(
    setSessionReply(add, "req-1", "always") === add,
    "idempotent after adding key must return same reference",
  );
});

// REG-201 (集成): mutate(setSessionReply) 写盘持久化、无匹配 undefined 且文件
// 内容不变、幂等同值不写盘（与 REG-101 mutate 集成同款语义）。
await runCase("REG-201 mutate integration: setSessionReply persist, no-match no-op", async (baseDir) => {
  const filePath = join(baseDir, "projects.json");
  const store = new ProjectRegistryStore(filePath);
  await store.ensureDir();
  const p = join(baseDir, "project", "demo");
  await store.mutate((reg) => registerProject(reg, p));
  await store.mutate((reg) =>
    appendSessionRecord(
      reg,
      p,
      makeRecord({ request_id: "req-int", session_id: "sess-int" }),
    ),
  );

  const written = await store.mutate((reg) =>
    setSessionReply(reg, "req-int", "always"),
  );
  assert(written !== undefined, "setSessionReply mutate failed");
  const got = (await store.read()).projects[0].sessions[0];
  assert(got.reply === "always", "reply not persisted");
  assert(
    got.send === false && got.resolved === false,
    "send/resolved must stay false after persist",
  );

  const before = JSON.stringify(await store.read());
  const none = await store.mutate((reg) =>
    setSessionReply(reg, "req-nope", "once"),
  );
  assert(
    none === undefined,
    "no-match setSessionReply must yield undefined from mutate",
  );
  assert(
    JSON.stringify(await store.read()) === before,
    "file must not change for no-match setSessionReply",
  );

  const idem = await store.mutate((reg) =>
    setSessionReply(reg, "req-int", "always"),
  );
  assert(idem !== undefined, "idempotent setSessionReply must succeed");
  assert(
    JSON.stringify(await store.read()) === before,
    "file must not change for idempotent setSessionReply",
  );
});

// ---- Phase 1.1 (REG-301, question-tg-wizard round 4, §14.1) ----

// REG-301: q_* 6 字段往返——合法值逐字段一致（含 q_input 显式 null 保留）；
// 无 q_* 键的旧记录往返不新增键；二次往返一致。
await runCase("REG-301 q_* round-trip preserves valid and missing fields", async (baseDir) => {
  const full = makeRecord({
    request_id: "req-full",
    type: "question",
    q_draft: [["yes"], []],
    q_stage: 2,
    q_input: 1,
    q_answers: [["yes"], ["no"]],
    q_reject: false,
    q_msg_id: 1234,
  });
  const inputNull = makeRecord({ request_id: "req-null", q_input: null });
  const old = makeRecord({ request_id: "req-old" });
  const reg = regWith([
    {
      path: join(baseDir, "p"),
      enabled: true,
      addedAt: "2026-01-01T00:00:00.000Z",
      sessions: [full, inputNull, old],
    },
  ]);
  const parsed = parseRegistry(serializeRegistry(reg));
  assert(parsed !== undefined, "parse failed");
  const sessions = parsed.projects[0].sessions;
  assert(sessions.length === 3, `expected 3 records, got ${sessions.length}`);

  const gotFull = sessions[0];
  for (const key of ["q_draft", "q_stage", "q_input", "q_answers", "q_reject", "q_msg_id"]) {
    assert(
      Object.prototype.hasOwnProperty.call(gotFull, key),
      `record must keep key ${key}`,
    );
    assert(
      JSON.stringify(gotFull[key]) === JSON.stringify(full[key]),
      `field ${key} changed in round-trip`,
    );
  }
  assert(
    Object.prototype.hasOwnProperty.call(sessions[1], "q_input") &&
      sessions[1].q_input === null,
    "explicit null q_input must keep the key and stay null",
  );
  for (const key of ["q_draft", "q_stage", "q_input", "q_answers", "q_reject", "q_msg_id"]) {
    assert(
      !Object.prototype.hasOwnProperty.call(sessions[2], key),
      `old record must not gain key ${key}`,
    );
  }
  // 二次往返（parse→serialize→parse）
  const reparsed = parseRegistry(serializeRegistry(parsed));
  assert(
    JSON.stringify(reparsed.projects[0].sessions[0].q_draft) ===
      JSON.stringify(full.q_draft),
    "q_draft lost after 2nd round-trip",
  );
  assert(
    reparsed.projects[0].sessions[1].q_input === null,
    "q_input null lost after 2nd round-trip",
  );
  assert(
    !("q_answers" in reparsed.projects[0].sessions[2]),
    "old record gained key after 2nd round-trip",
  );
});

// REG-301: 非法 q_* 值（类型/结构不符，含各字段 null）→ 丢弃整条记录，
// 不抛错、合法记录保留。
await runCase("REG-301 invalid q_* values drop the record without throwing", async (baseDir) => {
  const good = makeRecord({
    request_id: "req-good",
    type: "question",
    q_msg_id: 7,
  });
  const bad = [
    { request_id: "req-bad-draft-1", q_draft: "yes" },
    { request_id: "req-bad-draft-2", q_draft: [["ok"], "nope"] },
    { request_id: "req-bad-draft-3", q_draft: [[1]] },
    { request_id: "req-bad-draft-4", q_draft: null },
    { request_id: "req-bad-stage-1", q_stage: "2" },
    { request_id: "req-bad-stage-2", q_stage: null },
    { request_id: "req-bad-stage-3", q_stage: true },
    { request_id: "req-bad-input-1", q_input: "1" },
    { request_id: "req-bad-input-2", q_input: true },
    { request_id: "req-bad-input-3", q_input: {} },
    { request_id: "req-bad-answers-1", q_answers: ["flat"] },
    { request_id: "req-bad-answers-2", q_answers: [["a"], 42] },
    { request_id: "req-bad-answers-3", q_answers: null },
    { request_id: "req-bad-reject-1", q_reject: "true" },
    { request_id: "req-bad-reject-2", q_reject: 1 },
    { request_id: "req-bad-reject-3", q_reject: null },
    { request_id: "req-bad-msgid-1", q_msg_id: "42" },
    { request_id: "req-bad-msgid-2", q_msg_id: null },
    { request_id: "req-bad-msgid-3", q_msg_id: true },
  ];
  const parsed = parseRegistry(
    JSON.stringify({
      projects: [
        {
          path: join(baseDir, "p"),
          enabled: true,
          addedAt: "2026-01-01T00:00:00.000Z",
          sessions: [good, ...bad.map((o) => makeRecord(o))],
        },
      ],
    }),
  );
  assert(parsed !== undefined, "parse threw/failed");
  const sessions = parsed.projects[0].sessions;
  assert(
    sessions.length === 1,
    `expected 1 valid record, got ${sessions.length}`,
  );
  assert(sessions[0].request_id === "req-good", "wrong record survived");
  assert(sessions[0].q_msg_id === 7, "valid q_msg_id not preserved");
});

// REG-301: 5 个 q_* 纯函数三态——全局 request_id 精确匹配（跨条目第二条目）；
// 无匹配（含前缀不匹配）undefined；写入只改目标字段（send/resolved/reply
// 及其它 q_* 不动）；幂等（同值/同引用）返回原引用。
await runCase("REG-301 q_* pure functions: write, no-match undefined, idempotent", async (baseDir) => {
  const base = makeRecord({
    request_id: "req-q",
    type: "question",
    send: true,
    resolved: false,
    reply: null,
    q_draft: [["a"]],
    q_stage: 0,
    q_input: 1,
  });
  const reg = regWith([
    {
      path: join(baseDir, "p"),
      enabled: true,
      addedAt: "2026-01-01T00:00:00.000Z",
      sessions: [makeRecord({ request_id: "req-other" }), base],
    },
    {
      path: join(baseDir, "q"),
      enabled: true,
      addedAt: "2026-01-01T00:00:00.000Z",
      sessions: [makeRecord({ request_id: "req-cross", type: "question" })],
    },
  ]);
  assert(
    setQuestionDraft(reg, "req-missing", [["x"]], 0) === undefined,
    "setQuestionDraft no-match must be undefined",
  );
  assert(
    setQuestionInput(reg, "req-", 0) === undefined,
    "setQuestionInput prefix must not match",
  );
  assert(
    submitQuestionAnswers(reg, "req-nope", [["x"]]) === undefined,
    "submitQuestionAnswers no-match must be undefined",
  );
  assert(
    rejectQuestion(reg, "req-nope") === undefined,
    "rejectQuestion no-match must be undefined",
  );
  assert(
    setQuestionMessageID(reg, "req-nope", 5) === undefined,
    "setQuestionMessageID no-match must be undefined",
  );

  // setQuestionDraft：写 q_draft+q_stage，只改目标字段
  const draft = [["a"], ["b"]];
  const d = setQuestionDraft(reg, "req-q", draft, 1);
  assert(d !== reg, "setQuestionDraft must return a new registry object");
  const dRec = d.projects[0].sessions[1];
  assert(
    dRec.q_draft === draft && dRec.q_stage === 1,
    "draft/stage not written",
  );
  assert(
    dRec.q_input === 1 &&
      dRec.reply === null &&
      dRec.send === true &&
      dRec.resolved === false &&
      !("q_answers" in dRec) &&
      !("q_reject" in dRec) &&
      !("q_msg_id" in dRec),
    "setQuestionDraft must only change q_draft/q_stage",
  );
  assert(
    d.projects[0].sessions[0].request_id === "req-other" &&
      d.projects[1].sessions[0].request_id === "req-cross",
    "other records must not be touched",
  );
  assert(
    setQuestionDraft(d, "req-q", draft, 1) === d,
    "setQuestionDraft idempotent must return same reference",
  );

  // setQuestionInput：写 q_input（数字），只改该字段
  const i = setQuestionInput(reg, "req-q", 0);
  assert(i !== reg && i.projects[0].sessions[1].q_input === 0, "q_input not written");
  assert(
    i.projects[0].sessions[1].q_draft === base.q_draft &&
      i.projects[0].sessions[1].q_stage === 0,
    "setQuestionInput must only change q_input",
  );
  assert(
    setQuestionInput(i, "req-q", 0) === i,
    "setQuestionInput idempotent must return same reference",
  );
  // setQuestionInput(null)：显式清除 → 写入 null（显式无输入态）
  const clear = setQuestionInput(reg, "req-q", null);
  assert(
    clear.projects[0].sessions[1].q_input === null,
    "setQuestionInput(null) must write explicit null",
  );
  assert(
    clear.projects[0].sessions[1].q_draft === base.q_draft,
    "setQuestionInput(null) must not touch other fields",
  );

  // submitQuestionAnswers：写 q_answers，只改该字段
  const answers = [["a"], ["b"]];
  const s = submitQuestionAnswers(reg, "req-q", answers);
  assert(s !== reg && s.projects[0].sessions[1].q_answers === answers, "answers not written");
  assert(
    s.projects[0].sessions[1].q_draft === base.q_draft &&
      s.projects[0].sessions[1].q_input === 1,
    "submitQuestionAnswers must only change q_answers",
  );
  assert(
    submitQuestionAnswers(s, "req-q", answers) === s,
    "submitQuestionAnswers idempotent must return same reference",
  );

  // rejectQuestion：置 q_reject=true，只改该字段，幂等
  const r = rejectQuestion(reg, "req-q");
  assert(r !== reg && r.projects[0].sessions[1].q_reject === true, "q_reject not written");
  assert(
    r.projects[0].sessions[1].resolved === false &&
      r.projects[0].sessions[1].q_draft === base.q_draft &&
      r.projects[0].sessions[1].q_input === 1,
    "rejectQuestion must only change q_reject",
  );
  assert(
    rejectQuestion(r, "req-q") === r,
    "rejectQuestion idempotent must return same reference",
  );

  // setQuestionMessageID：写 q_msg_id，只改该字段，幂等
  const m = setQuestionMessageID(reg, "req-q", 42);
  assert(m !== reg && m.projects[0].sessions[1].q_msg_id === 42, "q_msg_id not written");
  assert(
    m.projects[0].sessions[1].q_draft === base.q_draft,
    "setQuestionMessageID must only change q_msg_id",
  );
  assert(
    setQuestionMessageID(m, "req-q", 42) === m,
    "setQuestionMessageID idempotent must return same reference",
  );

  // 跨条目全局匹配（第二条目）
  const cross = setQuestionDraft(reg, "req-cross", [["x"]], 0);
  assert(
    cross !== reg && cross.projects[1].sessions[0].q_stage === 0,
    "cross-entry match must write",
  );
  assert(
    cross.projects[0].sessions[1] === reg.projects[0].sessions[1],
    "untouched entry records must keep reference",
  );
});

// REG-301: clearQuestionInputs 批量清除——无任何 q_input → 原引用；
// 有 q_input（数字与 null 混合）→ 新 registry 且全部 q_input 键删除；
// 其它字段（含其它 q_*）不动；无 sessions 条目不参与。
await runCase("REG-301 clearQuestionInputs clears q_input keys in batch", async (baseDir) => {
  const reg = regWith([
    {
      path: join(baseDir, "p"),
      enabled: true,
      addedAt: "2026-01-01T00:00:00.000Z",
      sessions: [
        makeRecord({ request_id: "req-1", q_input: 2, q_draft: [["a"]], q_stage: 2 }),
        makeRecord({ request_id: "req-2", q_input: null }),
        makeRecord({ request_id: "req-3" }),
      ],
    },
    {
      path: join(baseDir, "q"),
      enabled: true,
      addedAt: "2026-01-01T00:00:00.000Z",
      sessions: [makeRecord({ request_id: "req-4", q_input: 0 })],
    },
    {
      path: join(baseDir, "z"),
      enabled: true,
      addedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  const next = clearQuestionInputs(reg);
  assert(next !== reg, "must return a new registry when cleared");
  for (const entryIdx of [0, 1]) {
    for (const req of entryIdx === 0 ? ["req-1", "req-2", "req-3"] : ["req-4"]) {
      const rec = next.projects[entryIdx].sessions.find((s) => s.request_id === req);
      assert(rec !== undefined, `record ${req} lost`);
      assert(!("q_input" in rec), `q_input key must be removed for ${req}`);
    }
  }
  assert(
    next.projects[0].sessions[0].q_draft[0][0] === "a" &&
      next.projects[0].sessions[0].q_stage === 2,
    "other q_* fields must stay untouched",
  );
  assert(
    next.projects[0].sessions[0].send === false &&
      next.projects[0].sessions[0].resolved === false,
    "send/resolved must stay untouched",
  );
  assert(
    next.projects[2] === reg.projects[2],
    "entry without sessions must keep reference",
  );
  // 二次清除无变更 → 原引用
  const clean = clearQuestionInputs(next);
  assert(clean === next, "no pending input must return same reference");
});

// REG-301 (集成): mutate(q_* 纯函数) 写盘持久化、无匹配 undefined 且文件内容
// 不变、幂等同值不写盘（与 REG-101/201 mutate 集成同款语义）。
await runCase("REG-301 mutate integration: q_* writes persist, no-match no-op", async (baseDir) => {
  const filePath = join(baseDir, "projects.json");
  const store = new ProjectRegistryStore(filePath);
  await store.ensureDir();
  const p = join(baseDir, "project", "demo");
  await store.mutate((reg) => registerProject(reg, p));
  await store.mutate((reg) =>
    appendSessionRecord(
      reg,
      p,
      makeRecord({
        request_id: "req-int",
        session_id: "sess-int",
        type: "question",
      }),
    ),
  );

  const draft = [["yes"]];
  const written = await store.mutate((reg) =>
    setQuestionDraft(reg, "req-int", draft, 1),
  );
  assert(written !== undefined, "setQuestionDraft mutate failed");
  const got = (await store.read()).projects[0].sessions[0];
  assert(
    JSON.stringify(got.q_draft) === JSON.stringify(draft) && got.q_stage === 1,
    "draft/stage not persisted",
  );
  assert(
    got.send === false && got.resolved === false,
    "send/resolved must stay false after persist",
  );

  const rejected = await store.mutate((reg) => rejectQuestion(reg, "req-int"));
  assert(
    rejected !== undefined &&
      (await store.read()).projects[0].sessions[0].q_reject === true,
    "q_reject not persisted",
  );
  assert(
    (await store.read()).projects[0].sessions[0].q_draft !== undefined,
    "rejectQuestion must not clear q_draft",
  );

  const before = JSON.stringify(await store.read());
  const none = await store.mutate((reg) =>
    setQuestionMessageID(reg, "req-nope", 9),
  );
  assert(
    none === undefined,
    "no-match setQuestionMessageID must yield undefined from mutate",
  );
  assert(
    JSON.stringify(await store.read()) === before,
    "file must not change for no-match",
  );

  const idem = await store.mutate((reg) => rejectQuestion(reg, "req-int"));
  assert(idem !== undefined, "idempotent rejectQuestion must succeed");
  assert(
    JSON.stringify(await store.read()) === before,
    "file must not change for idempotent rejectQuestion",
  );
});

// ---- Round 6 (REG-402/403, sessions-resolved-cleanup §16) ----

// REG-402: removeSessionRecordsForSession 按 session_id 全局删除——跨全部
// 条目删除该会话的全部记录（无论 resolved/reply/q_* 状态）；无匹配 undefined；
// 其它会话记录不动；空 sessions 保留键；无 sessions 条目不参与。
await runCase("REG-402 removeSessionRecordsForSession deletes all records of a session across entries", async (baseDir) => {
  const reg = regWith([
    {
      path: join(baseDir, "p"),
      enabled: true,
      addedAt: "2026-01-01T00:00:00.000Z",
      sessions: [
        makeRecord({ session_id: "sess-dead", request_id: "req-a1", type: "permission" }),
        makeRecord({ session_id: "sess-dead", request_id: "req-a2", type: "question", q_answers: [["x"]] }),
        makeRecord({ session_id: "sess-live", request_id: "req-b1" }),
      ],
    },
    {
      path: join(baseDir, "q"),
      enabled: true,
      addedAt: "2026-01-01T00:00:00.000Z",
      sessions: [
        makeRecord({ session_id: "sess-dead", request_id: "req-a3", resolved: true }),
      ],
    },
    {
      path: join(baseDir, "z"),
      enabled: true,
      addedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  assert(
    removeSessionRecordsForSession(reg, "sess-none") === undefined,
    "no match must return undefined",
  );
  assert(
    removeSessionRecordsForSession(reg, "sess-liv") === undefined,
    "prefix must not match (exact match only)",
  );
  const next = removeSessionRecordsForSession(reg, "sess-dead");
  assert(next !== reg, "must return a new registry object");
  assert(
    next.projects[0].sessions.length === 1 &&
      next.projects[0].sessions[0].request_id === "req-b1",
    "live session record must stay, dead session records removed",
  );
  assert(
    next.projects[1].sessions.length === 0 &&
      Array.isArray(next.projects[1].sessions),
    "entry with only dead-session records must keep empty sessions array",
  );
  assert(
    next.projects[2] === reg.projects[2],
    "entry without sessions key must keep reference",
  );
});

// REG-403: removeExpiredSessionRecords TTL 扫除——跨全部条目删除
// Date.parse(created_at) 有限且 < now-7d 的记录；恰好等于截止线（=cutoff）
// 不删（严格 <）；不可解析/非法 created_at 保留；无任何过期 → 返回原引用；
// 有删除 → 新 registry 且其它记录不动。
await runCase("REG-403 removeExpiredSessionRecords removes only expired, keeps unparseable and boundary", async (baseDir) => {
  const now = Date.parse("2026-09-03T12:00:00.000Z");
  const TTL = 7 * 24 * 60 * 60 * 1000;
  const cutoff = now - TTL;
  const oldIso = new Date(now - TTL - 60_000).toISOString(); // 恰超 1 分钟
  const boundaryIso = new Date(cutoff).toISOString(); // 恰好 = cutoff（不删）
  const freshIso = new Date(now - 60_000).toISOString(); // 1 分钟前（不删）
  const reg = regWith([
    {
      path: join(baseDir, "p"),
      enabled: true,
      addedAt: "2026-01-01T00:00:00.000Z",
      sessions: [
        makeRecord({ request_id: "req-old-1", created_at: oldIso }),
        makeRecord({ request_id: "req-fresh", created_at: freshIso }),
      ],
    },
    {
      path: join(baseDir, "q"),
      enabled: true,
      addedAt: "2026-01-01T00:00:00.000Z",
      sessions: [
        makeRecord({ request_id: "req-old-2", created_at: oldIso }),
        makeRecord({ request_id: "req-boundary", created_at: boundaryIso }),
        makeRecord({ request_id: "req-bad-1", created_at: "not-a-date" }),
        makeRecord({ request_id: "req-bad-2", created_at: "" }),
      ],
    },
    {
      path: join(baseDir, "z"),
      enabled: true,
      addedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  const next = removeExpiredSessionRecords(reg, now);
  assert(next !== reg, "must return a new registry when something expired");
  const pRecs = next.projects[0].sessions;
  assert(
    pRecs.length === 1 && pRecs[0].request_id === "req-fresh",
    "expired record must be removed, fresh kept",
  );
  const qRecs = next.projects[1].sessions;
  const qIds = qRecs.map((r) => r.request_id).sort();
  assert(
    JSON.stringify(qIds) === JSON.stringify(["req-bad-1", "req-bad-2", "req-boundary"]),
    `boundary + unparseable must be kept, expired removed: ${JSON.stringify(qRecs)}`,
  );
  assert(
    next.projects[2] === reg.projects[2],
    "entry without sessions key must keep reference",
  );
  // 无任何过期 → 返回原 registry 引用（mutate 短路零写盘）
  const nothingExpired = removeExpiredSessionRecords(next, now);
  assert(nothingExpired === next, "nothing expired must return same reference");
});

// REG-403 (集成): mutate(removeExpiredSessionRecords) 写盘持久化、无过期
// 经 mutate 返回原引用且文件内容不变（零写盘）。
await runCase("REG-403 mutate integration: TTL sweep persists, nothing-expired no-op", async (baseDir) => {
  const filePath = join(baseDir, "projects.json");
  const store = new ProjectRegistryStore(filePath);
  await store.ensureDir();
  const p = join(baseDir, "project", "demo");
  await store.mutate((reg) => registerProject(reg, p));
  const now = Date.now();
  const TTL = 7 * 24 * 60 * 60 * 1000;
  await store.mutate((reg) =>
    appendSessionRecord(
      reg,
      p,
      makeRecord({ request_id: "req-ttl-old", created_at: new Date(now - TTL - 60_000).toISOString() }),
    ),
  );
  await store.mutate((reg) =>
    appendSessionRecord(
      reg,
      p,
      makeRecord({ request_id: "req-ttl-fresh", created_at: new Date(now - 60_000).toISOString() }),
    ),
  );
  const swept = await store.mutate((reg) => removeExpiredSessionRecords(reg, Date.now()));
  assert(swept !== undefined, "sweep mutate failed");
  const sessions = (await store.read()).projects[0].sessions;
  assert(
    sessions.length === 1 && sessions[0].request_id === "req-ttl-fresh",
    "expired record must be gone after sweep persist",
  );
  const before = JSON.stringify(await store.read());
  const idem = await store.mutate((reg) => removeExpiredSessionRecords(reg, Date.now()));
  assert(idem !== undefined, "nothing-expired sweep must succeed");
  assert(
    JSON.stringify(await store.read()) === before,
    "file must not change for nothing-expired sweep",
  );
});

const passed = total - failures;
console.log(`\n${passed}/${total} cases passed`);
process.exit(failures === 0 ? 0 : 1);