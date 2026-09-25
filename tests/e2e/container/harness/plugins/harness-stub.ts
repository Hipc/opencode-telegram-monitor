/**
 * Harness mechanism-validation double (ticket 05).
 *
 * This is NOT production code and NOT a fallback path: it exists only so the
 * container e2e harness can be validated end-to-end before tickets 03/04 land,
 * and so the assertion suite has a known-good producer for every observable it
 * checks (diag log, projects.json SessionRecords, waiting flow, permission
 * write-back closure, optional form write-back closure).
 *
 * It deliberately mimics the contract's observable behaviour, not the plugin's
 * internals:
 *  - `{id, setup}` default export loaded by <configDir>/plugin/ auto-discovery.
 *  - event subscription via `client.event.subscribe()` (raw v2 envelopes).
 *  - waiting records written to ~/.otg/projects.json with the frozen
 *    SessionRecord shape (same field order as ProjectRegistryStore so the
 *    harness can inject `reply` / `q_answers` with sed exactly like the TG
 *    poller would).
 *  - a 1s reply-scan ticker applying `reply` (permission) via
 *    `client.permission.reply`, and (T05_HARNESS_FORM_REPLY=1) `q_answers`
 *    (question) via the §9/A.1-proven HTTP channel.
 *  - terminal execution events produce a diag line recording the notification
 *    attempt (the adapted plugin's observable when TG sends fail with a
 *    synthetic token).
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME ?? "/tmp/home";
const OTG_DIR = join(HOME, ".otg");
const DIAG_PATH = join(OTG_DIR, "tgdiag.log");
const REGISTRY_PATH = join(OTG_DIR, "projects.json");
const ROOT = process.env.T05_ROOT ?? "/tmp/proj";
const FORM_REPLY_ENABLED = process.env.T05_HARNESS_FORM_REPLY === "1";

const IDLE_DEBOUNCE_MS = 5_000;
const WAITING_DEBOUNCE_MS = 1_000;
const REPLY_SCAN_MS = 1_000;

function dline(message: string): void {
  mkdirSync(OTG_DIR, { recursive: true });
  appendFileSync(
    DIAG_PATH,
    `${new Date().toISOString()} [${process.pid}] ${message}\n`,
  );
}

type SessionRecord = {
  session_id: string;
  session_name: string;
  type: "question" | "permission";
  message: string;
  send: boolean;
  resolved: boolean;
  request_id: string;
  created_at: string;
  reply?: "once" | "always" | "reject" | null;
  q_answers?: string[][];
  q_reject?: boolean;
};

type Registry = {
  projects: Array<{
    path: string;
    enabled: boolean;
    addedAt: string;
    sessions?: SessionRecord[];
  }>;
};

function readRegistry(): Registry {
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.projects)) {
      return parsed as Registry;
    }
  } catch {
    /* missing/corrupt -> empty; the harness seeds a valid file */
  }
  return { projects: [] };
}

function writeRegistry(registry: Registry): void {
  // Same serialization as ProjectRegistryStore: JSON.stringify(reg, null, 2).
  const tmp = `${REGISTRY_PATH}.stub-tmp`;
  mkdirSync(OTG_DIR, { recursive: true });
  writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf8");
  renameSync(tmp, REGISTRY_PATH);
}

function appendRecord(record: SessionRecord): void {
  const registry = readRegistry();
  const entry = registry.projects.find((p) => p.path === ROOT);
  if (!entry) {
    dline(`stub: project not registered, dropping record ${record.request_id}`);
    return;
  }
  entry.sessions = [...(entry.sessions ?? []), record];
  writeRegistry(registry);
}

function removeRecord(requestID: string): void {
  const registry = readRegistry();
  let changed = false;
  for (const entry of registry.projects) {
    if (!entry.sessions) continue;
    const next = entry.sessions.filter((r) => r.request_id !== requestID);
    if (next.length !== entry.sessions.length) {
      entry.sessions = next;
      changed = true;
    }
  }
  if (changed) writeRegistry(registry);
}

function findRecord(requestID: string): SessionRecord | undefined {
  for (const entry of readRegistry().projects) {
    const found = (entry.sessions ?? []).find((r) => r.request_id === requestID);
    if (found) return found;
  }
  return undefined;
}

function registerProject(): void {
  const registry = readRegistry();
  if (!registry.projects.some((p) => p.path === ROOT)) {
    registry.projects.push({ path: ROOT, enabled: true, addedAt: new Date().toISOString() });
    writeRegistry(registry);
  }
}

function basicAuth(password: string): string {
  return "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
}

