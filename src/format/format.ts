import { basename } from "node:path";
import type { QuestionV2Info, Session, Todo } from "@opencode-ai/sdk";

import {
  ICON_CANCELLED,
  ICON_COMPLETED,
  ICON_FAILED,
  ICON_HELP,
  ICON_IDLE,
  ICON_PERMISSION,
  ICON_QUESTION,
  ICON_RETRYING,
  ICON_RUNNING,
  ICON_TODO,
  ICON_USAGE,
  ICON_WAITING,
  MENU_MAX_PROJECTS,
  TELEGRAM_MESSAGE_LIMIT,
} from "../constants";
import { entryToken, type ProjectRegistry } from "../registry";
import type {
  ErrorSummary,
  SessionDisplayState,
  SessionOutcome,
  SessionProjection,
  TelegramInlineButton,
  TelegramInlineKeyboard,
  TokenTotals,
  TodoCounts,
  TokensSummary,
  WaitingType,
} from "../types";
import { safeText, safeTextKeepPaths, type RedactionContext } from "./redact";
import {
  escapeHtml,
  fieldRow,
  fieldTable,
  paragraph,
  titleLine,
} from "./html";

export type FormatContext = RedactionContext & {
  projectLabel: string;
  sessions: Map<string, SessionProjection>;
  sessionInfo: Map<string, Session>;
};

export function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function formatCost(tokens: TokenTotals): string {
  if (!tokens.hasCost) return "N/A";
  if (tokens.cost >= 1) return `$${tokens.cost.toFixed(2)}`;
  if (tokens.cost >= 0.01) return `$${tokens.cost.toFixed(3)}`;
  return `$${tokens.cost.toFixed(4)}`;
}

export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function shortID(sessionID: string): string {
  const normalized = sessionID.startsWith("ses_")
    ? sessionID.slice(4)
    : sessionID;
  return normalized.slice(0, 8);
}

export function matchesSessionID(sessionID: string, candidate: string): boolean {
  const normalizedCandidate = candidate.trim().toLowerCase();
  const normalizedID = sessionID.toLowerCase();
  const withoutPrefix = normalizedID.startsWith("ses_")
    ? normalizedID.slice(4)
    : normalizedID;
  return (
    normalizedID === normalizedCandidate ||
    normalizedID.startsWith(normalizedCandidate) ||
    withoutPrefix.startsWith(normalizedCandidate)
  );
}

export function limitMessage(text: string): string {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) return text;
  // Reserve room for the truncation marker.
  const RESERVED = "\n... truncated".length;
  const cut = TELEGRAM_MESSAGE_LIMIT - RESERVED;
  let truncated = text.slice(0, cut);
  // Back up to the previous tag boundary if we sliced mid-tag so we never
  // leave a half-written <table>/<tr>/<td>/<b>... that would break parsing.
  const lt = truncated.lastIndexOf("<");
  const gt = truncated.lastIndexOf(">");
  if (lt > gt) truncated = truncated.slice(0, lt);
  truncated += "\n... truncated";
  // Close any block/formatting tags left open by the cut so the rich HTML
  // parser does not reject the message.
  const openClose: Array<[RegExp, string, string]> = [
    [/<table>/g, /<\/table>/g, "</table>"],
    [/<tr>/g, /<\/tr>/g, "</tr>"],
    [/<td>/g, /<\/td>/g, "</td>"],
    [/<th>/g, /<\/th>/g, "</th>"],
    [/<ul>/g, /<\/ul>/g, "</ul>"],
    [/<li>/g, /<\/li>/g, "</li>"],
    [/<p>/g, /<\/p>/g, "</p>"],
    [/<code>/g, /<\/code>/g, "</code>"],
    [/<b>/g, /<\/b>/g, "</b>"],
  ];
  for (const [openRe, closeRe, closeTag] of openClose) {
    const opens = (truncated.match(openRe) ?? []).length;
    const closes = (truncated.match(closeRe) ?? []).length;
    if (opens > closes) truncated += closeTag.repeat(opens - closes);
  }
  return truncated;
}

