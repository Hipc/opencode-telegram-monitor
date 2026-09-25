/**
 * t13 probe plugin — shared-storage two-server topology (ticket t13, P1/P4/P5).
 *
 * Loaded by BOTH opencode servers in the t13-probe scenario (they share the same
 * HOME/XDG storage, which is the field topology from the incident log: a
 * `serve --service` host and a second plain `serve` process sharing
 * ~/.otg + ~/.local/share/opencode). One JSONL file is appended by both
 * processes; every line carries `pid` so the caller can attribute events.
 *
 * What it records:
 *  - probe.setup : pid, argv, cwd, location, env password presence (values
 *                  never), serverPortFromArgv.
 *  - probe.event : every envelope from client.event.subscribe() — the full
 *                  envelope for session/form/permission families, type-only for
 *                  the rest (keeps the evidence small).
 *  - probe.dispose / probe.event-stream.ended.
 *
 * The probe never replys, never cancels, never touches the registry — the
 * scenario drives all writes through the HTTP API.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const LOG_FILE = process.env.T13_PROBE_LOG ?? "/evidence/t13-probe.jsonl";
const PLUGIN_ID = "t13-probe";

let seq = 0;

function record(type: string, payload: unknown): void {
  seq += 1;
  const line = JSON.stringify({
    ts: Date.now(),
    seq,
    pid: process.pid,
    plugin: PLUGIN_ID,
    type,
    payload,
  });
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  appendFileSync(LOG_FILE, line + "\n");
}

/** Events whose full envelope is worth keeping (P1 attribution). */
const FULL_ENVELOPE = /^(session\.(created|deleted|execution)|form\.|permission\.)/;

function serverPortFromArgv(argv: string[]): number | undefined {
  const index = argv.indexOf("--port");
  if (index === -1 || index + 1 >= argv.length) return undefined;
  const port = Number(argv[index + 1]);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

export default {
  id: PLUGIN_ID,
  async setup(client: Record<string, any>): Promise<() => void> {
    record("probe.setup", {
      pid: process.pid,
      argv: process.argv.slice(0, 10),
      cwd: process.cwd(),
      location: client.location,
      serverPortFromArgv: serverPortFromArgv(process.argv),
      envPresence: {
        OPENCODE_SERVER_PASSWORD:
          typeof process.env.OPENCODE_SERVER_PASSWORD === "string",
        OPENCODE_PASSWORD: typeof process.env.OPENCODE_PASSWORD === "string",
      },
    });

    const stream = client.event.subscribe();
    void (async () => {
      try {
        for await (const event of stream) {
          const type = String(event?.type ?? "unknown");
          if (FULL_ENVELOPE.test(type)) {
            record("probe.event", event);
          } else {
            record("probe.event.type", { type });
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
