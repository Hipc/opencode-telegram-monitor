/**
 * Shared JSONL evidence writer for the opencode v2 probe plugins.
 *
 * Every record is written as one line: {"ts":<epoch ms>,"seq":<n>,"plugin":<id>,"kind":..,"type":..,"payload":..}
 *
 * No error swallowing: if the log file cannot be written the error propagates to
 * the caller (which for probe plugins means the failure shows up in the opencode
 * server log / plugin lifecycle instead of being silently dropped).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const LOG_FILE = process.env.PROBE_LOG_FILE ?? "/evidence/events.jsonl";

let sequence = 0;

export function ensureLogDir(): void {
  mkdirSync(dirname(LOG_FILE), { recursive: true });
}

export function record(pluginId: string, kind: string, type: string, payload: unknown): void {
  sequence += 1;
  const line = JSON.stringify({
    ts: Date.now(),
    seq: sequence,
    plugin: pluginId,
    kind,
    type,
    payload,
  });
  appendFileSync(LOG_FILE, line + "\n");
  console.log(`[v2-probe:${pluginId}] ${kind}/${type} seq=${sequence}`);
}

/**
 * Describes a client object / namespace: top-level keys, and for object members
 * the member names with their typeof (or array/object marker).
 */
export function describeSurface(value: unknown): unknown {
  if (value === null || typeof value !== "object") return typeof value;
  if (Array.isArray(value)) return `array(${value.length})`;
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (member === null || typeof member !== "object") {
      out[key] = typeof member;
      continue;
    }
    if (Array.isArray(member)) {
      out[key] = `array(${member.length})`;
      continue;
    }
    out[key] = Object.fromEntries(
      Object.entries(member as Record<string, unknown>).map(([name, fn]) => [
        name,
        fn === null || typeof fn !== "object" ? typeof fn : Array.isArray(fn) ? `array(${fn.length})` : "object",
      ]),
    );
  }
  return out;
}

/** Short shape summary for potentially large API results: keys + recursive depth-2 types. */
export function shapeOf(value: unknown, depth = 2): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return { array: value.length, first: value.length > 0 && depth > 0 ? shapeOf(value[0], depth - 1) : undefined };
  }
  if (typeof value !== "object") return typeof value;
  if (depth <= 0) return "object";
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    out[key] = shapeOf(member, depth - 1);
  }
  return out;
}
