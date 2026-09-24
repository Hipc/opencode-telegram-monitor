#!/usr/bin/env node
// Assertions over the container e2e harness evidence (tests/e2e/container/harness).
//
// Coverage (ticket 05 acceptance):
//   H1  plugin auto-discovery + initialization (loader line, diag)
//   H2  waiting records: permission + question SessionRecords in projects.json
//   H3  write-back closure: injected reply -> client.permission.reply ->
//       permission.replied on the wire + record deleted
//       (H3.2 form closure runs only when the evidence is present; otherwise
//        reported as pending — see T05_HARNESS_FORM_REPLY in README)
//   H4  lifecycle: terminal execution event + terminal notification attempt
//       recorded in tgdiag.log
//
// Usage: node assert/harness.mjs <evidence-dir> [--form-reply]
// Exit code 0 = all executed checks passed; 1 = at least one failed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node assert/harness.mjs <evidence-dir> [--form-reply]");
  process.exit(2);
}
const requireFormReply = process.argv.includes("--form-reply");

let failures = 0;
let warnings = 0;
let pending = 0;

function check(id, condition, detail) {
  if (condition) console.log(`ok   ${id}: ${detail}`);
  else {
    failures += 1;
    console.error(`FAIL ${id}: ${detail}`);
  }
}
function warn(id, detail) {
  warnings += 1;
  console.log(`warn ${id}: ${detail}`);
}
function markPending(id, detail) {
  pending += 1;
  console.log(`pending ${id}: ${detail}`);
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
function deepFind(value, predicate) {
  if (predicate(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFind(item, predicate);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const found = deepFind(item, predicate);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

const ids = readJSON("phase-ids.json");
check("H0.1", Boolean(ids?.sessionID && ids?.permissionID && ids?.formID), `phase ids recorded: ${JSON.stringify(ids)}`);
if (!ids) {
  console.error("cannot continue without phase-ids.json");
  process.exit(1);
}

// ---- H1: loading + initialization ------------------------------------------
const serverLog = readText("server-log.txt") ?? "";
check(
  "H1.1",
  /loading plugin.*telegram-session-monitor\.ts/.test(serverLog),
  "plugin loaded by <configDir>/plugin/ auto-discovery (server log)",
);
check(
  "H1.2",
  !/failed to load plugin/.test(serverLog),
  "no 'failed to load plugin' line in the server log",
);
const diagBoot = readText("tgdiag-after-boot.txt") ?? "";
check(
  "H1.3",
  /MODULE LOADED|initialize\(\) called/.test(diagBoot),
  "plugin initialization recorded in ~/.otg/tgdiag.log",
);

// ---- H2: waiting records ----------------------------------------------------
function recordsIn(name) {
  const registry = readJSON(name);
  if (!registry?.projects) return [];
  return registry.projects.flatMap((entry) => entry.sessions ?? []);
}

const afterPermission = recordsIn("projects-after-permission.json");
const permRecord = afterPermission.find((r) => r.request_id === ids.permissionID);
check("H2.1", Boolean(permRecord), `permission SessionRecord persisted (${ids.permissionID})`);
if (permRecord) {
  check("H2.1a", permRecord.type === "permission", `record type=permission (got ${permRecord.type})`);
  check("H2.1b", permRecord.session_id === ids.sessionID, `record session_id matches (${permRecord.session_id})`);
  check("H2.1c", typeof permRecord.send === "boolean" && permRecord.send === false, `send=false with synthetic bot token (got ${permRecord.send})`);
  const parsed = JSON.parse(permRecord.message);
  check(
    "H2.1d",
    Boolean(deepFind(parsed, (v) => v === ids.permissionID)) &&
      Boolean(deepFind(parsed, (v) => v && typeof v === "object" && typeof v.action === "string")),
    "record.message is the full permission payload JSON (id + action present)",
  );
}

const afterForm = recordsIn("projects-after-form.json");
const formRecord = afterForm.find((r) => r.request_id === ids.formID);
check("H2.2", Boolean(formRecord), `question SessionRecord persisted (${ids.formID})`);
if (formRecord) {
  check("H2.2a", formRecord.type === "question", `record type=question (got ${formRecord.type})`);
  const parsed = JSON.parse(formRecord.message);
  const fields = deepFind(parsed, (v) => Array.isArray(v) && v.length > 0 && v[0] && typeof v[0].key === "string");
  check(
    "H2.2b",
    Boolean(deepFind(parsed, (v) => v === ids.formID)) && Boolean(fields),
    "record.message carries the full form payload incl. fields[]",
  );
}

// ---- H3.1: permission write-back closure -----------------------------------
const afterReply = recordsIn("projects-after-reply.json");
check(
  "H3.1",
  !afterReply.some((r) => r.request_id === ids.permissionID),
  "permission record deleted after the injected reply was applied",
);
const sse = readText("sse-raw.txt") ?? "";
const sseEvents = sse
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
check(
  "H3.2",
  sseEvents.some(
    (e) => e.type === "permission.replied" && e.data?.requestID === ids.permissionID,
  ),
  `permission.replied emitted on the wire for ${ids.permissionID}`,
);
const diagFinal = readText("tgdiag-final.txt") ?? "";
check(
  "H3.3",
  /reply applied|applySessionReply|permission reply applied/i.test(diagFinal),
  "plugin diag records the permission reply application",
);

// ---- H3.4/H3.5: optional form write-back closure ----------------------------
const formReplyEvidence = readText("projects-after-form-reply.json");
if (formReplyEvidence !== undefined) {
  const afterFormReply = recordsIn("projects-after-form-reply.json");
  check(
    "H3.4",
    !afterFormReply.some((r) => r.request_id === ids.formID),
    "question record deleted after the injected q_answers were applied",
  );
  check(
    "H3.5",
    sseEvents.some((e) => e.type === "form.replied" && e.data?.id === ids.formID),
    `form.replied emitted on the wire for ${ids.formID}`,
  );
} else if (requireFormReply) {
  failures += 1;
  console.error(
    "FAIL H3.4: --form-reply requested but projects-after-form-reply.json is missing (plugin did not run the form phase)",
  );
} else {
  markPending(
    "H3.4",
    "form write-back closure not exercised (set T05_HARNESS_FORM_REPLY=1 once the plugin implements the §9/A.1 channel)",
  );
}

// ---- H4: lifecycle notification attempt ------------------------------------
check(
  "H4.1",
  sseEvents.some(
    (e) =>
      e.type === "session.execution.failed" ||
      e.type === "session.execution.succeeded" ||
      e.type === "session.execution.interrupted",
  ),
  "terminal session.execution.* event observed on the wire",
);
check(
  "H4.2",
  /Telegram message send failed|terminal notification attempt failed/i.test(diagFinal),
  "terminal notification attempt recorded in tgdiag.log",
);

// ---- summary ----------------------------------------------------------------
console.log("");
console.log(`checks: failures=${failures} warnings=${warnings} pending=${pending}`);
process.exit(failures === 0 ? 0 : 1);
