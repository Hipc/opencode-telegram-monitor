#!/usr/bin/env node
// Assertions over the t13-shared-cross container scenario evidence
// (tests/e2e/container/evidence/t13-shared-cross).
//
// Field incident: two opencode servers sharing ONE HOME/XDG storage. A =
// `serve --service` hosts the sessions; B = plain `serve --port` shares the
// registry and runs its own reply scan. The t10 gate (client.session.get) fails
// open in this topology (P4: identical payloads), so B applied the TG-written
// terminal fields to its own endpoint, got HTTP 404, classified it terminal and
// deleted the shared records; the host never applied.
//
// Positive mode (default) asserts the t13 fix:
//   T1 records are stamped with the creating (host) pid;
//   T2 the non-owner B skips every record via the host stamp (no apply, no
//      terminal 404, no deletion while A is frozen);
//   T3 the owner A applies exactly once after resume (form.replied /
//      form.cancelled / permission.replied on A's stream) and removes the
//      records.
//
// Negative-control mode (--negative-control): the same scenario against the
// pre-fix bundle. Asserts the field signature: B 404-deletes all three shared
// records while A is frozen; A never emits a settle event.
//
// Usage: node assert/t13-shared-cross.mjs <evidence-dir> [--negative-control]
// Exit code 0 = all checks passed; 1 = at least one failed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const negative = process.argv.includes("--negative-control");
if (!dir) {
  console.error(
    "usage: node assert/t13-shared-cross.mjs <evidence-dir> [--negative-control]",
  );
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
  "T0.1",
  Boolean(
    ids?.aPid &&
      ids?.bPid &&
      ids?.sessionID &&
      ids?.permissionID &&
      ids?.form1 &&
      ids?.form2,
  ),
  `phase ids recorded: ${JSON.stringify(ids)}`,
);
if (!ids) {
  console.error("cannot continue without phase-ids.json");
  process.exit(1);
}
const { aPid, bPid, sessionID, permissionID, form1, form2 } = ids;
const requestIDs = [permissionID, form1, form2];
const aDiag = linesFor(aPid, "tgdiag-final.txt");
const bDiag = linesFor(bPid, "tgdiag-final.txt");
const bDiagWindow = linesFor(bPid, "tgdiag-after-b-window.txt");
const aSse = sseEvents("a-sse.txt");
const bSse = sseEvents("b-sse.txt");
const before = recordsIn("projects-before-inject.json");
const afterB = recordsIn("projects-after-b-window.json");
const final = recordsIn("projects-final.json");
const aCmdline = readText("a-cmdline.txt") ?? "";
const bCmdline = readText("b-cmdline.txt") ?? "";
const aEnv = readText("a-env-check.txt") ?? "";
const bEndpoint = readText("b-endpoint.txt") ?? "";

const beforeFor = (rid) => before.filter((r) => r.request_id === rid);
const afterBFor = (rid) => afterB.filter((r) => r.request_id === rid);
const finalFor = (rid) => final.filter((r) => r.request_id === rid);
const aEventsFor = (rid) =>
  aSse.filter(
    (e) =>
      (e.type === "form.replied" && e.data?.id === rid) ||
      (e.type === "form.cancelled" && e.data?.id === rid) ||
      (e.type === "permission.replied" && e.data?.requestID === rid),
  );
const bEventsFor = (rid) =>
  bSse.filter(
    (e) =>
      (e.type === "form.replied" && e.data?.id === rid) ||
      (e.type === "form.cancelled" && e.data?.id === rid) ||
      (e.type === "permission.replied" && e.data?.requestID === rid),
  );

