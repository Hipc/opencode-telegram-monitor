#!/usr/bin/env node
// Assertions over the §9/A.1 + A.6 probe evidence (tests/e2e/container/probe-a1).
//
// Reads probe-a1.jsonl (plugin evidence) and sse-raw.txt (server wire view) and
// decides:
//   - whether the in-process Basic-auth HTTP channel settles a form (A.1)
//   - whether the natural model question flow produces form.created (A.6)
//   - whether the natural form can be answered through the proven channel so
//     the question tool succeeds and the model turn completes.
//
// Usage: node assert/probe-a1.mjs <evidence-dir>
// Exit code 0 = all required checks passed; 1 = at least one failed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node assert/probe-a1.mjs <evidence-dir>");
  process.exit(2);
}

const logPath = join(dir, "probe-a1.jsonl");
if (!existsSync(logPath)) {
  console.error(`FAIL: missing ${logPath}`);
  process.exit(1);
}

const records = readFileSync(logPath, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { type: "unparsable", raw: line.slice(0, 120) };
    }
  });

// Server-side wire view (independent of the plugin): the same forms must appear
// as form.replied on GET /api/event.
const ssePath = join(dir, "sse-raw.txt");
const sseEvents = existsSync(ssePath)
  ? readFileSync(ssePath, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => {
        try {
          return JSON.parse(line.slice(6));
        } catch {
          return undefined;
        }
      })
      .filter(Boolean)
  : [];
const sseRepliedIDs = new Set(
  sseEvents.filter((e) => e.type === "form.replied").map((e) => e.data?.id),
);

const byType = (type) => records.filter((r) => r.type === type);
const setup = byType("probe.setup")[0]?.payload;
const attempts = byType("probe.reply.http.attempt").map((r) => r.payload);
const forms = byType("form.created").map((r) => r.payload?.data?.form);
const repliedIDs = new Set(byType("form.replied").map((r) => r.payload?.data?.id));
const cancelledIDs = new Set(byType("form.cancelled").map((r) => r.payload?.data?.id));
const toolInputs = byType("session.tool.input.started").map((r) => r.payload?.data);
const toolSuccess = byType("session.tool.success").map((r) => r.payload?.data);
const toolFailed = byType("session.tool.failed").map((r) => r.payload?.data);
const execSucceeded = byType("session.execution.succeeded");
const execInterrupted = byType("session.execution.interrupted");
const execFailed = byType("session.execution.failed");
const rpcCandidate = byType("probe.reply.rpc.candidate")[0]?.payload;
const rpcResult = byType("probe.reply.rpc.result")[0]?.payload;

let failures = 0;
let warnings = 0;

function check(id, condition, detail) {
  if (condition) {
    console.log(`ok   ${id}: ${detail}`);
  } else {
    failures += 1;
    console.error(`FAIL ${id}: ${detail}`);
  }
}
function warn(id, detail) {
  warnings += 1;
  console.log(`warn ${id}: ${detail}`);
}

// ---- P0: probe plugin actually ran inside opencode -------------------------
check("A1-P0.1", Boolean(setup), "probe.setup recorded (plugin loaded by auto-discovery)");
if (setup) {
  check(
    "A1-P0.2",
    setup.serverPortFromArgv > 0,
    `serve port discovered from process.argv (--port ${setup.serverPortFromArgv})`,
  );
  check(
    "A1-P0.3",
    setup.envPresence?.OPENCODE_SERVER_PASSWORD === true ||
      setup.envPresence?.OPENCODE_PASSWORD === true,
    `server password visible in the plugin process env (SERVER_PASSWORD=${setup.envPresence?.OPENCODE_SERVER_PASSWORD}, OPENCODE_PASSWORD=${setup.envPresence?.OPENCODE_PASSWORD})`,
  );
  check(
    "A1-P0.4",
    Array.isArray(setup.rpcInterestPaths),
    `rpc namespace enumerated; interest paths: ${JSON.stringify(setup.rpcInterestPaths)}`,
  );
}

// ---- A.1: candidate-channel matrix on a settled form -----------------------
const controlForm = forms.find((f) => f && !f.metadata?.kind);
const naturalForm = forms.find((f) => f && f.metadata?.kind === "question");

