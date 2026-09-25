#!/usr/bin/env node
// Assertions over the t10-cross container scenario evidence
// (tests/e2e/container/evidence/t10-cross).
//
// Field incident: a non-owning opencode server sharing the registry resolved
// its own endpoint, POSTed the form reply to itself, got 404 and deleted the
// shared record; the owning service daemon could not even discover its own
// endpoint (argv has no --port, env has no password).
//
// Positive mode (default) asserts both t10 fixes:
//   N1 endpoint discovery: server A = `opencode serve --service` (no --port in
//      argv, no OPENCODE_SERVER_PASSWORD in env) discovers itself through the
//      state service.json (pid match) and applies the form reply (204 ->
//      form.replied on A's event stream, record removed).
//   N2 ownership gate: server B (argv --port + env password, same project root,
//      separate session storage) skips the record through client.session.get:
//      no apply, no terminal 404 removal, no record deletion while A is frozen.
//   N3 closure: owner applies exactly once; record removed; no owner-side
//      discovery failure or terminal 404.
//
// Negative-control mode (--negative-control): the same scenario run against a
// pre-fix bundle. Asserts the field signature instead: B (non-owner) resolves
// its own endpoint, gets the terminal 404 and deletes the record while A is
// frozen; A never emits form.replied.
//
// Usage: node assert/t10-cross.mjs <evidence-dir> [--negative-control]
// Exit code 0 = all checks passed; 1 = at least one failed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const negative = process.argv.includes("--negative-control");
if (!dir) {
  console.error("usage: node assert/t10-cross.mjs <evidence-dir> [--negative-control]");
  process.exit(2);
}

let failures = 0;
function check(id, condition, detail) {
  if (condition) console.log(`ok   ${id}: ${detail}`);
  else {
    failures += 1;
    console.error(`FAIL ${id}: ${detail}`);
  }
}

function readText(name) {
  const path = join(dir, name);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}