if (negative) {
  // Pre-fix signature: B applies to itself, classifies the 404 as terminal and
  // deletes all three shared records while A is frozen; A never applies.
  check(
    "X1.1",
    aCmdline.length > 0 && !/\s--port(\s|=)/.test(aCmdline),
    "pre-fix run: A is the service daemon (no --port in argv)",
  );
  check(
    "X1.2",
    requestIDs.every((rid) => beforeFor(rid).length === 1),
    `pre-fix run: all three records existed before injection (${requestIDs
      .map((rid) => beforeFor(rid).length)
      .join("/")})`,
  );
  check(
    "X1.3",
    /\s--port(\s|=)/.test(bCmdline) && /b_server_password_env=present/.test(bEndpoint),
    "pre-fix run: B had its own --port + env password (self-endpoint resolvable)",
  );
  check(
    "X2.1",
    bDiagWindow.includes("Form reply is terminal (HTTP 404)") &&
      bDiagWindow.includes(form1),
    "pre-fix run: non-owner B classified the form1 self-POST 404 as terminal",
  );
  check(
    "X2.2",
    bDiagWindow.includes("Form cancel is terminal (HTTP 404)") &&
      bDiagWindow.includes(form2),
    "pre-fix run: non-owner B classified the form2 self-DELETE 404 as terminal",
  );
  check(
    "X2.3",
    bDiagWindow.includes("Permission request no longer exists (404)") &&
      bDiagWindow.includes(permissionID),
    "pre-fix run: non-owner B deleted the permission record on its self-reply 404",
  );
  check(
    "X2.4",
    requestIDs.every((rid) => afterBFor(rid).length === 0),
    `pre-fix run: all three records were deleted by the non-owner while A was frozen (left ${requestIDs
      .map((rid) => afterBFor(rid).length)
      .join("/")})`,
  );
  check(
    "X2.5",
    !bDiagWindow.includes("apply skipped: waiting record owned by another instance"),
    "pre-fix run: no host-stamp skip existed (the gate fails open in shared storage)",
  );
  check(
    "X3.1",
    requestIDs.every((rid) => aEventsFor(rid).length === 0),
    `pre-fix run: owner A never settled any request (events ${requestIDs
      .map((rid) => aEventsFor(rid).length)
      .join("/")})`,
  );
} else {
  // ---- T1: host stamp + topology --------------------------------------------
  check(
    "T1.1",
    aCmdline.length > 0 && !/\s--port(\s|=)/.test(aCmdline) && /server_password_env=absent/.test(aEnv),
    "A is the service daemon (no --port in argv, no password env)",
  );
  check(
    "T1.2",
    /\s--port(\s|=)/.test(bCmdline) && /b_server_password_env=present/.test(bEndpoint),
    "B is a plain serve with its own --port + env password",
  );
  check(
    "T1.3",
    ids.aRoot === ids.bRoot,
    `both plugins activated the same root (${ids.aRoot} vs ${ids.bRoot})`,
  );
  check(
    "T1.4",
    requestIDs.every((rid) => beforeFor(rid).length === 1),
    `all three records persisted before injection (${requestIDs
      .map((rid) => beforeFor(rid).length)
      .join("/")})`,
  );
  check(
    "T1.5",
    requestIDs.every((rid) => beforeFor(rid)[0]?.host_pid === aPid),
    `every record carries host_pid=${aPid} (the creating host): ${JSON.stringify(
      before.map((r) => [r.request_id, r.host_pid]),
    )}`,
  );

  // ---- T2: non-owner B must skip without deleting ---------------------------
  check(
    "T2.1",
    requestIDs.every((rid) =>
      bDiagWindow
        .split("\n")
        .some(
          (line) =>
            line.includes("apply skipped: waiting record owned by another instance") &&
            line.includes(`request=${rid}`) &&
            line.includes(`host_pid=${aPid}`),
        ),
    ),
    "B skipped every record via the host stamp",
  );
  check(
    "T2.2",
    !bDiagWindow.includes("Form reply is terminal (HTTP 404)") &&
      !bDiagWindow.includes("Form cancel is terminal (HTTP 404)") &&
      !bDiagWindow.includes("Permission request no longer exists (404)"),
    "B performed no terminal 404 action",
  );
  check(
    "T2.3",
    requestIDs.every((rid) => afterBFor(rid).length === 1),
    `records untouched while B skipped and A was frozen (${requestIDs
      .map((rid) => afterBFor(rid).length)
      .join("/")})`,
  );
  check(
    "T2.4",
    requestIDs.every((rid) => bEventsFor(rid).length === 0),
    "B emitted no settle event for any request",
  );

  // ---- T3: owner closure -----------------------------------------------------
  check(
    "T3.1",
    aEventsFor(form1).length === 1 &&
      aEventsFor(form1)[0]?.type === "form.replied",
    `A applied form1 exactly once (events=${aEventsFor(form1).length})`,
  );
  check(
    "T3.2",
    aEventsFor(form2).length === 1 &&
      aEventsFor(form2)[0]?.type === "form.cancelled",
    `A cancelled form2 exactly once (events=${aEventsFor(form2).length})`,
  );
  check(
    "T3.3",
    aEventsFor(permissionID).length === 1 &&
      aEventsFor(permissionID)[0]?.type === "permission.replied",
    `A applied the permission exactly once (events=${aEventsFor(permissionID).length})`,
  );
  check(
    "T3.4",
    requestIDs.every((rid) => finalFor(rid).length === 0),
    `records removed after the owner applied (${requestIDs
      .map((rid) => finalFor(rid).length)
      .join("/")})`,
  );
  check(
    "T3.5",
    !aDiag.includes("is terminal (HTTP 404)") &&
      !aDiag.includes("question apply failed") &&
      !aDiag.includes("Permission reply apply failed"),
    "A saw no terminal 404 and no apply failure",
  );
  check(
    "T3.6",
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