function attemptsFor(formID) {
  return attempts.filter((a) => a.formID === formID);
}
function statusOf(formID, label) {
  const found = attemptsFor(formID).filter((a) => a.attempt === label);
  return found.length > 0 ? found[0].status : undefined;
}

function assertChannel(form, label) {
  if (!form) {
    warn(`A1-${label}.0`, "form not observed in this run");
    return false;
  }
  const noAuth = statusOf(form.id, "no-auth");
  const bearer = statusOf(form.id, "bearer");
  const basic = statusOf(form.id, "basic");
  check(`A1-${label}.1`, noAuth === 401, `no-auth control returns 401 (got ${noAuth})`);
  check(`A1-${label}.2`, bearer === 401, `bearer control returns 401 (got ${bearer})`);
  check(`A1-${label}.3`, basic === 204, `Basic auth returns 204 (got ${basic})`);
  check(
    `A1-${label}.4`,
    repliedIDs.has(form.id),
    `form ${form.id} transitioned to form.replied (plugin stream)`,
  );
  check(
    `A1-${label}.5`,
    sseRepliedIDs.has(form.id),
    `form ${form.id} form.replied observed on GET /api/event (server wire view)`,
  );
  return basic === 204 && repliedIDs.has(form.id);
}

console.log("---- A.1 candidate channel (deterministic control form) ----");
const controlProven = assertChannel(controlForm, "control");

console.log("---- A.6 natural question flow ----");
check(
  "A6.1",
  Boolean(naturalForm),
  `model question tool produced form.created (id=${naturalForm?.id ?? "none"})`,
);
let naturalProven = false;
if (naturalForm) {
  check(
    "A6.2",
    naturalForm.metadata?.kind === "question",
    `natural form metadata.kind=${naturalForm.metadata?.kind}`,
  );
  naturalProven = assertChannel(naturalForm, "natural");
  if (!naturalProven) {
    warn(
      "A6.3",
      "natural form did not settle through the candidate channel; see attempts",
    );
  }
}
// `session.tool.input.started` carries the tool name; `session.tool.called` and
// `session.tool.success` only carry the call id (contract §2.3).
const questionCall = toolInputs.find((d) => d?.name === "question");
const questionSuccess = toolSuccess.find((d) => d?.id === questionCall?.id);
check(
  "A6.4",
  Boolean(questionSuccess),
  questionSuccess
    ? `question tool succeeded after the reply (call ${questionSuccess.id})`
    : `question tool success not observed (question call=${questionCall?.id ?? "none"}, failed=${JSON.stringify(toolFailed.map((d) => [d?.id, d?.error?.type]))}, interrupted=${execInterrupted.length}, execFailed=${execFailed.length})`,
);
check(
  "A6.5",
  execSucceeded.length > 0,
  `model turn reached session.execution.succeeded (${execSucceeded.length})`,
);

// ---- rpc candidate (contract-native path) ----------------------------------
console.log("---- rpc candidate ----");
check(
  "A1-RPC.1",
  rpcCandidate?.present === false || rpcResult?.ok === true,
  rpcCandidate?.present === false
    ? "client.rpc.session.form.reply is ABSENT (recorded)"
    : `client.rpc.session.form.reply present and returned ok=${rpcResult?.ok}`,
);

// ---- verdict ---------------------------------------------------------------
console.log("");
console.log(
  `summary: forms=${forms.length} replied=${repliedIDs.size} cancelled=${cancelledIDs.size} execSucceeded=${execSucceeded.length}`,
);
if (controlProven || naturalProven) {
  console.log(
    "VERDICT: form reply channel SUPPORTED — in-process fetch POST /api/session/:sessionID/form/:formID/reply with Basic auth (username `opencode`, password from OPENCODE_SERVER_PASSWORD / OPENCODE_PASSWORD), body {\"answer\":{...}} → 204.",
  );
} else {
  console.log(
    "VERDICT: no supported in-process form reply channel proven by this run (see failures).",
  );
}
console.log(`checks: failures=${failures} warnings=${warnings}`);
process.exit(failures === 0 ? 0 : 1);
