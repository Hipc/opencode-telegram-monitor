#!/usr/bin/env node
// Summary/assertions over the subagent lineage probe evidence
// (tests/e2e/container/evidence/probe-lineage).
//
// The probe answers one question: is parent linkage observable for a child
// session in opencode v2? It has a primary (model-driven `subagent` tool)
// attempt and two deterministic controls (experimental session import with an
// explicit parentID, and session.fork). This script reports the observed facts
// and fails only when the probe machinery itself did not run (no setup, no root
// session, no import control); the lineage verdict itself is informational and
// is written up in probe-lineage/VERDICT.md.
//
// Usage: node assert/probe-lineage.mjs <evidence-dir>
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node assert/probe-lineage.mjs <evidence-dir>");
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
function info(id, detail) {
  console.log(`info ${id}: ${detail}`);
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

// ---- parse the plugin JSONL -------------------------------------------------
const jsonl = (readText("probe-lineage.jsonl") ?? "")
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

const setup = jsonl.find((r) => r.type === "probe.setup");
const createdEvents = jsonl.filter((r) => r.type === "session.created");
const probes = jsonl.filter((r) => r.type === "probe.session.probe");
const parentScans = jsonl.filter((r) => r.type === "probe.event.parentScan");
const forkedEvents = jsonl.filter((r) => r.type === "session.forked");
const childSessions = createdEvents
  .map((r) => r.payload?.data ?? {})
  .filter((d) => d.parentID);

const rootCreated = createdEvents
  .map((r) => r.payload?.data ?? {})
  .find((d) => !d.parentID);

check("L1", Boolean(setup), "probe plugin loaded and recorded probe.setup");
check("L2", Boolean(rootCreated), `root session.created observed (${rootCreated?.sessionID})`);

// ---- plugin stream vs raw SSE ----------------------------------------------
const sseText = readText("sse-raw.txt") ?? "";
const sseCreatedIDs = sseText
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
  .filter((e) => e.type === "session.created")
  .map((e) => e.data?.sessionID);
const pluginCreatedIDs = createdEvents.map((r) => r.payload?.data?.sessionID);
const missingOnPluginStream = sseCreatedIDs.filter(
  (id) => id && !pluginCreatedIDs.includes(id),
);
check(
  "L3",
  missingOnPluginStream.length === 0,
  `plugin stream covers every session.created seen on GET /api/event (missing: ${JSON.stringify(missingOnPluginStream)})`,
);

// ---- deterministic import control ------------------------------------------
const importStatus = (readText("api-import-child.status") ?? "").trim();
const importBody = readJSON("api-import-child.json");
const importID = importBody?.data?.id;
const importChildCreated = createdEvents
  .map((r) => r.payload?.data ?? {})
  .find((d) => d.sessionID === importID);
check(
  "L4",
  importStatus.startsWith("2"),
  `experimental session import accepted (HTTP ${importStatus || "?"})`,
);
check(
  "L5",
  Boolean(importChildCreated?.parentID),
  `imported child session.created carries parentID (${importChildCreated?.parentID ?? "absent"})`,
);
const importProbe = probes.find((r) => r.payload?.sessionID === importID);
const importGetParent = importProbe?.payload?.getParentScan ?? [];
check(
  "L6",
  importGetParent.length > 0,
  `session.get on the imported child exposes parent keys (${JSON.stringify(importGetParent)})`,
);

// ---- server-side list by parentID ------------------------------------------
const listChildren = readJSON("api-list-children.json");
const listedIDs = (listChildren?.data ?? []).map((s) => s.id);
check(
  "L7",
  importID ? listedIDs.includes(importID) : false,
  `GET /api/session?parentID=<root> lists the imported child (${JSON.stringify(listedIDs)})`,
);

// ---- fork control -----------------------------------------------------------
const forkResult = readJSON("api-fork-root.json");
info(
  "L8",
  `fork control: session.forked events=${forkedEvents.length}, fork result id=${forkResult?.data?.id ?? forkResult?.id ?? "n/a"}`,
);

// ---- primary model-driven attempt ------------------------------------------
const modelChild = childSessions.find((d) => d.sessionID !== importID);
if (modelChild) {
  info(
    "L9",
    `model-driven child session observed: ${modelChild.sessionID} parentID=${JSON.stringify(modelChild.parentID)} data=${JSON.stringify(modelChild)}`,
  );
} else {
  info(
    "L9",
    "no model-driven child session observed (prompt #1/#2 did not produce a session.created with a different sessionID)",
  );
}

// ---- parent-key inventory ---------------------------------------------------
const parentKeyPaths = new Set();
for (const scan of parentScans) {
  for (const hit of scan.payload?.hits ?? []) parentKeyPaths.add(`${scan.payload.eventType}:${hit.path}`);
}
for (const probe of probes) {
  for (const hit of probe.payload?.getParentScan ?? [])
    parentKeyPaths.add(`session.get:${hit.path}=${hit.value}`);
  for (const hit of probe.payload?.contextParentScan ?? [])
    parentKeyPaths.add(`session.context:${hit.path}=${hit.value}`);
}
info("L10", `parent-key inventory (${parentKeyPaths.size}): ${JSON.stringify([...parentKeyPaths])}`);

console.log("");
console.log(`checks: failures=${failures} session.created=${createdEvents.length} probes=${probes.length}`);
process.exit(failures === 0 ? 0 : 1);
