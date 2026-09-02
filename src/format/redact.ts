import { basename, isAbsolute, relative, resolve } from "node:path";

export type RedactionContext = { root: string; botToken: string };

// File-private coercion helpers (byte-identical to src/format/coerce.ts).
// Kept private here to avoid a coerce <-> redact import cycle: coerce.ts
// depends on safeText/RedactionContext from this module.
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

// 密钥/token 脱敏链（契约 §13.12.1 规则 1-12，safeText 与 safeTextKeepPaths 共用）。
// 规则与顺序冻结：任何改动必须同时保持两导出行为一致。
function redactSecrets(value: string, botToken: string): string {
  return value
    .replace(
      /-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [^-]+-----/gi,
      "[REDACTED_KEY]",
    )
    .replaceAll(botToken, "[REDACTED]")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(
      /\b(?:sk-(?:ant-)?|gh[pousr]_)[A-Za-z0-9_-]{12,}\b/gi,
      "[REDACTED]",
    )
    .replace(/\b(?:github_pat_|npm_|hf_)[A-Za-z0-9_-]{16,}\b/gi, "[REDACTED]")
    .replace(
      /\b(?:glpat-|xox[baprs]-|pypi-)[A-Za-z0-9_-]{12,}\b/gi,
      "[REDACTED]",
    )
    .replace(/\bAIza[A-Za-z0-9_-]{30,}\b/g, "[REDACTED]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      "[REDACTED]",
    )
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(
      /\b[A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|PASSWORD|PASSWD|SECRET|TOKEN|AUTHORIZATION|CREDENTIALS|COOKIE)[A-Z0-9_]*\b\s*[:=]\s*[^\s,;]+/gi,
      "[REDACTED_SECRET]",
    )
    .replace(
      /\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/\S+/gi,
      "[REDACTED_URL]",
    );
}

// 路径类脱敏三条（§13.12.1：仅 safeText 保留；safeTextKeepPaths 跳过）。
// 顺序保持 safeText 原链：40+ 长 blob → root 替换 → 绝对路径正则。
function redactPaths(value: string, root: string): string {
  return value
    .replace(/\b[A-Za-z0-9_+/=-]{40,}\b/g, "[REDACTED_VALUE]")
    .replaceAll(root, "<project>")
    .replace(/(^|[\s=:"'(])\/(?:[^\s/]+\/)*[^\s,;)]*/g, "$1<external-path>");
}

// 空白折叠 + trim + limit 截断（两导出共用，与 safeText 原行为一致）。
function finishText(value: string, limit: number): string {
  const folded = value.replace(/\s+/g, " ").trim();
  return folded.length <= limit
    ? folded
    : `${folded.slice(0, limit - 3)}...`;
}

export function safeText(
  value: string,
  limit: number,
  ctx: RedactionContext,
): string {
  return finishText(
    redactPaths(redactSecrets(value, ctx.botToken), ctx.root),
    limit,
  );
}

// keep-paths 变体（契约 §13.12.1）：密钥/token 脱敏链与 safeText 完全一致，
// 跳过三条路径类规则（root → <project>、绝对路径 → <external-path>、
// 40+ 字符长 blob → [REDACTED_VALUE]），供 permission 详情展示真实路径。
// 空白折叠 / trim / limit 截断与 safeText 一致。
export function safeTextKeepPaths(
  value: string,
  limit: number,
  ctx: RedactionContext,
): string {
  return finishText(redactSecrets(value, ctx.botToken), limit);
}

export function safePath(value: string, ctx: RedactionContext): string {
  const absolute = isAbsolute(value)
    ? resolve(value)
    : resolve(ctx.root, value);
  const projectRelative = relative(ctx.root, absolute);
  if (
    projectRelative &&
    !projectRelative.startsWith("..") &&
    !isAbsolute(projectRelative)
  ) {
    return safeText(projectRelative, 180, ctx);
  }
  if (!projectRelative) return ".";
  return safeText(basename(value), 180, ctx);
}

export function safeToolTarget(
  tool: string,
  input: Record<string, unknown> | undefined,
  ctx: RedactionContext,
): string | undefined {
  if (!input) return undefined;
  const normalized = tool.toLowerCase();

  if (["read", "edit", "write", "glob", "grep"].includes(normalized)) {
    const path =
      string(input.filePath) ??
      string(input.path) ??
      string(input.directory);
    return path ? safePath(path, ctx) : undefined;
  }

  if (["bash", "shell"].includes(normalized)) {
    const command = string(input.command);
    if (!command) return "shell command";
    const words = command.trim().split(/\s+/);
    const executable = words.find((word) => !word.includes("="));
    return executable
      ? `command: ${safeText(basename(executable), 60, ctx)}`
      : "shell command";
  }

  if (normalized === "task") {
    return "subtask";
  }

  return undefined;
}

export function safeProgress(
  structured: Record<string, unknown> | undefined,
  content: unknown,
  ctx: RedactionContext,
): string | undefined {
  if (structured) {
    const status = string(structured.status)?.toLowerCase();
    if (
      status &&
      ["pending", "running", "processing", "completed", "error"].includes(
        status,
      )
    ) {
      return status;
    }
    const percent = number(structured.percent);
    if (percent !== undefined && percent >= 0 && percent <= 100)
      return `${percent}%`;
  }

  if (Array.isArray(content)) {
    const file = content
      .map(record)
      .find((item) => item?.type === "file");
    const name = string(file?.name);
    const uri = string(file?.uri);
    if (name) return `file: ${safePath(name, ctx)}`;
    if (uri?.startsWith("file://")) {
      try {
        return `file: ${safePath(new URL(uri).pathname, ctx)}`;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}