export function todoCounts(todos: Todo[]): TodoCounts {
  return {
    inProgress: todos.filter((todo) => todo.status === "in_progress").length,
    pending: todos.filter((todo) => todo.status === "pending").length,
    completed: todos.filter((todo) => todo.status === "completed").length,
    cancelled: todos.filter((todo) => todo.status === "cancelled").length,
    total: todos.length,
  };
}

export function todoSummary(counts: TodoCounts): string {
  if (counts.total === 0) return "none reported";
  return `${counts.completed}/${counts.total} completed, ${counts.inProgress} in progress, ${counts.pending} pending, ${counts.cancelled} cancelled`;
}

export function totalTokens(tokens: TokenTotals): number {
  return (
    tokens.input +
    tokens.output +
    tokens.reasoning +
    tokens.cacheRead +
    tokens.cacheWrite
  );
}

export function emptyTokens(): TokenTotals {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    hasCost: false,
  };
}

export function displayState(session: SessionProjection): SessionDisplayState {
  if (session.waitingByRequestID.size > 0) return "waiting";
  if (session.status === "busy") return "running";
  if (session.status === "retry") return "retrying";
  return session.outcome ?? "idle";
}

export function sessionTitle(
  session: SessionProjection,
  ctx: RedactionContext,
): string {
  return safeText(session.info?.title ?? "Untitled session", 100, ctx);
}

export function sessionLabel(
  session: SessionProjection,
  ctx: RedactionContext,
): string {
  return `${sessionTitle(session, ctx)} | ${shortID(session.sessionID)}`;
}

export function iconForOutcome(outcome: SessionOutcome): string {
  switch (outcome) {
    case "completed":
      return ICON_COMPLETED;
    case "failed":
      return ICON_FAILED;
    case "cancelled":
      return ICON_CANCELLED;
  }
}

export function iconForState(state: SessionDisplayState): string {
  switch (state) {
    case "running":
      return ICON_RUNNING;
    case "retrying":
      return ICON_RETRYING;
    case "waiting":
      return ICON_WAITING;
    case "completed":
      return ICON_COMPLETED;
    case "failed":
      return ICON_FAILED;
    case "cancelled":
      return ICON_CANCELLED;
    case "idle":
      return ICON_IDLE;
  }
}

export function iconForWaitingType(type: WaitingType): string {
  return type === "permission" ? ICON_PERMISSION : ICON_QUESTION;
}

export function childSessions(
  parentID: string,
  sessions: Map<string, SessionProjection>,
  sessionInfo: Map<string, Session>,
): SessionProjection[] {
  return [...sessions.values()].filter((candidate) => {
    let current = candidate.info?.parentID;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      if (current === parentID) return true;
      seen.add(current);
      current = sessionInfo.get(current)?.parentID;
    }
    return false;
  });
}

export function aggregateTokens(
  session: SessionProjection,
  ctx: FormatContext,
): TokensSummary {
  const totals = emptyTokens();
  for (const item of [
    session,
    ...childSessions(session.sessionID, ctx.sessions, ctx.sessionInfo),
  ]) {
    totals.input += item.tokens.input;
    totals.output += item.tokens.output;
    totals.reasoning += item.tokens.reasoning;
    totals.cacheRead += item.tokens.cacheRead;
    totals.cacheWrite += item.tokens.cacheWrite;
    totals.cost += item.tokens.cost;
    totals.hasCost = totals.hasCost || item.tokens.hasCost;
  }
  return totals;
}

export function menuText(): string {
  // 项目列表已由下方按钮区域承载，文字部分只保留标题。
  return paragraph("📋 项目监控列表");
}

