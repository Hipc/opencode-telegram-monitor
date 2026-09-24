/**
 * Ticket 05 supplementary probe plugin — contract §9/A.1 (form reply channel)
 * and §A.6 (natural question flow).
 *
 * Loaded by opencode v2 auto-discovery from <configDir>/plugin/t05-probe-a1.ts
 * inside the `hipc/opencode2:latest` container. It writes raw JSONL evidence to
 * T05_PROBE_LOG (mounted /evidence/probe-a1.jsonl) and never prints secrets.
 *
 * What it records:
 *  - probe.setup        : full client surface incl. deep `rpc` enumeration and a
 *                         recursive search for form/inbox/answer/reply/question
 *                         members; process.argv; env key names (values never);
 *                         server password env presence; service config hints.
 *  - <event type>       : every raw envelope from client.event.subscribe().
 *  - probe.reply.*      : candidate-channel reply attempts against the first
 *                         form.created (HTTP matrix + optional rpc path).
 *
 * Reply candidate matrix (T05_PROBE_REPLY=1), ordered so that only the last
 * attempt can settle the form:
 *   1. HTTP without Authorization            (control, expect 401)
 *   2. HTTP with `Authorization: Bearer ...` (control, expect 401)
 *   3. HTTP with Basic auth (`opencode:<password>`) — the candidate channel
 *   4. `client.rpc.session.form.reply` if such a member exists (recorded as
 *      absent otherwise)
 * After each attempt the raw status/body is recorded; whether the form actually
 * settled is decided from the subsequent form.replied/form.cancelled event and
 * the question tool outcome, both captured by the event loop.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const LOG_FILE = process.env.T05_PROBE_LOG ?? "/evidence/probe-a1.jsonl";
const PLUGIN_ID = "t05-probe-a1";
const REPLY_MODE = process.env.T05_PROBE_REPLY === "1";

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

/** Top-level keys + per-namespace member names with typeof. */
function describeSurface(value: unknown): unknown {
  if (value === null || typeof value !== "object") return typeof value;
  if (Array.isArray(value)) return `array(${value.length})`;
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (member === null || typeof member !== "object") {
      out[key] = typeof member;
      continue;
    }
    out[key] = Object.fromEntries(
      Object.entries(member as Record<string, unknown>).map(([name, fn]) => [
        name,
        fn === null || typeof fn !== "object"
          ? typeof fn
          : Array.isArray(fn)
            ? `array(${fn.length})`
            : "object",
      ]),
    );
  }
  return out;
}

/**
 * Recursive member walk of a namespace (depth-limited) so that function-valued
 * namespaces (e.g. `rpc`, an Object.assign of a callable + methods) are fully
 * enumerated. Returns a map of dotted path -> typeof, plus paths matching the
 * form/inbox/answer/reply/question interest filter.
 */
function walkMembers(
  value: unknown,
  prefix: string,
  depth: number,
  out: Record<string, string>,
): void {
  if (value === null || (typeof value !== "object" && typeof value !== "function"))
    return;
  if (depth <= 0) return;
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return;
  }
  for (const key of keys) {
    let member: unknown;
    try {
      member = (value as Record<string, unknown>)[key];
    } catch {
      continue;
    }
    const path = prefix ? `${prefix}.${key}` : key;
    out[path] = typeof member;
    if (typeof member === "function") {
      for (const prop of Object.keys(member)) out[`${path}.${prop}`] = "fn-prop";
    }
    if (member !== null && typeof member === "object") {
      walkMembers(member, path, depth - 1, out);
    }
  }
}

const INTEREST = /form|inbox|answer|reply|question|permission/i;

function findInterestPaths(paths: Record<string, string>): string[] {
  return Object.keys(paths)
    .filter((path) => INTEREST.test(path))
    .sort();
}

/** Parse `--port N` out of process.argv (serve mode). */
function serverPortFromArgv(argv: string[]): number | undefined {
  const index = argv.indexOf("--port");
  if (index === -1 || index + 1 >= argv.length) return undefined;
  const port = Number(argv[index + 1]);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

function basicAuth(username: string, password: string): string {
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

function buildAnswer(fields: Array<Record<string, any>>): Record<string, unknown> {
  const answer: Record<string, unknown> = {};
  for (const field of fields) {
    const key = String(field?.key ?? "");
    if (!key) continue;
    if (Array.isArray(field.options) && field.options.length > 0) {
      answer[key] =
        field.type === "multiselect"
          ? [field.options[0]?.value]
          : field.options[0]?.value;
    } else if (field.default !== undefined) {
      answer[key] = field.default;
    } else if (field.type === "boolean") {
      answer[key] = true;
    } else if (field.type === "number" || field.type === "integer") {
      answer[key] = 1;
    } else if (field.type === "multiselect") {
      answer[key] = [];
    } else {
      answer[key] = "t05-e2e-answer";
    }
  }
  return answer;
}

async function httpAttempt(
  label: string,
  base: string,
  sessionID: string,
  formID: string,
  headers: Record<string, string>,
  answer: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = `${base}/api/session/${sessionID}/form/${formID}/reply`;
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ answer }),
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    return {
      attempt: label,
      formID,
      url,
      auth: headers.authorization ? headers.authorization.replace(/Basic .*/, "Basic <redacted>").replace(/Bearer .*/, "Bearer <redacted>") : "none",
      status: response.status,
      body: text.slice(0, 500),
      ms: Date.now() - started,
    };
  } catch (error) {
    return {
      attempt: label,
      formID,
      url,
      status: "threw",
      error: String(error),
      ms: Date.now() - started,
    };
  }
}

