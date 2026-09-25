#!/usr/bin/env node
// Assertions over the t09-dupe-fix container scenario evidence
// (tests/e2e/container/evidence/dupe).
//
// Coverage (field incident "trigger one question → continuous repeated
// Telegram messages"):
//   D0  transport: plugin reached the fake Telegram endpoint (CONNECT + TLS)
//       and sends succeeded (no real bot token / no real Telegram traffic)
//   D1  duplicate permission record (same request_id x2, both send=false):
//       exactly ONE send over many scan rounds; every copy send=true
//       (single-round self-heal)
//   D2  question wizard send: message_id from the unwrapped response is
//       persisted as q_msg_id (the pre-fix `response.result.*` parse never was)
//   D3  diagnostics: shape line `typeof=object keys=message_id`, no
//       "Question wizard send returned no message_id" warn
//   D4  setup diagnostic `setup() pid=… root=…` recorded (multi-load triage)
//
// Usage: node assert/dupe.mjs <evidence-dir>
// Exit code 0 = all checks passed; 1 = at least one failed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node assert/dupe.mjs <evidence-dir>");
  process.exit(2);
}

const PERM_MARKER = "t09-dupe-marker-perm";
const QUESTION_MARKER = "t09-dupe-marker-question";
const PERM_REQUEST_ID = "per_t09dupe0001";
const QUESTION_REQUEST_ID = "frm_t09dupe0002";
const PERM_WARN = "Question wizard send returned no message_id";

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
function readJSONL(name) {
  const text = readText(name);
  if (text === undefined) return [];
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
}
function recordsIn(name) {
  const registry = readJSON(name);
  if (!registry?.projects) return [];
  return registry.projects.flatMap((entry) => entry.sessions ?? []);
}

const tgLog = readJSONL("fake-telegram.jsonl");
const sends = tgLog.filter(
  (entry) => entry.method === "sendRichMessage" || entry.method === "sendMessage",
);
const projects = recordsIn("projects-after-dupe.json");
const diag = readText("tgdiag-dupe.txt") ?? "";

// ---- D0: transport ----------------------------------------------------------
check(
  "D0.1",
  tgLog.some((entry) => entry.event === "tls_ok"),
  `plugin completed CONNECT + TLS with the fake endpoint (${tgLog.filter((e) => e.event === "tls_ok").length} tls_ok)`,
);
check(
  "D0.2",
  sends.length >= 1,
  `sends reached the fake Telegram endpoint (${sends.length} send call(s), no real Telegram traffic)`,
);
const pollRounds = tgLog.filter((entry) => entry.method === "getUpdates").length;
check(
  "D0.3",
  pollRounds >= 2,
  `multiple poll rounds elapsed while the observation window ran (${pollRounds} getUpdates)`,
);

// ---- D1: duplicate permission record ---------------------------------------
const permSends = sends.filter((entry) =>
  String(entry.html ?? "").includes(PERM_MARKER),
);
check(
  "D1.1",
  permSends.length === 1,
  `duplicated request_id sent exactly once over the whole window (got ${permSends.length})`,
);
const permCopies = projects.filter((r) => r.request_id === PERM_REQUEST_ID);
check(
  "D1.2",
  permCopies.length === 2,
  `both duplicate copies still present in the registry (got ${permCopies.length})`,
);
check(
  "D1.3",
  permCopies.length > 0 && permCopies.every((r) => r.send === true),
  `every duplicate copy marked send=true (self-heal): ${JSON.stringify(permCopies.map((r) => r.send))}`,
);

// ---- D2: wizard message_id parse fix ---------------------------------------
const questionSends = sends.filter((entry) =>
  String(entry.html ?? "").includes(QUESTION_MARKER),
);
check(
  "D2.1",
  questionSends.length === 1,
  `question wizard sent exactly once (got ${questionSends.length})`,
);
const wizardMessageID = questionSends[0]?.message_id;
const questionRecord = projects.find((r) => r.request_id === QUESTION_REQUEST_ID);
check(
  "D2.2",
  typeof wizardMessageID === "number" &&
    questionRecord?.q_msg_id === wizardMessageID,
  `q_msg_id persisted from the unwrapped response (returned=${wizardMessageID}, persisted=${questionRecord?.q_msg_id})`,
);
check(
  "D2.3",
  questionRecord?.send === true,
  `question record marked send=true (got ${questionRecord?.send})`,
);

// ---- D3: diagnostics --------------------------------------------------------
check(
  "D3.1",
  diag.includes(
    "sendMessageWithKeyboard response: typeof=object keys=message_id",
  ),
  "shape diagnostic records typeof=object keys=message_id",
);
check(
  "D3.2",
  !diag.includes(PERM_WARN),
  "no 'Question wizard send returned no message_id' warn (pre-fix symptom)",
);

// ---- D4: setup diagnostic ---------------------------------------------------
check(
  "D4.1",
  /setup\(\) pid=\d+ root=\/tmp\/proj/.test(diag),
  "setup() activation recorded with pid + root",
);

// ---- summary ----------------------------------------------------------------
console.log("");
console.log(`checks: failures=${failures}`);
process.exit(failures === 0 ? 0 : 1);
