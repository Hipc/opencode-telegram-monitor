// tests/registry-sessions.test.mjs
//
// 纯函数测试：SessionRecord 承载（sessions-relay.md §3/§4，REG-101；Round 2
// 扩展 §13.1/§13.2，REG-201）。
// 覆盖：parse/serialize 白名单往返保留全字段、旧文件无 sessions 键、非数组丢弃、
// 损坏记录容错、append 追加不覆盖、mark* 按 request_id 精确匹配（无匹配
// undefined / 已置位幂等原引用 / 两字段互不联动）、既有 parse 语义保持、
// mutate 集成（写盘 + undefined 不写盘）、reply 字段四态往返与容错、
// setSessionReply 三态（写入/无匹配 undefined/幂等原引用/send、resolved 不受影响）。
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
  markSessionResolved,
  markSessionSent,
  setSessionReply,
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

// REG-101: markSessionResolved 按 request_id 全局精确匹配（跨条目第一条）；
// 无匹配 undefined；已置位幂等返回原引用；send 保持不动；前缀不匹配。
await runCase("REG-101 markSessionResolved matches by request_id", async (baseDir) => {
  const reg = regWith([
    {
      path: join(baseDir, "p"),
      enabled: true,
      addedAt: "2026-01-01T00:00:00.000Z",
      sessions: [makeRecord({ request_id: "req-1", send: false })],
    },
    {
      path: join(baseDir, "q"),
      enabled: true,
      addedAt: "2026-01-01T00:00:00.000Z",
      sessions: [makeRecord({ request_id: "req-2" })],
    },
  ]);
  assert(
    markSessionResolved(reg, "req-missing") === undefined,
    "no match must return undefined",
  );
  assert(
    markSessionResolved(reg, "req-") === undefined,
    "prefix must not match (exact match only)",
  );
  const next = markSessionResolved(reg, "req-2"); // 跨条目匹配第二条目
  assert(next !== reg, "must return a new registry object");
  assert(next.projects[1].sessions[0].resolved === true, "req-2 not resolved");
  assert(
    next.projects[0].sessions[0].resolved === false,
    "other record must not be touched",
  );
  assert(
    next.projects[1].sessions[0].send === false,
    "send must stay untouched by markSessionResolved",
  );
  const again = markSessionResolved(next, "req-2");
  assert(again === next, "idempotent mark must return same reference");
  // 无 sessions 的条目不参与匹配
  const regMixed = regWith([
    { path: join(baseDir, "z"), enabled: true, addedAt: "2026-01-01T00:00:00.000Z" },
    {
      path: join(baseDir, "p"),
      enabled: true,
      addedAt: "2026-01-01T00:00:00.000Z",
      sessions: [makeRecord({ request_id: "req-z" })],
    },
  ]);
  assert(
    markSessionResolved(regMixed, "req-z") !== undefined,
    "entries without sessions key must be skipped, not break matching",
  );
  // send=true 的记录仍可 resolved（两字段互不联动）
  const sent = regWith([
    {
      path: join(baseDir, "p"),
      enabled: true,
      addedAt: "2026-01-01T00:00:00.000Z",
      sessions: [makeRecord({ session_id: "sess-s", request_id: "req-s", send: true })],
    },
  ]);
  const resolvedAfterSent = markSessionResolved(sent, "req-s");
  assert(
    resolvedAfterSent.projects[0].sessions[0].resolved === true &&
      resolvedAfterSent.projects[0].sessions[0].send === true,
    "markSessionResolved must not clear send",
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

// REG-101 (集成): mutate(appendSessionRecord/markSessionResolved) 写盘持久化、
// 无匹配 mark 经 mutate 返回 undefined 且文件内容不变、幂等不写盘。
await runCase("REG-101 mutate integration: append/mark persist, no-match no-op", async (baseDir) => {
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

  const marked = await store.mutate((reg) =>
    markSessionResolved(reg, "req-int"),
  );
  assert(
    marked.projects[0].sessions[0].resolved === true,
    "resolved not persisted",
  );
  const afterResolved = await reader.read();
  assert(
    afterResolved.projects[0].sessions[0].resolved === true &&
      afterResolved.projects[0].sessions[0].send === false,
    "resolved/send state wrong after persist",
  );

  // 无匹配 → mutate 返回 undefined 且文件内容不变
  const before = JSON.stringify(await reader.read());
  const none = await store.mutate((reg) => markSessionSent(reg, "req-nope"));
  assert(none === undefined, "no-match mark must yield undefined from mutate");
  const afterNoop = JSON.stringify(await reader.read());
  assert(afterNoop === before, "file must not change for no-match mark");

  // 幂等已置位 → mutate 返回非 undefined（原缓存刷新路径）且内容不变
  const idem = await store.mutate((reg) =>
    markSessionResolved(reg, "req-int"),
  );
  assert(
    idem !== undefined && idem.projects[0].sessions[0].resolved === true,
    "idempotent mark must succeed",
  );
  assert(
    JSON.stringify(await reader.read()) === before,
    "file must not change for idempotent mark",
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

const passed = total - failures;
console.log(`\n${passed}/${total} cases passed`);
process.exit(failures === 0 ? 0 : 1);