export function buildMenuKeyboard(
  registry: ProjectRegistry,
): TelegramInlineKeyboard {
  const rows: TelegramInlineButton[][] = [];
  for (
    let i = 0;
    i < Math.min(registry.projects.length, MENU_MAX_PROJECTS);
    i += 1
  ) {
    const entry = registry.projects[i]!;
    // callback_data 用路径 token（稳定标识）而非位置序号，避免多实例并发下
    // 列表变化导致删错/切错项目；同时携带目标状态实现幂等。
    const token = entryToken(entry.path);
    const target = entry.enabled ? 0 : 1;
    rows.push([
      {
        text: `${entry.enabled ? "✅" : "⚪"} ${basename(entry.path)}`,
        callback_data: `otg:set:${token}:${target}`,
      },
      { text: "🗑", callback_data: `otg:del:${token}` },
    ]);
  }
  rows.push([{ text: "🔄 刷新", callback_data: "otg:refresh" }]);
  return { inline_keyboard: rows };
}

// 契约 sessions-relay.md §13.4：callback_data 前缀沿用 otg: 风格；放 format.ts
// （constants.ts 本轮零新增，决策 #9）。
export const PERM_CB_PREFIX = "otg:perm:";

// 契约 sessions-relay.md §14.2.1：question 向导 callback_data 前缀，与
// PERM_CB_PREFIX 同款（constants.ts 保持零新增，决策 #9）。
export const OTG_Q_CB_PREFIX = "otg:q:";

/**
 * permission 记录的 TG 三按钮键盘（契约 sessions-relay.md §13.3，Round 2）：
 * 一行三按钮 Allow once / Allow always / Deny，callback_data
 * `otg:perm:<entryID>:<once|always|reject>`。entryID 由调用方（monitor）
 * 保证每个 callback_data ≤ 64 字节（契约 §13.4 缩短方案）；本函数为纯函数，
 * 不做长度断言。只加在 type === "permission" 记录；question 记录无键盘。
 */
export function buildSessionPermissionKeyboard(
  entryID: string,
): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: "Allow once", callback_data: `${PERM_CB_PREFIX}${entryID}:once` },
        {
          text: "Allow always",
          callback_data: `${PERM_CB_PREFIX}${entryID}:always`,
        },
        { text: "Deny", callback_data: `${PERM_CB_PREFIX}${entryID}:reject` },
      ],
    ],
  };
}

/**
 * question 向导单阶段文本渲染（契约 sessions-relay.md §14.2.1，Round 4）：
 * titleLine(❓, projectLabel) + **单张** fieldTable（Type/Session/Question m/n/
 * Header/选项行同表），整体经 limitMessage 截断。问题/选项/Header 文本值经
 * safeTextKeepPaths（密钥/token 脱敏链同 safeText，跳过路径类规则——问题文本
 * 含真实路径时原样展示）。纯函数，供 scanSessionQueue（初始消息）与回调状态机
 * （阶段编辑，Phase 1.3）复用。
 */
export function buildQuestionStageText(
  projectLabel: string,
  type: "question",
  sessionLabel: string,
  questions: Array<QuestionV2Info>,
  stage: number,
  draft: Array<Array<string>>,
  inputPending: boolean,
  ctx: FormatContext,
): string {
  const rows = [
    fieldRow("Type", type),
    fieldRow("Session", sessionLabel),
  ];
  if (stage < questions.length) {
    const current = questions[stage];
    if (current) {
      const m = stage + 1;
      const n = questions.length;
      rows.push(
        fieldRow(
          `Question ${m}/${n}`,
          safeTextKeepPaths(current.question ?? "", 300, ctx),
        ),
      );
      if (typeof current.header === "string") {
        rows.push(
          fieldRow("Header", safeTextKeepPaths(current.header, 300, ctx)),
        );
      }
      const options = Array.isArray(current.options) ? current.options : [];
      options.forEach((option, index) => {
        if (typeof option?.label !== "string") return;
        const multiple = current.multiple === true;
        const selected = (draft[stage] ?? []).includes(option.label);
        const label = safeTextKeepPaths(option.label, 200, ctx);
        const description =
          typeof option?.description === "string"
            ? safeTextKeepPaths(option.description, 200, ctx)
            : "";
        // 多选且该选项已选 → 值前缀 `✅ `（契约 §14.2.1 行序冻结）。
        const prefix = multiple && selected ? "✅ " : "";
        rows.push(
          fieldRow(
            `Option ${index + 1}`,
            description ? `${prefix}${label} — ${description}` : `${prefix}${label}`,
          ),
        );
      });
      if (inputPending) {
        rows.push(fieldRow("输入", "✏️ 回复文本作为答案，/cancel 取消"));
      }
    }
  } else {
    // 总结阶段：每题一行 Question m/n → 已选答案或（未答）标注。
    questions.forEach((question, index) => {
      const answers = draft[index] ?? [];
      const value =
        answers.length > 0
          ? safeTextKeepPaths(answers.join("、"), 300, ctx)
          : "（未答）";
      rows.push(
        fieldRow(`Question ${index + 1}/${questions.length}`, value),
      );
    });
  }
  return limitMessage(
    [
      titleLine(iconForWaitingType(type), projectLabel),
      fieldTable(rows),
    ].join("\n"),
  );
}

