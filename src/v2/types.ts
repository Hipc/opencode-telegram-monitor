// Local opencode v2 integration types.
//
// Frozen contract: docs/modules/opencode-v2-contract.md §2–§4 (target opencode
// v2.0.15). Decision §4.1: every v2 type is defined locally — a local .ts plugin
// is compiled by the host's embedded Bun with no node_modules and no
// `@opencode-ai/*` type source, so this file is the single type authority.
// No runtime or type import of `@opencode-ai/*` may appear anywhere under src/.

export type V2Location = {
  directory: string;
  workspaceID?: string;
  project?: { id: string; directory: string; canonical: string };
};

export type V2Durable = {
  aggregateID: string;
  seq: number;
  version: number;
};

/**
 * Raw event envelope as produced by `client.event.subscribe()` (§2.0). The
 * plugin entry hands it to `TelegramSessionMonitor.accept()` untouched;
 * `parseRuntimeEvent` normalizes `data` into the internal `properties` bag.
 */
export type V2EventEnvelope = {
  id: string;
  created: number;
  type: string;
  durable?: V2Durable;
  location?: { directory?: string };
  data?: Record<string, unknown>;
};

/**
 * `client.session.get()` / `client.session.create()` return shape (§3.1, direct
 * object — v2 is not `{data}`-wrapped).
 *
 * `parentID` is never populated: the frozen v2.0.15 surface exposes no parent
 * linkage (no `parentID` in `session.created` data nor in `session.get`). It
 * stays optional so the existing parent/root projection logic
 * (childSessions/primarySession, contract §2.1 "父/根会话 idle 补齐") compiles
 * unchanged and becomes effective again if a future v2 surface exposes it.
 */
export type V2SessionInfo = {
  id: string;
  title?: string;
  projectID?: string;
  parentID?: string;
  location?: { directory?: string };
};

/** `client.permission.list/get` item shape (§2.5 / §3.1). */
export type V2PermissionRequest = {
  id: string;
  sessionID: string;
  action: string;
  resources?: string[];
  save?: string[];
  source?: { type: string; messageID: string; id: string };
};

/**
 * Frozen client surface (§3.1): only the methods the plugin is allowed to call.
 * v2's `app` namespace is metadata-only and has no `log` method (§1.5/§3.2), so
 * it is deliberately absent.
 */
export type V2Client = {
  location: V2Location;
  event: {
    subscribe(): AsyncIterable<V2EventEnvelope>;
  };
  permission: {
    reply(input: {
      sessionID: string;
      requestID: string;
      decision: "once" | "always" | "reject";
      message?: string;
    }): Promise<unknown>;
    list(input: { sessionID: string }): Promise<V2PermissionRequest[]>;
    get(input: {
      sessionID: string;
      requestID: string;
    }): Promise<V2PermissionRequest>;
  };
  session: {
    get(input: { sessionID: string }): Promise<V2SessionInfo>;
    create(input: { title: string }): Promise<V2SessionInfo>;
    context(input: { sessionID: string }): Promise<unknown[]>;
  };
};

// --- Event `data` payloads (contract §2 mapping tables, exact observed fields) ---

export type V2ErrorInfo = {
  type?: string;
  name?: string;
  message?: string;
  data?: Record<string, unknown>;
};

export type V2TokenTotals = {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
};

export type SessionCreatedData = {
  sessionID: string;
  projectID?: string;
  location?: { directory?: string };
  subpath?: string;
  slug?: string;
  title?: string;
  version?: string;
  permissions?: unknown[];
};

export type SessionDeletedData = {
  sessionID: string;
};

export type ExecutionFailedData = {
  sessionID: string;
  error?: V2ErrorInfo;
};

export type ExecutionInterruptedData = {
  sessionID: string;
  reason?: string;
};

export type StepStartedData = {
  sessionID: string;
  assistantMessageID: string;
  agent?: string;
  model?: { id: string; providerID: string };
  started?: number;
};

export type StepStreamedData = {
  sessionID: string;
  assistantMessageID: string;
};

export type StepEndedData = {
  sessionID: string;
  assistantMessageID: string;
  finish?: string;
  rawFinish?: string;
  cost?: number | null;
  tokens?: V2TokenTotals;
};

export type StepFailedData = {
  sessionID: string;
  assistantMessageID: string;
  error?: V2ErrorInfo;
};

export type ToolInputStartedData = {
  sessionID: string;
  assistantMessageID: string;
  id: string;
  name: string;
};

export type ToolInputEndedData = {
  sessionID: string;
  assistantMessageID: string;
  id: string;
  text?: string;
};

export type ToolCalledData = {
  sessionID: string;
  assistantMessageID: string;
  id: string;
  input?: Record<string, unknown>;
  executed?: boolean;
};

export type ToolProgressData = {
  sessionID: string;
  assistantMessageID: string;
  id: string;
  metadata?: { shellID?: string };
};

export type ToolSuccessData = {
  sessionID: string;
  assistantMessageID: string;
  id: string;
  content?: Array<{ type: string; text?: string }>;
  metadata?: { status?: string; truncated?: boolean; exit?: number };
  executed?: boolean;
};

export type ToolFailedData = {
  sessionID: string;
  assistantMessageID: string;
  id: string;
  error?: V2ErrorInfo;
  metadata?: Record<string, unknown>;
  executed?: boolean;
};

export type UsageUpdatedData = {
  sessionID: string;
  cost?: number | null;
  tokens?: V2TokenTotals;
};

export type PermissionAskedData = {
  id: string;
  sessionID: string;
  action: string;
  resources?: string[];
  save?: string[];
  source?: { type: string; messageID: string; id: string };
};

export type PermissionRepliedData = {
  sessionID: string;
  requestID: string;
  reply: "once" | "always" | "reject";
};

export type FormFieldData = {
  key: string;
  title?: string;
  /** Natural question flow: `description` carries the question text (§2.6/§A.6). */
  description?: string;
  type:
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "multiselect"
    | "external";
  options?: Array<{ value: string; label: string; description?: string }>;
  custom?: boolean;
  required?: boolean;
  hidden?: boolean;
  when?: unknown;
  format?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  default?: unknown;
};

export type FormCreatedData = {
  form: {
    id: string;
    sessionID: string;
    title?: string;
    /**
     * Optional (§2.6 r1): present on the natural question flow
     * (`{kind:"question", tool:{messageID, id}}`), absent on API-created
     * control forms. Marked shape only — never drives the waiting record.
     */
    metadata?: {
      kind?: string;
      tool?: { messageID?: string; id?: string };
    };
    fields: FormFieldData[];
  };
};

export type FormRepliedData = {
  id: string;
  sessionID: string;
  answer: Record<string, unknown>;
};

export type FormCancelledData = {
  id: string;
  sessionID: string;
};

export type InboxEnqueuedData = {
  sessionID: string;
  inboxID: string;
  item: {
    type: "user" | "synthetic" | "compaction" | "move";
    payload?: { text?: string; files?: unknown[] };
    delivery: "steer" | "queue";
  };
};

export type InboxDeliveredData = {
  sessionID: string;
  inboxID: string;
};

export type InboxCancelledData = {
  sessionID: string;
  inboxID: string;
};

export type InboxDeliveryChangedData = {
  sessionID: string;
  inboxID: string;
  delivery: "steer" | "queue";
};
