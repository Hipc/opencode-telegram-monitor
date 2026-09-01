import { MAX_EVENT_IDS } from "../constants";
import type { ErrorSummary } from "../types";
import type { SessionStatus } from "@opencode-ai/sdk";
import { TelegramApiError } from "../telegram/api-error";
import { safeText, type RedactionContext } from "./redact";

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function rememberBounded(set: Set<string>, value: string): void {
  set.add(value);
  if (set.size <= MAX_EVENT_IDS) return;
  const oldest = set.values().next().value;
  if (oldest) set.delete(oldest);
}

export function status(
  value: unknown,
  ctx: RedactionContext,
): SessionStatus | undefined {
  const status = record(value);
  const type = string(status?.type);
  if (type === "idle" || type === "busy") return { type };
  if (type !== "retry") return undefined;
  return {
    type: "retry",
    attempt: number(status?.attempt) ?? 1,
    message: safeText(
      string(status?.message) ?? "Provider retry",
      120,
      ctx,
    ),
    next: number(status?.next) ?? Date.now(),
  };
}

export function summarizeError(
  value: unknown,
  ctx: RedactionContext,
): ErrorSummary {
  const error = record(value);
  const data = record(error?.data);
  const name =
    string(error?.name) ?? string(error?.type) ?? "OpenCodeError";
  const statusCode = number(data?.statusCode);
  const message =
    name === "APIError"
      ? statusCode
        ? `Provider request failed with HTTP ${statusCode}`
        : "Provider request failed"
      : name === "ProviderAuthError"
        ? "Provider authentication failed"
        : name === "MessageOutputLengthError"
          ? "Model output exceeded its limit"
          : name === "MessageAbortedError"
            ? "Session was cancelled locally"
            : undefined;
  return {
    name: safeText(name, 80, ctx),
    message: message ? safeText(message, 180, ctx) : undefined,
    cancelled:
      name === "MessageAbortedError" || name.toLowerCase().includes("abort"),
  };
}

export function errorCategory(error: unknown, ctx: RedactionContext): string {
  if (error instanceof TelegramApiError) {
    return `TelegramApiError${error.errorCode ? `(${error.errorCode})` : ""}`;
  }
  if (error instanceof Error) return safeText(error.name, 80, ctx);
  return "UnknownError";
}