function readJSON(name) {
  const text = readText(name);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
function recordsIn(name) {
  const registry = readJSON(name);
  if (!registry?.projects) return [];
  return registry.projects.flatMap((entry) => entry.sessions ?? []);
}
function sseEvents(name) {
  return (readText(name) ?? "")
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => {
      try {
        return JSON.parse(line.slice(6));
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
}
function linesFor(pid, name) {
  const text = readText(name) ?? "";
  return text
    .split("\n")
    .filter((line) => line.includes(`[${pid}]`))
    .join("\n");
}

const ids = readJSON("phase-ids.json");
check(
  "N0.1",
  Boolean(ids?.aPid && ids?.bPid && ids?.sessionID && ids?.formID),
  `phase ids recorded: ${JSON.stringify(ids)}`,
);
if (!ids) {
  console.error("cannot continue without phase-ids.json");
  process.exit(1);
}
const { aPid, bPid, sessionID, formID } = ids;
const aDiag = linesFor(aPid, "tgdiag-final.txt");
const bDiag = linesFor(bPid, "tgdiag-final.txt");
const aSse = sseEvents("a-sse.txt");
const bSse = sseEvents("b-sse.txt");
const aReplied = aSse.filter((e) => e.type === "form.replied" && e.data?.id === formID);
const bReplied = bSse.filter((e) => e.type === "form.replied" && e.data?.id === formID);
const before = recordsIn("projects-before-inject.json").filter((r) => r.request_id === formID);
const afterBSkip = recordsIn("projects-after-b-skip.json").filter((r) => r.request_id === formID);
const finalRecords = recordsIn("projects-final.json").filter((r) => r.request_id === formID);
const aCmdline = readText("a-cmdline.txt") ?? "";
const bCmdline = readText("b-cmdline.txt") ?? "";
const aEnv = readText("a-env-check.txt") ?? "";
const bEndpoint = readText("b-endpoint.txt") ?? "";

if (negative) {
  // Pre-fix signature: the non-owner B wrongly applies to itself and gets the
  // terminal 404 -> record deleted while the owner is frozen; A never applies.
  check(
    "X1.1",
    aCmdline.length > 0 && !/\s--port(\s|=)/.test(aCmdline),
    "pre-fix run: A is the service daemon (no --port in argv), so discovery must fail",
  );
  check(
    "X1.2",
    before.length === 1,
    `pre-fix run: form record existed before injection (got ${before.length})`,
  );
  check(
    "X1.3",
    /\s--port(\s|=)/.test(bCmdline) && /b_server_password_env=present/.test(bEndpoint),
    "pre-fix run: B had its own --port + env password (self-endpoint resolvable)",
  );
  check(
    "X2.1",
    bDiag.includes("Form reply is terminal (HTTP 404)") &&
      bDiag.includes(formID),
    "pre-fix run: non-owner B classified the self-POST 404 as terminal for the form",
  );
  check(
    "X2.2",
    afterBSkip.length === 0,
    `pre-fix run: record was deleted by the non-owner while A was frozen (left ${afterBSkip.length})`,
  );
  check(
    "X3.1",
    aReplied.length === 0,
    `pre-fix run: owner never applied the form (form.replied=${aReplied.length})`,
  );
} else {
  // ---- N1: endpoint discovery (service daemon) ------------------------------
  check(
    "N1.1",
    aCmdline.length > 0 && !/\s--port(\s|=)/.test(aCmdline),
    `A is the service daemon: no --port in argv (${aCmdline.trim() || "missing"})`,
  );
  check(
    "N1.2",
    /server_password_env=absent/.test(aEnv),
    `A has no OPENCODE_SERVER_PASSWORD env, so only service.json can authenticate (${aEnv.trim()})`,
  );
  check(
    "N1.3",
    !aDiag.includes("server port not discoverable") &&
      !aDiag.includes("Form reply channel unavailable"),
    "A did not hit any endpoint-discovery failure",
  );
  check(
    "N1.4",
    before.length === 1 && before[0].type === "question",
    `question record persisted on A before injection (got ${before.length})`,
  );

  // ---- N2: ownership gate (non-owner B) -------------------------------------
  check(
    "N2.1",
    /\s--port(\s|=)/.test(bCmdline) &&
      /b_server_password_env=present/.test(bEndpoint),
    "B could resolve its own endpoint (argv --port + env password) - the gate is what stops it",
  );
  check(
    "N2.2",
    bDiag.includes(
      `apply skipped: session not hosted by this instance request=${formID}`,
    ),
    "B skipped the record via the session.get ownership gate",
  );
  check(
    "N2.3",
    afterBSkip.length === 1,
    `record untouched while B skipped and A was frozen (copies=${afterBSkip.length})`,
  );
  check(
    "N2.4",
    !bDiag.includes("Form reply is terminal (HTTP 404)") &&
      !bDiag.includes("Form reply rejected with HTTP"),
    "B performed no terminal action on the non-hosted record",
  );
  check(
    "N2.5",
    bReplied.length === 0,
    `B emitted no form.replied (got ${bReplied.length})`,
  );

  // ---- N3: owner closure -----------------------------------------------------
  check(
    "N3.1",
    aReplied.length === 1,
    `owner A applied the form exactly once (form.replied=${aReplied.length})`,
  );
  check(
    "N3.2",
    finalRecords.length === 0,
    `record removed after the owner applied (left ${finalRecords.length})`,
  );
  check(
    "N3.3",
    !aDiag.includes("Form reply is terminal (HTTP 404)") &&
      !aDiag.includes("question apply failed"),
    "owner A saw no terminal 404 and no apply failure for the record",
  );
  check(
    "N3.4",
    ids.aRoot === ids.bRoot,
    `both plugins shared one project root (${ids.aRoot} vs ${ids.bRoot})`,
  );
  check(
    "N3.5",
    Boolean(sessionID),
    `session id recorded: ${sessionID}`,
  );
}

console.log(
  negative
    ? `\nnegative-control checks: ${failures === 0 ? "PASSED" : `${failures} FAILED`}`
    : `\nchecks: ${failures === 0 ? "PASSED" : `${failures} FAILED`}`,
);
process.exit(failures === 0 ? 0 : 1);