/**
 * question 向导键盘（契约 sessions-relay.md §14.2.1，Round 4）：行序冻结——
 * 1) 选项行（`questions[stage].options` 逐项平铺，data `otg:q:<entryID>:o<idx>`；
 * 多选且已选 → `✅ label`）；2) custom 行（仅 `custom === true`）；3) 导航/提交行
 * （多问题：非总结 `⬅️ Prev/➡️ Next/❌ Cancel`，总结 `✅ Submit/❌ Cancel`；
 * **单问题单选：无导航无提交**，只有选项行（+custom 若有）+ `❌ Cancel`（点选项
 * 直接提交形态）；**单问题多选（multiple:true）：选项 toggle + `✅ Submit` +
 * `❌ Cancel`**——否则 toggle 后无提交路径（契约 §14.2.1 修订，Phase 1.5）。
 * entryID 由调用方（monitor）保证回调 ASCII 且 ≤ 64 字节（契约 §14.2.3）；
 * 本函数纯函数，不做长度断言（同 §13.3）。
 */
export function buildQuestionKeyboard(
  entryID: string,
  questions: Array<QuestionV2Info>,
  stage: number,
  draft: Array<Array<string>>,
): TelegramInlineKeyboard {
  const rows: TelegramInlineButton[][] = [];
  const current = questions[stage];
  if (current) {
    const options = Array.isArray(current.options) ? current.options : [];
    if (options.length > 0) {
      const selected = draft[stage] ?? [];
      const multiple = current.multiple === true;
      rows.push(
        options.map((option, idx) => ({
          text:
            multiple && selected.includes(option.label)
              ? `✅ ${option.label}`
              : option.label,
          callback_data: `${OTG_Q_CB_PREFIX}${entryID}:o${idx}`,
        })),
      );
    }
    if (current.custom === true) {
      rows.push([
        {
          text: "✏️ Custom",
          callback_data: `${OTG_Q_CB_PREFIX}${entryID}:custom`,
        },
      ]);
    }
  }
  if (questions.length > 1) {
    if (stage === questions.length) {
      rows.push([
        {
          text: "✅ Submit",
          callback_data: `${OTG_Q_CB_PREFIX}${entryID}:submit`,
        },
        {
          text: "❌ Cancel",
          callback_data: `${OTG_Q_CB_PREFIX}${entryID}:cancel`,
        },
      ]);
    } else {
      rows.push([
        {
          text: "⬅️ Prev",
          callback_data: `${OTG_Q_CB_PREFIX}${entryID}:prev`,
        },
        {
          text: "➡️ Next",
          callback_data: `${OTG_Q_CB_PREFIX}${entryID}:next`,
        },
        {
          text: "❌ Cancel",
          callback_data: `${OTG_Q_CB_PREFIX}${entryID}:cancel`,
        },
      ]);
    }
  } else if (current?.multiple === true) {
    // 单问题多选：toggle 形态需要显式提交路径（Phase 1.5 死角修复）。
    rows.push([
      {
        text: "✅ Submit",
        callback_data: `${OTG_Q_CB_PREFIX}${entryID}:submit`,
      },
      {
        text: "❌ Cancel",
        callback_data: `${OTG_Q_CB_PREFIX}${entryID}:cancel`,
      },
    ]);
  } else {
    // 单问题单选：点选项直接提交形态，仅 Cancel。
    rows.push([
      {
        text: "❌ Cancel",
        callback_data: `${OTG_Q_CB_PREFIX}${entryID}:cancel`,
      },
    ]);
  }
  return { inline_keyboard: rows };
}

