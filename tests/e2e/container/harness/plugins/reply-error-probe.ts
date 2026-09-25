/**
 * Harness auxiliary diagnostic double (ticket 05).
 *
 * Captures the exact client-side error shape thrown by
 * `client.permission.reply` on an **already settled** request — the evidence
 * ticket 04's `isNotFoundError` open item needs. It is copied into
 * `<configDir>/plugin/` only when T05_HARNESS_REPLY_ERROR_PROBE=1 (see
 * harness/scenario.sh) and is never part of the canonical green-run, so it
 * cannot affect the plugin under test.
 *
 * Flow: observe permission.asked → wait for permission.replied (the real plugin
 * settled it) → call client.permission.reply again with the same IDs → write the
 * caught error's full introspection to /evidence/reply-error-shape.json.
 *
 * This is diagnostic tooling, not production code.
 */
import { writeFileSync } from "node:fs";

const OUT = process.env.T05_REPLY_ERROR_OUT ?? "/evidence/reply-error-shape.json";

interface Attempted {
  resolved: boolean;
  shape: Record<string, unknown> | null;
}

function describeError(error: unknown): Record<string, unknown> {
  const value = error as Record<string, any>;
  const ownProps: Record<string, unknown> = {};
  let ownKeys: string[] = [];
  try {
    ownKeys = Object.keys(value ?? {});
  } catch {
    ownKeys = [];
  }
  for (const key of ownKeys) {
    let member: unknown;
    try {
      member = value[key];
    } catch {
      member = "<unreadable>";
    }
    ownProps[key] =
      typeof member === "string"
        ? member.slice(0, 300)
        : member !== null && typeof member === "object"
          ? JSON.stringify(member).slice(0, 300)
          : member;
  }
  return {
    typeofError: typeof error,
    isError: error instanceof Error,
    constructorName: value?.constructor?.name ?? null,
    name: value?.name ?? null,
    message: typeof value?.message === "string" ? value.message.slice(0, 500) : null,
    string: String(error).slice(0, 500),
    json: JSON.stringify(error)?.slice(0, 500) ?? null,
    ownKeys,
    ownProps,
    status: value?.status ?? null,
    statusCode: value?.statusCode ?? null,
    tag: value?._tag ?? null,
    stackHead:
      typeof value?.stack === "string"
        ? value.stack.split("\n").slice(0, 3).join("\n").slice(0, 600)
        : null,
  };
}

async function attempt(
  client: Record<string, any>,
  sessionID: string,
  requestID: string,
): Promise<Attempted> {
  try {
    await client.permission.reply({ sessionID, requestID, decision: "once" });
    return { resolved: true, shape: null };
  } catch (error) {
    return { resolved: false, shape: describeError(error) };
  }
}

export default {
  id: "t05-reply-error-probe",
  async setup(client: Record<string, any>): Promise<() => void> {
    const pending = new Map<string, { sessionID: string; action: string }>();
    const attempted = new Set<string>();
    void (async () => {
      for await (const event of client.event.subscribe()) {
        const data = event?.data ?? {};
        if (event?.type === "permission.asked" && data.id) {
          pending.set(String(data.id), {
            sessionID: String(data.sessionID ?? ""),
            action: String(data.action ?? ""),
          });
        }
        if (event?.type === "permission.replied" && data.requestID) {
          const requestID = String(data.requestID);
          const info = pending.get(requestID);
          if (!info || attempted.has(requestID)) continue;
          attempted.add(requestID);
          // Let the server settle the request fully before re-replying.
          await new Promise((resolve) => setTimeout(resolve, 1500));
          const outcome = await attempt(client, info.sessionID, requestID);
          writeFileSync(
            OUT,
            JSON.stringify(
              {
                context:
                  "client.permission.reply on an already-settled request (ticket 04 isNotFoundError evidence)",
                sessionID: info.sessionID,
                requestID,
                action: info.action,
                wireReply: data.reply,
                caught: outcome,
              },
              null,
              2,
            ) + "\n",
          );
        }
      }
    })().catch(() => undefined);
    return () => undefined;
  },
};
