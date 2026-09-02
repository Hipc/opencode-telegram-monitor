import type {
  AssistantMessage,
  Session,
  Todo,
} from "@opencode-ai/sdk";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type SessionState = "idle" | "busy" | "retry";
export type SessionOutcome = "completed" | "failed" | "cancelled";
export type ToolState = "pending" | "running" | "completed" | "error";
export type WaitingType = "permission" | "question";

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
  info?: Session;
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
  messagesByID: Map<string, AssistantMessage>;
  toolsByCallID: Map<string, ToolProjection>;
  todos: Todo[];
  waitingByRequestID: Map<string, WaitingProjection>;
  tokens: TokenTotals;
  pendingError?: ErrorSummary;
};

export type RuntimeEvent = {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
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

export type TodoCounts = {
  inProgress: number;
  pending: number;
  completed: number;
  cancelled: number;
  total: number;
};
// 原 todoCounts()（monitor.ts:2991-2999）的返回结构，todoSummary（3001-3006）参数化用

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