export function helpText(): string {
  const commands = [
    "/menu - Manage monitored projects",
    "/help - Show this help",
  ];
  const planned = [
    "/start - Check the plugin connection",
    "/sessions - List active sessions",
    "/use <short-id> - Select a session",
    "/status - Show selected session status",
    "/todo - Show selected session todos",
    "/usage - Show selected session token usage and cost",
  ];
  const listItems = commands
    .map((command) => `<li>${escapeHtml(command)}</li>`)
    .join("");
  const plannedItems = planned
    .map((command) => `<li>${escapeHtml(command)}</li>`)
    .join("");
  return [
    `<p>${ICON_HELP} Commands:</p>`,
    `<ul>${listItems}</ul>`,
    "<p>Planned (not available yet):</p>",
    `<ul>${plannedItems}</ul>`,
    "<p>Read-only by default: since 2026-09-02 permission prompts can be answered with inline buttons (Allow once / Allow always / Deny) — only when you explicitly tap one. Questions and everything else are always handled in OpenCode.</p>",
  ].join("\n");
}

export function formatStatus(
  session: SessionProjection,
  ctx: FormatContext,
): string {
  const currentTool = [...session.toolsByCallID.values()]
    .filter((tool) => tool.state === "pending" || tool.state === "running")
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  const todo = todoCounts(session.todos);
  const rows = [
    fieldRow("Session", sessionLabel(session, ctx)),
  ];

  if (session.agent) rows.push(fieldRow("Agent", session.agent));
  if (currentTool) {
    rows.push(fieldRow("Current tool", safeText(currentTool.tool, 80, ctx)));
    if (currentTool.target) rows.push(fieldRow("Target", currentTool.target));
    rows.push(fieldRow("Tool state", currentTool.state));
    if (currentTool.progress)
      rows.push(fieldRow("Progress", currentTool.progress));
  }
  rows.push(fieldRow("Todo", todoSummary(todo)));
  if (session.turnStartedAt && session.status !== "idle") {
    rows.push(
      fieldRow(
        "Elapsed",
        formatDuration(Date.now() - session.turnStartedAt),
      ),
    );
  }

  const parts = [
    titleLine(iconForState(displayState(session)), ctx.projectLabel),
    fieldTable(rows),
  ];

  const children = childSessions(
    session.sessionID,
    ctx.sessions,
    ctx.sessionInfo,
  );
  const activeChildren = children.filter(
    (child) => child.status !== "idle" || child.waitingByRequestID.size > 0,
  );
  if (activeChildren.length > 0) {
    const listItems = activeChildren
      .slice(0, 5)
      .map((child) => {
        const tool = [...child.toolsByCallID.values()]
          .filter(
            (item) => item.state === "pending" || item.state === "running",
          )
          .sort((left, right) => right.updatedAt - left.updatedAt)[0];
        return `<li>${escapeHtml(sessionTitle(child, ctx))} | ${displayState(child)}${tool ? ` | ${escapeHtml(tool.tool)}` : ""}</li>`;
      })
      .join("");
    parts.push(paragraph("Active subtasks:"));
    parts.push(`<ul>${listItems}</ul>`);
    if (activeChildren.length > 5) {
      parts.push(paragraph(`... and ${activeChildren.length - 5} more`));
    }
  }

  return limitMessage(parts.join("\n"));
}

