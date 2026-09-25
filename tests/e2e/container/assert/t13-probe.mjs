#!/usr/bin/env node
// Assertions / summary over the t13-probe container evidence
// (tests/e2e/container/evidence/t13-probe).
//
// The probe reproduces the field topology: TWO opencode servers sharing ONE
// HOME/XDG storage (A = `serve --service` hosts the session; B = plain
// `serve --port`). Both load the t13 probe plugin, which records every event
// per pid. The scenario drives the v2 HTTP API to answer:
//   P1 event delivery: only the host process receives the session's events;
//   P2 form route semantics A (owner) vs B (non-owner), pending vs settled;
//   P3 permission route semantics A vs B;
//   P4 session.get payload diff A vs B (why the t10 gate fails open);
//   P5 multiselect field type round-trip.
//
// Usage: node assert/t13-probe.mjs <evidence-dir>
// Exit code 0 = every probe fact the t13 fix relies on was observed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node assert/t13-probe.mjs <evidence-dir>");
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
function status(name) {
  return readText(`${name}.status`)?.trim();
}

// scenario.txt carries the phase ids (aPid/bPid/sessionID/...).
const scenario = readText("scenario.txt") ?? "";
const value = (key) => new RegExp(`${key}=([^\\s]+)`).exec(scenario)?.[1];
const aPid = Number(value("aPid"));
const bPid = Number(value("bPid"));
const sessionID = value("sessionID");
const form1 = value("form1");
const form2 = value("form2");
const permissionID = value("permissionID");
check(
  "P0.1",
  Boolean(aPid && bPid && sessionID && form1 && form2 && permissionID),
  `phase ids: ${scenario.trim()}`,
);

// P1: event delivery — parse the JSONL per pid and look for the fixture events.
const jsonl = (readText("t13-probe-final.jsonl") ?? "")
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  })
  .filter(Boolean);
const fixtureTypesFor = (pid) =>
  new Set(
    jsonl
      .filter((row) => row.pid === pid && row.type === "probe.event")
      .map((row) => row.payload?.type),
  );
const aEvents = fixtureTypesFor(aPid);
const bEvents = fixtureTypesFor(bPid);
const bMentionsSession = jsonl.some(
  (row) =>
    row.pid === bPid &&
    row.type === "probe.event" &&
    JSON.stringify(row.payload ?? "").includes(sessionID),
);
check(
  "P1.1",
  aEvents.has("session.created") &&
    aEvents.has("form.created") &&
    aEvents.has("permission.asked"),
  `host A received session.created/form.created/permission.asked (${[...aEvents].sort().join(",")})`,
);
check(
  "P1.2",
  !bMentionsSession && bEvents.size === 0,
  `non-host B received no session/form/permission event for A's session (fixture types: ${[...bEvents].join(",") || "none"})`,
);

// P2: form route matrix.
check(
  "P2.1",
  status("p2-get-a-pending") === "200" && status("p2-get-b-pending") === "404",
  `form.get pending: A=${status("p2-get-a-pending")} B=${status("p2-get-b-pending")}`,
);
check(
  "P2.2",
  status("p2-reply-b-pending") === "404" && status("p2-reply-a") === "204",
  `form.reply pending: B=${status("p2-reply-b-pending")} A=${status("p2-reply-a")}`,
);
check(
  "P2.3",
  status("p2-get-a-after-breply") === "200",
  `B's 404 reply did not settle the form (A still 200)`,
);
check(
  "P2.4",
  status("p2-reply-a-again") === "409" && status("p2-reply-b-again") === "404",
  `settled reply: A=${status("p2-reply-a-again")} (FormAlreadySettled) B=${status("p2-reply-b-again")} (FormNotFound)`,
);
check(
  "P2.5",
  status("p2-cancel-b-pending") === "404" &&
    status("p2-cancel-a") === "204" &&
    status("p2-cancel-a-again") === "409",
  `form.cancel: B-pending=${status("p2-cancel-b-pending")} A=${status("p2-cancel-a")} A-again=${status("p2-cancel-a-again")}`,
);
check(
  "P2.6",
  (readText("p2-get-b-pending.json") ?? "").includes("FormNotFoundError") &&
    (readText("p2-reply-a-again.json") ?? "").includes("FormAlreadySettledError"),
  "404 body is FormNotFoundError; 409 body is FormAlreadySettledError",
);

// P3: permission route matrix.
check(
  "P3.1",
  status("p3-perm-get-a-pending") === "200" && status("p3-perm-get-b-pending") === "404",
  `permission.get pending: A=${status("p3-perm-get-a-pending")} B=${status("p3-perm-get-b-pending")}`,
);
check(
  "P3.2",
  status("p3-perm-reply-b-pending") === "404" && status("p3-perm-reply-a") === "204",
  `permission.reply pending: B=${status("p3-perm-reply-b-pending")} A=${status("p3-perm-reply-a")}`,
);
check(
  "P3.3",
  status("p3-perm-get-a-after-breply") === "200" &&
    (readText("p3-perm-reply-b-pending.json") ?? "").includes("PermissionNotFoundError"),
  "B's 404 did not settle the permission; 404 body is PermissionNotFoundError",
);

// P4: session.get payloads identical -> the t10 gate cannot discriminate.
const aSession = readJSON("p4-session-get-a.json");
const bSession = readJSON("p4-session-get-b.json");
check(
  "P4.1",
  JSON.stringify(aSession) === JSON.stringify(bSession) &&
    JSON.stringify(aSession).includes(sessionID),
  "session.get payload is byte-identical from A and B (gate fails open in shared storage)",
);
check(
  "P4.2",
  readText("p4-http-session-a.json") === readText("p4-http-session-b.json"),
  "raw HTTP session.get bodies identical too",
);

// P5: multiselect round-trip.
const multi = readJSON("p5-get-a-multiselect.json");
const multiField = multi?.data?.fields?.[0];
const createdMulti = jsonl.find(
  (row) =>
    row.pid === aPid &&
    row.type === "probe.event" &&
    row.payload?.type === "form.created" &&
    row.payload?.data?.form?.id === form2,
);
check(
  "P5.1",
  multiField?.type === "multiselect" &&
    Array.isArray(multiField?.options) &&
    multiField.options.length === 2,
  `form.get round-trips type=multiselect with options: ${JSON.stringify(multiField)}`,
);
check(
  "P5.2",
  createdMulti?.payload?.data?.form?.fields?.[0]?.type === "multiselect",
  "form.created event carries type=multiselect (wizard multiple mapping is correct)",
);

console.log(
  `\nprobe checks: ${failures === 0 ? "PASSED" : `${failures} FAILED`}`,
);
process.exit(failures === 0 ? 0 : 1);
