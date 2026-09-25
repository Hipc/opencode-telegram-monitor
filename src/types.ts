import type { V2SessionInfo } from "./v2/types";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type SessionState = "idle" | "busy" | "retry";
export type SessionOutcome = "completed" | "failed" | "cancelled";
export type ToolState = "pending" | "running" | "completed" | "error";
export type WaitingType = "permission" | "question";

// v2 status shape consumed by applyStatus (v1 SDK `SessionStatus` equivalent):
// v2 drives state transitions through session.execution.* / step.* events, so
// the retry variant is retained for the display/apply machinery only.
export type SessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number };

export type TelegramConfig = {
  botToken: string;
  chatId: string;
  proxy?: string;
};

export type ProxySpec = {
  host: string;
  port: number;
  secure: boolean;
  auth?: string;
};

export type TokenTotals = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  hasCost: boolean;
};

export type ErrorSummary = {
  name: string;
  message?: string;
  cancelled: boolean;
};

export type WaitingProjection = {
  requestID: string;
  type: WaitingType;
  summary: string;
  toolCallID?: string;
};

export type ToolProjection = {
  partID?: string;
  callID: string;
  tool: string;
  state: ToolState;
  authoritative: boolean;
  target?: string;
  progress?: string;
  updatedAt: number;
};

export type SessionProjection = {
  sessionID: string;
  info?: V2SessionInfo;
  status: SessionState;
  outcome?: SessionOutcome;
  observedRunning: boolean;
  turn: number;
  notifiedTurn?: number;
  currentAssistantMessageID?: string;
  emptyMessageRetries: number;
  turnStartedAt?: number;
  lastTransitionAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  agent?: string;
  toolsByCallID: Map<string, ToolProjection>;
  waitingByRequestID: Map<string, WaitingProjection>;
  tokens: TokenTotals;
  pendingError?: ErrorSummary;
  // v2 §2.7: set while an undelivered "steer" inbox item exists; postpones idle
  // finalization. Optional so projections created before the field existed are
  // treated as false (undefined).
  awaitingInput?: boolean;
  // v2 §2.7: delivery state per inboxID for this session; `awaitingInput` is
  // derived from it (any "steer" entry). Optional — a projection without the
  // map has no pending inbox items.
  inboxDeliveryByID?: Map<string, "steer" | "queue">;
};

export type RuntimeEvent = {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
  // v2 envelope location (§2.0). Optional and publisher-dependent: the container
  // evidence (probe-a1/probe-lineage/harness SSE captures, opencode v2.0.15)
  // shows session.created/step.*/tool.*/form.*/permission.asked carry it while
  // session.execution.* / session.usage.updated / permission.replied do not.
  // t12 consumes it for the per-instance ownership gate.
  location?: { directory?: string };
};

// Local shape of the question wizard payload stored in a SessionRecord message
// (v1 `@opencode-ai/sdk` QuestionV2Info equivalent; v2 form.* mapping is ticket
// 04's, §2.6).
export type QuestionV2Option = {
  label?: string;
  description?: string;
};

export type QuestionV2Info = {
  header?: string;
  question?: string;
  options?: QuestionV2Option[];
  multiple?: boolean;
};

export type TelegramCallbackQuery = {
  id: string;
  from?: { id: number | string };
  message?: {
    message_id: number;
    chat: { id: number | string };
    text?: string; // Round 2：perm 回调编辑原消息用（契约 sessions-relay.md §13.5）
  };
  data?: string;
};

export type TelegramInlineButton = { text: string; callback_data?: string };
export type TelegramInlineKeyboard = { inline_keyboard: TelegramInlineButton[][] };

export type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    from?: {
      id: number | string;
    };
    chat: {
      id: number | string;
      type: string;
    };
  };
  callback_query?: TelegramCallbackQuery;
};

export type TelegramEnvelope<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: {
    retry_after?: number;
  };
};

export type TokensSummary = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  hasCost: boolean;
};
// 与 TokenTotals 同构（结构相同），语义为「会话聚合 token 汇总」；
// 用作 format.aggregateTokens 的返回类型（§2.8），避免格式层引用 TokenTotals 的投影语义。

export type SessionDisplayState =
  | "waiting"
  | "running"
  | "retrying"
  | SessionOutcome
  | "idle";
// 原 displayState()（2950-2955）返回类型展开；iconForState（2968）参数化用。