export function formatTerminalNotification(
  session: SessionProjection,
  outcome: SessionOutcome,
  error: ErrorSummary | undefined,
  ctx: FormatContext,
): string {
  const todo = todoCounts(session.todos);
  const rows = [
    fieldRow("Session", sessionLabel(session, ctx)),
  ];
  if (session.turnStartedAt) {
    rows.push(
      fieldRow(
        "Duration",
        formatDuration(Date.now() - session.turnStartedAt),
      ),
    );
  }
  if (error && outcome === "failed") {
    rows.push(
      fieldRow(
        "Error",
        error.message ? `${error.name}: ${error.message}` : error.name,
      ),
    );
  }
  rows.push(fieldRow("Todo", todoSummary(todo)));

  const children = childSessions(
    session.sessionID,
    ctx.sessions,
    ctx.sessionInfo,
  );
  if (children.length > 0) {
    const completed = children.filter(
      (child) => child.outcome === "completed",
    ).length;
    const failed = children.filter(
      (child) => child.outcome === "failed",
    ).length;
    const cancelled = children.filter(
      (child) => child.outcome === "cancelled",
    ).length;
    const active = children.filter(
      (child) => child.status !== "idle" || child.observedRunning,
    ).length;
    rows.push(
      fieldRow(
        "Subtasks",
        `${completed} completed, ${failed} failed, ${cancelled} cancelled, ${active} active`,
      ),
    );
  }

  const tokens = aggregateTokens(session, ctx);
  rows.push(fieldRow("Tokens", formatNumber(totalTokens(tokens))));
  rows.push(fieldRow("Input", formatNumber(tokens.input)));
  rows.push(fieldRow("Output", formatNumber(tokens.output)));
  rows.push(
    fieldRow(
      "Cache",
      formatNumber(tokens.cacheRead + tokens.cacheWrite),
    ),
  );
  rows.push(fieldRow("Cost", formatCost(tokens)));
  return limitMessage(
    [
      titleLine(iconForOutcome(outcome), ctx.projectLabel),
      fieldTable(rows),
    ].join("\n"),
  );
}

export function formatTodos(
  session: SessionProjection,
  ctx: FormatContext,
): string {
  const groups = [
    "in_progress",
    "pending",
    "completed",
    "cancelled",
  ] as const;
  const labels: Record<(typeof groups)[number], string> = {
    in_progress: "IN PROGRESS",
    pending: "PENDING",
    completed: "COMPLETED",
    cancelled: "CANCELLED",
  };
  const table = fieldTable([
    fieldRow("Session", sessionLabel(session, ctx)),
  ]);
  const title = titleLine(ICON_TODO, ctx.projectLabel);

  if (session.todos.length === 0) {
    return limitMessage(
      [title, table, paragraph("No todos reported.")].join("\n"),
    );
  }

  const parts = [title, table];
  let shown = 0;
  for (const group of groups) {
    const todos = session.todos.filter((todo) => todo.status === group);
    if (todos.length === 0) continue;
    parts.push(paragraph(labels[group]));
    const items: string[] = [];
    for (const todo of todos) {
      const line = `- ${escapeHtml(safeText(todo.content, 180, ctx))}`;
      if (
        parts.join("\n").length + items.join("\n").length + line.length >
        TELEGRAM_MESSAGE_LIMIT - 100
      )
        break;
      items.push(`<li>${escapeHtml(safeText(todo.content, 180, ctx))}</li>`);
      shown += 1;
    }
    if (items.length > 0) parts.push(`<ul>${items.join("")}</ul>`);
  }

  if (shown < session.todos.length) {
    parts.push(paragraph(`... and ${session.todos.length - shown} more items`));
  }
  return limitMessage(parts.join("\n"));
}

export function formatUsage(
  session: SessionProjection,
  ctx: FormatContext,
): string {
  const tokens = aggregateTokens(session, ctx);
  return [
    titleLine(ICON_USAGE, ctx.projectLabel),
    fieldTable([
      fieldRow("Session", sessionLabel(session, ctx)),
      fieldRow("Total tokens", formatNumber(totalTokens(tokens))),
      fieldRow("Input", formatNumber(tokens.input)),
      fieldRow("Output", formatNumber(tokens.output)),
      fieldRow("Reasoning", formatNumber(tokens.reasoning)),
      fieldRow("Cache read", formatNumber(tokens.cacheRead)),
      fieldRow("Cache write", formatNumber(tokens.cacheWrite)),
      fieldRow("Cost", formatCost(tokens)),
    ]),
  ].join("\n");
}