const repliedFormIDs = new Set<string>();
let replyChain: Promise<void> = Promise.resolve();

export default {
  id: PLUGIN_ID,
  async setup(client: Record<string, any>): Promise<() => void> {
    const argv = process.argv.slice(0, 10);
    const envKeys = Object.keys(process.env)
      .filter((key) => /OPENCODE|SERVER|PORT|PASSWORD/i.test(key))
      .sort();
    const rpcPaths: Record<string, string> = {};
    if (client.rpc !== undefined) walkMembers(client.rpc, "rpc", 3, rpcPaths);

    record("probe.setup", {
      pid: process.pid,
      cwd: process.cwd(),
      argv,
      clientKeys: Object.keys(client),
      clientSurface: describeSurface(client),
      rpcPaths,
      rpcInterestPaths: findInterestPaths(rpcPaths),
      sessionInterestPaths: findInterestPaths(
        Object.fromEntries(
          Object.keys(client.session ?? {}).map((key) => [
            `session.${key}`,
            typeof client.session[key],
          ]),
        ),
      ),
      envKeys,
      envPresence: {
        OPENCODE_SERVER_PASSWORD: typeof process.env.OPENCODE_SERVER_PASSWORD === "string",
        OPENCODE_PASSWORD: typeof process.env.OPENCODE_PASSWORD === "string",
      },
      serverPortFromArgv: serverPortFromArgv(argv),
      replyMode: REPLY_MODE,
      app: client.app,
      location: client.location,
    });

    const stream = client.event.subscribe();
    void (async () => {
      try {
        for await (const event of stream) {
          record(event?.type ?? "unknown", event);
          if (
            REPLY_MODE &&
            event?.type === "form.created" &&
            !repliedFormIDs.has(String(event?.data?.form?.id ?? ""))
          ) {
            const formID = String(event?.data?.form?.id ?? "");
            repliedFormIDs.add(formID);
            replyChain = replyChain
              .then(() => probeFormReply(client, event.data.form, argv))
              .catch((error) => record("probe.reply.chain.error", { formID, error: String(error) }));
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

async function probeFormReply(
  client: Record<string, any>,
  form: Record<string, any>,
  argv: string[],
): Promise<void> {
  const sessionID = String(form?.sessionID ?? "");
  const formID = String(form?.id ?? "");
  const answer = buildAnswer(Array.isArray(form?.fields) ? form.fields : []);
  const port = serverPortFromArgv(argv);
  const password =
    process.env.OPENCODE_SERVER_PASSWORD ?? process.env.OPENCODE_PASSWORD ?? "";
  const base = port ? `http://127.0.0.1:${port}` : undefined;

  record("probe.reply.start", {
    sessionID,
    formID,
    formTitle: form?.title,
    formMetadata: form?.metadata,
    fieldKeys: (form?.fields ?? []).map((f: any) => ({ key: f.key, type: f.type })),
    answer,
    base,
    passwordPresent: password.length > 0,
  });

  // Candidate 0: contract-native rpc member, if the surface exposes one.
  const rpcReply = client?.rpc?.session?.form?.reply;
  record("probe.reply.rpc.candidate", {
    path: "client.rpc.session.form.reply",
    present: typeof rpcReply === "function",
  });
  if (typeof rpcReply === "function") {
    try {
      const result = await rpcReply.call(client.rpc.session.form, {
        sessionID,
        formID,
        answer,
      });
      record("probe.reply.rpc.result", { ok: true, result: JSON.stringify(result ?? null).slice(0, 300) });
    } catch (error) {
      record("probe.reply.rpc.result", { ok: false, error: String(error) });
    }
  }

  if (!base) {
    record("probe.reply.http.skipped", { reason: "no --port in process.argv" });
    return;
  }

  // Control attempts first: they must not settle the form.
  const noAuth = await httpAttempt("no-auth", base, sessionID, formID, {}, answer);
  record("probe.reply.http.attempt", noAuth);
  const bearer = await httpAttempt(
    "bearer",
    base,
    sessionID,
    formID,
    { authorization: `Bearer ${password}` },
    answer,
  );
  record("probe.reply.http.attempt", bearer);
  // Candidate channel: Basic auth with the serve password.
  const basic = await httpAttempt(
    "basic",
    base,
    sessionID,
    formID,
    { authorization: basicAuth("opencode", password) },
    answer,
  );
  record("probe.reply.http.attempt", basic);
  record("probe.reply.done", {
    formID,
    statuses: { noAuth: noAuth.status, bearer: bearer.status, basic: basic.status },
  });
}
