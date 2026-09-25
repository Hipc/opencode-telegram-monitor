/**
 * Ticket 05 supplementary probe plugin — contract §9 open item: subagent
 * lineage / parentID observability in opencode v2.
 *
 * Loaded by opencode v2 auto-discovery from
 * <configDir>/plugin/t05-probe-lineage.ts inside `hipc/opencode2:latest`.
 * Writes raw JSONL evidence to T05_PROBE_LOG (mounted /evidence/probe-lineage.jsonl).
 *
 * What it records:
 *  - probe.setup               : client surface facts, argv, env presence.
 *  - <event type>              : every raw envelope from client.event.subscribe()
 *                                (ALL session.* events included).
 *  - probe.event.parentScan    : any /parent/i key found anywhere in an event's
 *                                data, with its dotted path and value.
 *  - probe.session.probe       : for every session that emits session.created —
 *                                client.session.get result (full + keys + parent
 *                                scan), client.session.context summary (+ parent
 *                                scan), and client.session.list presence.
 *
 * This is diagnostic tooling, not production code: it only observes.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const LOG_FILE = process.env.T05_PROBE_LOG ?? "/evidence/probe-lineage.jsonl";
const PLUGIN_ID = "t05-probe-lineage";
const PARENT_KEY = /parent/i;

let seq = 0;

function record(type: string, payload: unknown): void {
  seq += 1;
  const line = JSON.stringify({
    ts: Date.now(),
    seq,
    plugin: PLUGIN_ID,
    type,
    payload,
  });
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  appendFileSync(LOG_FILE, line + "\n");
}

interface ParentHit {
  path: string;
  value: string;
}

/** Depth-limited walk collecting every key matching /parent/i. */
function scanParentKeys(
  value: unknown,
  path: string,
  out: ParentHit[],
  depth: number,
): void {
  if (depth <= 0 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      scanParentKeys(item, `${path}[${index}]`, out, depth - 1),
    );
    return;
  }
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    const child = path ? `${path}.${key}` : key;
    if (PARENT_KEY.test(key)) {
      out.push({
        path: child,
        value: JSON.stringify(member ?? null).slice(0, 400),
      });
    }
    if (member !== null && typeof member === "object") {
      scanParentKeys(member, child, out, depth - 1);
    }
  }
}

/** Top-level keys of an object (or typeof for non-objects). */
function describeKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return typeof value;
  if (Array.isArray(value)) return `array(${value.length})`;
  return Object.keys(value as Record<string, unknown>);
}

const probed = new Set<string>();

async function probeSession(
  client: Record<string, any>,
  sessionID: string,
  source: string,
): Promise<void> {
  // Give the server a beat to finish persisting the session record.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const entry: Record<string, unknown> = { sessionID, source };

  try {
    const info = await client.session.get({ sessionID });
    entry.getKeys = describeKeys(info);
    entry.get = info;
    const hits: ParentHit[] = [];
    scanParentKeys(info, "session.get", hits, 6);
    entry.getParentScan = hits;
  } catch (error) {
    entry.getError = String(error);
  }

  try {
    const context = await client.session.context({ sessionID });
    const messages = Array.isArray(context) ? context : [];
    entry.contextMessageCount = messages.length;
    entry.contextMessageTypes = messages
      .slice(0, 8)
      .map((message: any) => message?.type);
    const hits: ParentHit[] = [];
    scanParentKeys(messages, "session.context", hits, 8);
    entry.contextParentScan = hits;
  } catch (error) {
    entry.contextError = String(error);
  }

  entry.sessionListType = typeof client.session?.list;
  if (typeof client.session?.list === "function") {
    try {
      const list = await client.session.list({});
      entry.list = describeKeys(list);
    } catch (error) {
      entry.listError = String(error);
    }
  }

  record("probe.session.probe", entry);
}

export default {
  id: PLUGIN_ID,
  async setup(client: Record<string, any>): Promise<() => void> {
    record("probe.setup", {
      pid: process.pid,
      cwd: process.cwd(),
      argv: process.argv.slice(0, 12),
      clientSessionKeys: Object.keys(client.session ?? {}),
      sessionListType: typeof client.session?.list,
      envPresence: {
        OPENCODE_SERVER_PASSWORD:
          typeof process.env.OPENCODE_SERVER_PASSWORD === "string",
        OPENCODE_PASSWORD: typeof process.env.OPENCODE_PASSWORD === "string",
      },
      location: client.location,
    });

    void (async () => {
      try {
        for await (const event of client.event.subscribe()) {
          record(event?.type ?? "unknown", event);
          const hits: ParentHit[] = [];
          scanParentKeys(event?.data, "data", hits, 6);
          if (hits.length > 0) {
            record("probe.event.parentScan", {
              eventType: event?.type,
              hits,
            });
          }
          if (event?.type === "session.created") {
            const sessionID = String(event?.data?.sessionID ?? "");
            if (sessionID && !probed.has(sessionID)) {
              probed.add(sessionID);
              void probeSession(client, sessionID, "session.created").catch(
                (error) =>
                  record("probe.session.probe.error", {
                    sessionID,
                    error: String(error),
                  }),
              );
            }
          }
        }
        record("probe.event-stream.ended", {});
      } catch (error) {
        record("probe.event-stream.error", { error: String(error) });
      }
    })();

    return () => {
      record("probe.dispose", {});
    };
  },
};