function serverPortFromArgv(argv: string[]): number | undefined {
  const index = argv.indexOf("--port");
  if (index === -1) return undefined;
  const port = Number(argv[index + 1]);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

/** Map the TG wizard's label answers onto form field values (value ?? label). */
function buildAnswer(
  fields: Array<Record<string, any>>,
  answers: string[][],
): Record<string, unknown> {
  const answer: Record<string, unknown> = {};
  fields.forEach((field, index) => {
    const picked = answers[index] ?? [];
    const values = picked.map((label) => {
      const option = (field.options ?? []).find(
        (o: any) => o.label === label || o.value === label,
      );
      return option ? option.value : label;
    });
    if (field.type === "multiselect") answer[field.key] = values;
    else if (values.length > 0) answer[field.key] = values[0];
  });
  return answer;
}

export default {
  id: "t05-harness-stub",
  async setup(client: Record<string, any>): Promise<() => void> {
    dline("MODULE LOADED");
    dline("initialize() called");
    registerProject();

    const waitingTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const sessionNames = new Map<string, string>();
    let disposed = false;

    // session_name resolution through the v2 client contract (title fallback id)
    void (async () => {
      for await (const event of client.event.subscribe()) {
        if (disposed) break;
        const data = event?.data ?? {};
        if (event?.type === "session.created" && data.sessionID) {
          sessionNames.set(data.sessionID, data.title ?? data.slug ?? data.sessionID);
        }
        if (event?.type === "permission.asked") {
          const requestID = String(data.id);
          // Same observable the adapted plugin logs when it starts tracking the
          // request (assert H3.3 checks for it in tgdiag.log).
          dline(`scheduleWaitingNotify(${requestID}) type=permission`);
          const timer = setTimeout(() => {
            waitingTimers.delete(requestID);
            if (disposed || findRecord(requestID)) return;
            appendRecord({
              session_id: String(data.sessionID),
              session_name: sessionNames.get(data.sessionID) ?? String(data.sessionID),
              type: "permission",
              message: JSON.stringify(data),
              send: false,
              resolved: false,
              request_id: requestID,
              created_at: new Date().toISOString(),
            });
            dline(`stub: permission record persisted ${requestID}`);
          }, WAITING_DEBOUNCE_MS);
          waitingTimers.set(requestID, timer);
        }
        if (event?.type === "permission.replied") {
          const requestID = String(data.requestID);
          const timer = waitingTimers.get(requestID);
          if (timer) {
            clearTimeout(timer);
            waitingTimers.delete(requestID);
          }
          removeRecord(requestID);
          dline(`stub: permission record resolved ${requestID} reply=${data.reply}`);
        }
        if (event?.type === "form.created") {
          const form = data.form ?? {};
          appendRecord({
            session_id: String(form.sessionID ?? data.sessionID),
            session_name: sessionNames.get(form.sessionID) ?? String(form.sessionID ?? ""),
            type: "question",
            message: JSON.stringify({ form }),
            send: false,
            resolved: false,
            request_id: String(form.id),
            created_at: new Date().toISOString(),
          });
          dline(`stub: question record persisted ${form.id}`);
        }
        if (event?.type === "form.replied" || event?.type === "form.cancelled") {
          removeRecord(String(data.id));
          dline(`stub: question record resolved ${data.id}`);
        }
        if (
          event?.type === "session.execution.failed" ||
          event?.type === "session.execution.succeeded" ||
          event?.type === "session.execution.interrupted"
        ) {
          const sessionID = String(data.sessionID);
          setTimeout(() => {
            if (disposed) return;
            // Mechanism double of the adapted plugin's terminal-notification
            // attempt: with a synthetic bot token the TG send fails and the
            // adapted plugin records the failure via dline (contract §3.2).
            dline(`stub: terminal notification attempt failed for ${sessionID} (Telegram rejected the configured bot token)`);
          }, IDLE_DEBOUNCE_MS);
        }
      }
    })().catch((error) => dline(`stub: event stream ended: ${String(error)}`));

    // 1s reply scan, mirroring the relay contract §13.6 / §14 consumer.
    const replyScan = setInterval(() => {
      if (disposed) return;
      const password =
        process.env.OPENCODE_SERVER_PASSWORD ?? process.env.OPENCODE_PASSWORD ?? "";
      const port = serverPortFromArgv(process.argv);
      const entry = readRegistry().projects.find((p) => p.path === ROOT);
      for (const record of entry?.sessions ?? []) {
        if (record.resolved) continue;
        if (record.type === "permission" && record.reply != null) {
          void client.permission
            .reply({
              sessionID: record.session_id,
              requestID: record.request_id,
              decision: record.reply,
            })
            .then(() => {
              removeRecord(record.request_id);
              dline(`stub: permission reply applied ${record.request_id} decision=${record.reply}`);
            })
            .catch((error: unknown) =>
              dline(`stub: permission reply apply failed ${record.request_id}: ${String(error)}`),
            );
          continue;
        }
        if (
          record.type === "question" &&
          FORM_REPLY_ENABLED &&
          Array.isArray(record.q_answers) &&
          port &&
          password
        ) {
          const payload = JSON.parse(record.message) as { form?: Record<string, any> };
          const form = payload.form ?? {};
          const answer = buildAnswer(form.fields ?? [], record.q_answers);
          void fetch(
            `http://127.0.0.1:${port}/api/session/${record.session_id}/form/${record.request_id}/reply`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: basicAuth(password),
              },
              body: JSON.stringify({ answer }),
            },
          )
            .then((response) => {
              if (response.status === 204) {
                removeRecord(record.request_id);
                dline(`stub: form reply applied ${record.request_id}`);
              } else {
                dline(
                  `stub: form reply rejected ${record.request_id} status=${response.status}`,
                );
              }
            })
            .catch((error: unknown) =>
              dline(`stub: form reply apply failed ${record.request_id}: ${String(error)}`),
            );
        }
      }
    }, REPLY_SCAN_MS);

    return () => {
      disposed = true;
      clearInterval(replyScan);
      for (const timer of waitingTimers.values()) clearTimeout(timer);
      waitingTimers.clear();
      dline("stub: dispose");
    };
  },
};
