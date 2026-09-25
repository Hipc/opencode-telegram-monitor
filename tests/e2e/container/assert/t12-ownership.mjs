#!/usr/bin/env node
// Assertions over the t12 event-ownership container scenario evidence.
//
// Positive mode (default) — multi-root topology in ONE serve process:
//   T12.0 topology + transport actually exercised (both roots activated on the
//         same pid; fake Telegram endpoint reached)
//   T12.1 exactly ONE terminal notification, labelled with A's project, no
//         B-labelled send (the field bug: N notifications, N labels)
//   T12.2 the foreign-root monitor recorded the ownership skip diagnostic
// Negative control (--negative-control, pre-fix bundle) — the field signature:
//   T12N.1 >=2 notifications for the same session
//   T12N.2 at least one carries A's label and one carries B's label
//   T12N.3 no ownership-skip diagnostic exists (pre-fix has no filter)
//
// Usage: node assert/t12-ownership.mjs <evidence-dir> [--negative-control]
// Exit code 0 = all checks passed; 1 = at least one failed.
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const dir = process.argv[2];
const negative = process.argv.includes("--negative-control");
if (!dir) {
  console.error("usage: node assert/t12-ownership.mjs <evidence-dir> [--negative-control]");
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

const SESSION_TITLE = "t12-ownership";
const phase = readJSON("phase-ids.json") ?? {};
const rootA = phase.rootA ?? "/tmp/projA";
const rootB = phase.rootB ?? "/tmp/projB";
const labelA = basename(rootA);
const labelB = basename(rootB);

const tgLog = readJSONL("fake-telegram.jsonl");
const sends = tgLog.filter((entry) => entry.method === "sendRichMessage");
const diag = readText("tgdiag-final.txt") ?? "";
const setupLines = (readText("setup-lines.txt") ?? "").split("\n").filter(Boolean);

// ---- T12.0 topology + transport --------------------------------------------
const setups = setupLines
  .map((line) => /setup\(\) pid=(\d+) root=(.+)$/.exec(line))
  .filter(Boolean)
  .map((m) => ({ pid: m[1], root: m[2] }));
const setupA = setups.find((s) => s.root === rootA);
const setupB = setups.find((s) => s.root === rootB);
check(
  "T12.0.1",
  Boolean(setupA) && Boolean(setupB) && setupA.pid === setupB.pid,
  `both roots activated in ONE process (A=${setupA?.root} pid=${setupA?.pid}, B=${setupB?.root} pid=${setupB?.pid})`,
);
check(
  "T12.0.2",
  tgLog.some((entry) => entry.event === "tls_ok"),
  `plugin completed CONNECT + TLS with the fake endpoint (${tgLog.filter((e) => e.event === "tls_ok").length} tls_ok)`,
);
check(
  "T12.0.3",
  sends.length >= 1,
  `terminal notification reached the fake endpoint (${sends.length} sendRichMessage)`,
);

const htmlOf = (entry) => String(entry.html ?? "");

if (!negative) {
  // ---- T12.1 exactly one, correctly labelled notification -------------------
  check(
    "T12.1.1",
    sends.length === 1,
    `exactly ONE notification for one completion (got ${sends.length})`,
  );
  const notification = sends[0];
  check(
    "T12.1.2",
    Boolean(notification) &&
      htmlOf(notification).includes(labelA) &&
      htmlOf(notification).includes(SESSION_TITLE),
    `notification carries A's project label and the session row (label=${labelA})`,
  );
  check(
    "T12.1.3",
    !sends.some((entry) => htmlOf(entry).includes(labelB)),
    `no notification carries B's project label (${labelB})`,
  );

  // ---- T12.2 foreign-root monitor skipped A's events ------------------------
  check(
    "T12.2.1",
    diag.includes(
      `event skipped: location not owned by this instance directory=${rootA}`,
    ),
    "B logged the ownership skip for A's directory",
  );
  check(
    "T12.2.2",
    !sends.some((entry) => htmlOf(entry).includes(labelB)),
    "no B-labelled terminal notification was attempted",
  );
} else {
  // ---- T12N negative control: the pre-fix field signature -------------------
  const sameSessionSends = sends.filter((entry) =>
    htmlOf(entry).includes(SESSION_TITLE),
  );
  check(
    "T12N.1",
    sameSessionSends.length >= 2,
    `pre-fix: one completion produced several notifications (got ${sameSessionSends.length})`,
  );
  check(
    "T12N.2",
    sameSessionSends.some((entry) => htmlOf(entry).includes(labelA)) &&
      sameSessionSends.some((entry) => htmlOf(entry).includes(labelB)),
    `pre-fix: the same session data is labelled with different projects (${labelA} and ${labelB})`,
  );
  check(
    "T12N.3",
    !diag.includes("event skipped: location not owned by this instance"),
    "pre-fix: no ownership-skip diagnostic exists (no filter)",
  );
}

// ---- summary ----------------------------------------------------------------
console.log("");
console.log(`checks: failures=${failures}`);
process.exit(failures === 0 ? 0 : 1);
