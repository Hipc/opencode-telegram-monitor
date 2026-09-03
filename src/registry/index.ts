import { resolve, dirname } from "node:path";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { PollerLock } from "../infra/poller-lock";
import { SESSIONS_RECORD_TTL_MS } from "../constants";

export type RegistryEntry = {
  path: string;
  enabled: boolean;
  addedAt: string;
  sessions?: SessionRecord[]; // 可选：旧文件/旧代码路径无此键时保持 undefined
};

// 等待状态落盘记录（契约 docs/modules/sessions-relay.md §2 冻结；Round 2 扩展
// §13.1；Round 4 扩展 §14.1.1；Round 6 §16 起 resolved 不再由回写置位——
// 终态 = 删除记录（removeSessionRecord），resolved 字段仅历史数据/解析兼容）。
// message 为完整事件 payload 的 JSON 字符串；send 为 poller 发送置位；
// reply 为可选字段：null/缺失 = 未回复；三值 = 用户选定回复（透传不映射）。
// q_* 为 question 向导可选字段（§14.1.1）：写入端初始不设置任何 q_* 键；
// q_answers 写入 / q_reject=true 为向导终态（消费端 apply 后删除记录）。
export type SessionRecord = {
  session_id: string; // opencode sessionID（事件 properties.sessionID）
  session_name: string; // 展示名：ensureSessionInfo 拉取 info.title；拉不到兜底 sessionID
  type: "question" | "permission"; // 与 src/types.ts WaitingType 同构（字面量内联，不强依赖 import）
  message: string; // 完整事件 payload 的 JSON 字符串
  send: boolean; // 初始 false；poller 发送成功置 true
  resolved: boolean; // 初始 false；replied/rejected 置 true；终态（不再改回）
  request_id: string; // 内部匹配键：asked 事件 properties.id；replied 匹配键
  created_at: string; // ISO 8601 字符串（new Date().toISOString()），本轮仅预留不消费
  reply?: "once" | "always" | "reject" | null; // Round 2：null/缺失=未回复；三值=用户选定回复（透传不映射）
  q_draft?: Array<Array<string>>; // 向导草稿：长度=questions 数；每题=已选 label 数组；未答=空数组
  q_stage?: number; // 向导当前题索引 0-based；=questions.length 表示总结阶段
  q_input?: number | null; // 待自定义输入题索引；显式 null=无输入态
  q_answers?: Array<Array<string>>; // 最终提交答案（透传不映射）；消费端 reply 触发器
  q_reject?: boolean; // 放弃标志（true=用户取消整个向导）；消费端 reject 触发器
  q_msg_id?: number; // TG 向导消息 message_id（poller 发送成功后回写，供编辑）
};

export type ProjectRegistry = {
  projects: RegistryEntry[];
};

export const EMPTY_REGISTRY: ProjectRegistry = { projects: [] };

export function normalizeRegistryPath(path: string) {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function parseRegistry(text: string): ProjectRegistry | undefined {
  if (text.trim().length === 0) return { projects: [] };
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return undefined;
    const projects = (value as Record<string, unknown>).projects;
    if (projects === undefined) return { projects: [] };
    if (!Array.isArray(projects)) return undefined;
    const entries: RegistryEntry[] = [];
    for (const item of projects) {
      const rec =
        item !== null && typeof item === "object" && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : undefined;
      const path = typeof rec?.path === "string" ? rec.path : undefined;
      if (!path) return undefined;
      const sessions =
        rec !== undefined && Array.isArray(rec.sessions)
          ? rec.sessions
              .map(parseSessionRecord)
              .filter((s): s is SessionRecord => s !== undefined)
          : undefined; // 键缺失或非数组：整字段忽略（条目保留），不抛错
      const entry: RegistryEntry = {
        path,
        enabled: rec.enabled === true,
        addedAt:
          typeof rec.addedAt === "string"
            ? rec.addedAt
            : new Date().toISOString(),
      };
      if (sessions !== undefined) entry.sessions = sessions;
      entries.push(entry);
    }
    return { projects: entries };
  } catch {
    return undefined;
  }
}

/**
 * q_draft / q_answers 共享结构校验（契约 sessions-relay.md §14.1.2）：
 * Array<Array<string>>——每项为 Array 且元素全为 string。
 */
function isStringMatrix(value: unknown): value is Array<Array<string>> {
  return (
    Array.isArray(value) &&
    value.every(
      (row) =>
        Array.isArray(row) && row.every((item) => typeof item === "string"),
    )
  );
}

/**
 * 严格校验单条 SessionRecord（契约 sessions-relay.md §3.2，Round 2 扩展 §13.1，
 * Round 4 扩展 §14.1.2）：
 * 8 基础字段类型必须正确，不允许从默认值推断（如把非 boolean 的 send 按
 * truthy 处理）；任一字段不符 → undefined（调用方丢弃该记录，不抛错、不影响
 * 其它记录）。可选 reply 字段四态：键缺失 → 构造记录不含该键（serialize 自动
 * 省略，旧文件往返不新增键）；显式 null → null；三合法值 → 原样保留；其它
 * 任何值 → 丢弃整条记录（严格白名单风格，不抛错）。
 * q_* 6 字段（§14.1.2）：键缺失 → 构造记录不含该键；q_input 显式 null → null；
 * 合法值 → 原样保留；其它任何值 → 丢弃整条记录。q_stage 只做 typeof number
 * （不校验范围/整数性——由回调状态重建处钳制）。
 */
function parseSessionRecord(value: unknown): SessionRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const rec = value as Record<string, unknown>;
  const type =
    rec.type === "question" || rec.type === "permission" ? rec.type : undefined;
  if (
    typeof rec.session_id !== "string" ||
    typeof rec.session_name !== "string" ||
    typeof rec.message !== "string" ||
    typeof rec.request_id !== "string" ||
    typeof rec.created_at !== "string" ||
    typeof rec.send !== "boolean" ||
    typeof rec.resolved !== "boolean" ||
    !type
  )
    return undefined;
  let reply: "once" | "always" | "reject" | null | undefined;
  if ("reply" in rec) {
    if (
      rec.reply === null ||
      rec.reply === "once" ||
      rec.reply === "always" ||
      rec.reply === "reject"
    ) {
      reply = rec.reply;
    } else {
      return undefined; // 非法 reply 值：丢弃整条记录，不抛错、不影响其它记录
    }
  }
  let q_draft: Array<Array<string>> | undefined;
  let q_stage: number | undefined;
  let q_input: number | null | undefined;
  let q_answers: Array<Array<string>> | undefined;
  let q_reject: boolean | undefined;
  let q_msg_id: number | undefined;
  if ("q_draft" in rec) {
    if (isStringMatrix(rec.q_draft)) q_draft = rec.q_draft;
    else return undefined; // 非法 q_draft：丢弃整条记录
  }
  if ("q_stage" in rec) {
    if (typeof rec.q_stage === "number") q_stage = rec.q_stage;
    else return undefined; // 非法 q_stage（含 null）：丢弃整条记录
  }
  if ("q_input" in rec) {
    if (rec.q_input === null) q_input = null; // 显式 null = 无输入态，保留
    else if (typeof rec.q_input === "number") q_input = rec.q_input;
    else return undefined; // 非法 q_input：丢弃整条记录
  }
  if ("q_answers" in rec) {
    if (isStringMatrix(rec.q_answers)) q_answers = rec.q_answers;
    else return undefined; // 非法 q_answers：丢弃整条记录
  }
  if ("q_reject" in rec) {
    if (typeof rec.q_reject === "boolean") q_reject = rec.q_reject;
    else return undefined; // 非法 q_reject：丢弃整条记录
  }
  if ("q_msg_id" in rec) {
    if (typeof rec.q_msg_id === "number") q_msg_id = rec.q_msg_id;
    else return undefined; // 非法 q_msg_id：丢弃整条记录
  }
  const record: SessionRecord = {
    session_id: rec.session_id,
    session_name: rec.session_name,
    type,
    message: rec.message,
    send: rec.send,
    resolved: rec.resolved,
    request_id: rec.request_id,
    created_at: rec.created_at,
  };
  if (reply !== undefined) record.reply = reply;
  if (q_draft !== undefined) record.q_draft = q_draft;
  if (q_stage !== undefined) record.q_stage = q_stage;
  if (q_input !== undefined) record.q_input = q_input;
  if (q_answers !== undefined) record.q_answers = q_answers;
  if (q_reject !== undefined) record.q_reject = q_reject;
  if (q_msg_id !== undefined) record.q_msg_id = q_msg_id;
  return record;
}

export function serializeRegistry(registry: ProjectRegistry) {
  return JSON.stringify(registry, null, 2);
}

export function findRegistryEntry(
  registry: ProjectRegistry,
  rootPath: string,
): RegistryEntry | undefined {
  const normalized = normalizeRegistryPath(rootPath);
  return registry.projects.find(
    (entry) => normalizeRegistryPath(entry.path) === normalized,
  );
}

export function registerProject(
  registry: ProjectRegistry,
  rootPath: string,
): ProjectRegistry {
  if (findRegistryEntry(registry, rootPath)) return registry;
  return {
    projects: [
      ...registry.projects,
      {
        path: resolve(rootPath),
        enabled: false,
        addedAt: new Date().toISOString(),
      },
    ],
  };
}

/**
 * 路径的稳定短 token（callback_data 用，避免位置序号在多实例下错位）。
 * 归一化路径 -> sha1 前 12 位 hex。同机同路径恒定，跨实例一致。
 */
export function entryToken(rootPath: string) {
  const normalized = normalizeRegistryPath(rootPath);
  return createHash("sha1").update(normalized).digest("hex").slice(0, 12);
}

export function findEntryByToken(
  registry: ProjectRegistry,
  token: string,
): RegistryEntry | undefined {
  return registry.projects.find((entry) => entryToken(entry.path) === token);
}

/**
 * 幂等设值：目标状态与当前一致时返回原引用（无写入）；路径不存在返回 undefined。
 */
export function setProjectEnabled(
  registry: ProjectRegistry,
  rootPath: string,
  enabled: boolean,
): ProjectRegistry | undefined {
  const normalized = normalizeRegistryPath(rootPath);
  const index = registry.projects.findIndex(
    (entry) => normalizeRegistryPath(entry.path) === normalized,
  );
  if (index === -1) return undefined;
  if (registry.projects[index]!.enabled === enabled) return registry;
  const projects = registry.projects.slice();
  projects[index] = { ...projects[index]!, enabled };
  return { projects };
}

/**
 * 幂等删除：路径不存在时返回原引用（视为已删除，无写入）。
 */
export function deleteProjectByPath(
  registry: ProjectRegistry,
  rootPath: string,
): ProjectRegistry {
  const normalized = normalizeRegistryPath(rootPath);
  const next = {
    projects: registry.projects.filter(
      (entry) => normalizeRegistryPath(entry.path) !== normalized,
    ),
  };
  return next.projects.length === registry.projects.length ? registry : next;
}

/**
 * 追加一条 SessionRecord 到指定路径条目（决策 #3：追加不覆盖、不去重）。
 * 按 normalizeRegistryPath(rootPath) 匹配条目（复用 findRegistryEntry 语义）；
 * 条目不存在 → 返回原 registry 引用（幂等：mutate 的 next === registry 短路
 * 不写盘；调用方已先 registerProject，路径不存在是防御性兜底）。
 * 返回的 registry 必须是新对象引用（mutate 依赖引用比较做幂等短路）。
 * 契约 docs/modules/sessions-relay.md §4.1（冻结）。
 */
export function appendSessionRecord(
  registry: ProjectRegistry,
  rootPath: string,
  record: SessionRecord,
): ProjectRegistry {
  const normalized = normalizeRegistryPath(rootPath);
  const index = registry.projects.findIndex(
    (entry) => normalizeRegistryPath(entry.path) === normalized,
  );
  if (index === -1) return registry;
  const projects = registry.projects.slice();
  const entry = projects[index]!;
  projects[index] = {
    ...entry,
    sessions: [...(entry.sessions ?? []), record],
  };
  return { projects };
}

/**
 * 按 request_id 全局删除记录（supersede markSessionResolved，契约
 * sessions-relay.md §16，Round 6：终态 = 删除而非置 resolved）。请求 ID
 * 全局唯一；跨进程竞态可能产生同 request_id 的多份副本——**删除全部匹配
 * 记录**（防止删除后副本残留再次发送）。三态语义：
 * - 无匹配（全条目无该 request_id）→ 返回 undefined（mutate 不写盘不抛错，
 *   与 markSessionResolved 的「无可标记记录」路径一致）；
 * - 有匹配 → 返回新 registry：删除该 request_id 的全部记录；记录所在条目
 *   的 sessions 数组若因此为空，**保留 `sessions: []` 键**（不删键），条目
 *   本身保留（与 parse 容错 §3.2「全数组过滤后为空则保留空数组」一致）。
 * - 不区分 resolved/send/reply/q_* 状态：删除的就是整条记录，无字段保留。
 */
export function removeSessionRecord(
  registry: ProjectRegistry,
  requestID: string,
): ProjectRegistry | undefined {
  let changed = false;
  const projects = registry.projects.map((entry) => {
    const sessions = entry.sessions;
    if (!sessions || sessions.every((record) => record.request_id !== requestID))
      return entry;
    changed = true;
    return {
      ...entry,
      sessions: sessions.filter((record) => record.request_id !== requestID),
    };
  });
  return changed ? { projects } : undefined;
}

/**
 * 按 session_id 全局删除记录（契约 sessions-relay.md §16，Round 6；会话终结
 * 清理路径：session.error cancelled / session.deleted 后调用）。一个会话的
 * 全部记录（无论 resolved/reply/q_* 状态——死会话的记录全是死记录）跨全部
 * 条目删除；无匹配 → undefined；有匹配 → 新 registry（空 sessions 保留键，
 * 同 removeSessionRecord）。
 */
export function removeSessionRecordsForSession(
  registry: ProjectRegistry,
  sessionID: string,
): ProjectRegistry | undefined {
  let changed = false;
  const projects = registry.projects.map((entry) => {
    const sessions = entry.sessions;
    if (!sessions || sessions.every((record) => record.session_id !== sessionID))
      return entry;
    changed = true;
    return {
      ...entry,
      sessions: sessions.filter((record) => record.session_id !== sessionID),
    };
  });
  return changed ? { projects } : undefined;
}

/**
 * 按创建时间全局删除过期记录（契约 sessions-relay.md §16，Round 6；TTL 扫除
 * 兜底——force-close 孤儿与历史遗留记录的回收）。跨全部条目删除
 * `Date.parse(record.created_at)` 为有限数且 `< now - SESSIONS_RECORD_TTL_MS`
 * （7 天）的记录；**不可解析/非法的 created_at → 保留**（无法定龄的记录永不
 * 删除）。边界：`created_at` 与截止线恰好相等（`=== cutoff`）**不删**
 * （严格 `<`）。无任何删除 → 返回**原 registry 引用**（mutate 短路零写盘——
 * 每秒扫除一次，无过期时必须零磁盘写入）。
 */
export function removeExpiredSessionRecords(
  registry: ProjectRegistry,
  now: number,
): ProjectRegistry {
  const cutoff = now - SESSIONS_RECORD_TTL_MS;
  let changed = false;
  const projects = registry.projects.map((entry) => {
    const sessions = entry.sessions;
    if (!sessions) return entry;
    const next = sessions.filter((record) => {
      const t = Date.parse(record.created_at);
      // 未超期（含恰好等于 cutoff）与无法定龄的记录保留
      return !(Number.isFinite(t) && t < cutoff);
    });
    if (next.length === sessions.length) return entry;
    changed = true;
    return { ...entry, sessions: next };
  });
  return changed ? { projects } : registry;
}

/**
 * 按 request_id 全局精确标记 send=true（poller 发送成功后置位）。无匹配 →
 * undefined；已置位 → 原引用；resolved 保持不动（poller 只置 send）。
 * 契约 docs/modules/sessions-relay.md §4.2（冻结）；Round 6（§16）起仅存
 * send 一个置位方向（resolved 终态已由删除语义取代，markSessionResolved
 * 移除）。
 */
export function markSessionSent(
  registry: ProjectRegistry,
  requestID: string,
): ProjectRegistry | undefined {
  return markSessionFlag(registry, requestID);
}

/**
 * 按 request_id 全局精确写入 reply 值（契约 sessions-relay.md §13.2，Round 2，
 * TG 审批按钮回调）。与 markSessionResolved 同构：全局 request_id 精确匹配
 * （请求 ID 全局唯一，跨全部条目找第一条；顺序 = projects 数组序 + sessions
 * 数组序）。三态语义：
 * - 无匹配 → undefined（mutate 不写盘不抛错）；
 * - 匹配且 reply 已是同一值 → 返回原 registry 引用（幂等，mutate 短路不写盘）；
 * - 匹配且值不同 → 返回新 registry，仅改 reply 字段（send/resolved 不动，
 *   即使 resolved=true 也允许写 reply——纯字段写、无状态检查）。
 * 不复用 markSessionFlag（只置 true boolean，值类型不同），自行实现。
 */
export function setSessionReply(
  registry: ProjectRegistry,
  requestID: string,
  reply: "once" | "always" | "reject",
): ProjectRegistry | undefined {
  for (let i = 0; i < registry.projects.length; i++) {
    const entry = registry.projects[i]!;
    const sessions = entry.sessions;
    if (!sessions) continue;
    for (let j = 0; j < sessions.length; j++) {
      if (sessions[j]!.request_id !== requestID) continue;
      if (sessions[j]!.reply === reply) return registry; // 同值：幂等，原引用
      const projects = registry.projects.slice();
      projects[i] = {
        ...entry,
        sessions: sessions.map((record, k) =>
          k !== j ? record : { ...record, reply },
        ),
      };
      return { projects };
    }
  }
  return undefined; // 无匹配：无可写记录，静默跳过写盘
}

/**
 * q_* 纯函数共用实现（契约 sessions-relay.md §14.1.3，Round 4 question 向导）：
 * 全局 request_id 精确匹配（跨全部条目找第一条，顺序 = projects 数组序 +
 * sessions 数组序）；无匹配 → undefined（mutate 不写盘不抛错）；匹配且
 * isSame(record) 成立 → 返回原 registry 引用（幂等，mutate 短路不写盘）；
 * 否则返回新 registry，仅按 update(record) 改写目标记录（send/resolved/
 * reply 及其它 q_* 不动）。返回必须是新对象引用。
 */
function updateQuestionField(
  registry: ProjectRegistry,
  requestID: string,
  isSame: (record: SessionRecord) => boolean,
  update: (record: SessionRecord) => SessionRecord,
): ProjectRegistry | undefined {
  for (let i = 0; i < registry.projects.length; i++) {
    const entry = registry.projects[i]!;
    const sessions = entry.sessions;
    if (!sessions) continue;
    for (let j = 0; j < sessions.length; j++) {
      if (sessions[j]!.request_id !== requestID) continue;
      if (isSame(sessions[j]!)) return registry; // 同值：幂等，原引用
      const projects = registry.projects.slice();
      projects[i] = {
        ...entry,
        sessions: sessions.map((record, k) =>
          k !== j ? record : update(record),
        ),
      };
      return { projects };
    }
  }
  return undefined; // 无匹配：无可写记录，静默跳过写盘
}

/**
 * 写向导草稿 + 阶段（契约 sessions-relay.md §14.1.3；选项点击/导航/自定义
 * 输入写入共用；draft 与 stage 都为完整新值）。三态同 §4.2；仅改
 * q_draft/q_stage（send/resolved/reply 及其它 q_* 不动）。
 */
export function setQuestionDraft(
  registry: ProjectRegistry,
  requestID: string,
  draft: Array<Array<string>>, // 长度=questions 数
  stage: number, // 0..questions.length；=length 为总结阶段
): ProjectRegistry | undefined {
  return updateQuestionField(
    registry,
    requestID,
    (record) => record.q_draft === draft && record.q_stage === stage,
    (record) => ({ ...record, q_draft: draft, q_stage: stage }),
  );
}

/**
 * 写/清自定义输入态（契约 sessions-relay.md §14.1.3；index=题索引；null=清除）。
 * 三态同 §4.2；仅改 q_input。
 */
export function setQuestionInput(
  registry: ProjectRegistry,
  requestID: string,
  index: number | null,
): ProjectRegistry | undefined {
  return updateQuestionField(
    registry,
    requestID,
    (record) => record.q_input === index,
    (record) => ({ ...record, q_input: index }),
  );
}

/**
 * 最终提交（契约 sessions-relay.md §14.1.3；消费端 reply 触发器；answers
 * 原样透传不校验）。三态同 §4.2；仅改 q_answers。
 */
export function submitQuestionAnswers(
  registry: ProjectRegistry,
  requestID: string,
  answers: Array<Array<string>>,
): ProjectRegistry | undefined {
  return updateQuestionField(
    registry,
    requestID,
    (record) => record.q_answers === answers,
    (record) => ({ ...record, q_answers: answers }),
  );
}

/**
 * 放弃整个向导（契约 sessions-relay.md §14.1.3；消费端 reject 触发器；
 * 置 q_reject=true）。三态同 §4.2；仅改 q_reject。
 */
export function rejectQuestion(
  registry: ProjectRegistry,
  requestID: string,
): ProjectRegistry | undefined {
  return updateQuestionField(
    registry,
    requestID,
    (record) => record.q_reject === true,
    (record) => ({ ...record, q_reject: true }),
  );
}

/**
 * 回写向导消息 message_id（契约 sessions-relay.md §14.1.3；poller 发送成功后）。
 * 三态同 §4.2；仅改 q_msg_id。
 */
export function setQuestionMessageID(
  registry: ProjectRegistry,
  requestID: string,
  messageID: number,
): ProjectRegistry | undefined {
  return updateQuestionField(
    registry,
    requestID,
    (record) => record.q_msg_id === messageID,
    (record) => ({ ...record, q_msg_id: messageID }),
  );
}

/**
 * /cancel 批量清除（契约 sessions-relay.md §14.1.3 辅助函数）：清除全部记录的
 * q_input 键（回到「缺失」态，serialize 自动省略）。无任何变更 → 返回原
 * registry 引用；有变更 → 新 registry（仅重建含 q_input 记录的条目）。
 * 不返回 undefined；send/resolved/reply 及其它 q_* 一律不动。
 */
export function clearQuestionInputs(
  registry: ProjectRegistry,
): ProjectRegistry {
  let changed = false;
  const projects = registry.projects.map((entry) => {
    const sessions = entry.sessions;
    if (!sessions) return entry;
    let entryChanged = false;
    const nextSessions = sessions.map((record) => {
      if (!("q_input" in record)) return record;
      entryChanged = true;
      const next = { ...record };
      delete next.q_input;
      return next;
    });
    if (!entryChanged) return entry;
    changed = true;
    return { ...entry, sessions: nextSessions };
  });
  return changed ? { projects } : registry;
}

/**
 * 私有实现（supersede §4.2 的 markSessionFlag）：Round 6 起仅服务 send 置位，
 * 不再需要 resolved 分支（resolved 终态已由删除语义取代，见 §16）。
 * 全局 request_id 精确匹配（跨全部条目找第一条）；无匹配 → undefined；已
 * 置位 → 原引用（幂等）；否则新 registry 仅改 send=true（resolved 不动）。
 */
function markSessionFlag(
  registry: ProjectRegistry,
  requestID: string,
): ProjectRegistry | undefined {
  for (let i = 0; i < registry.projects.length; i++) {
    const entry = registry.projects[i]!;
    const sessions = entry.sessions;
    if (!sessions) continue;
    for (let j = 0; j < sessions.length; j++) {
      if (sessions[j]!.request_id !== requestID) continue;
      if (sessions[j]!.send === true) return registry; // 已置位：幂等，原引用
      const projects = registry.projects.slice();
      projects[i] = {
        ...entry,
        sessions: sessions.map((record, k) =>
          k !== j ? record : { ...record, send: true },
        ),
      };
      return { projects };
    }
  }
  return undefined; // 无匹配：无可标记记录，静默跳过写盘
}

// 跨进程写锁参数（契约 docs/modules/projects-registry.md §4.1）：
// 抢锁 deadline 与重试间隔；超时返回 undefined 不抛错——插件绝不因注册表锁阻塞 opencode。
const ACQUIRE_TIMEOUT_MS = 3_000;
const RETRY_MS = 50;

export class ProjectRegistryStore {
  private cache?: { key: string; registry: ProjectRegistry };
  private queue: Promise<unknown> = Promise.resolve();
  private readonly lock: PollerLock;

  constructor(
    private readonly filePath: string,
    private readonly logger?: (message: string) => Promise<void> | void,
  ) {
    // 锁文件 = 注册表路径 + ".lock"；默认 TTL（DEFAULT_TTL_MS=60s）。
    // 只创建 PollerLock 对象，不创建任何文件/目录（构造函数无副作用）。
    this.lock = new PollerLock(`${filePath}.lock`);
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async logWarn(message: string) {
    try {
      await this.logger?.(message);
    } catch {
      /* ignore */
    }
  }

  private async statKey(): Promise<string | undefined> {
    try {
      const st = await stat(this.filePath);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return undefined;
    }
  }

  async ensureDir() {
    await mkdir(dirname(this.filePath), { recursive: true });
  }

  async read(): Promise<ProjectRegistry> {
    const key = await this.statKey();
    if (this.cache && this.cache.key === key) return this.cache.registry;
    let registry: ProjectRegistry = EMPTY_REGISTRY;
    if (key !== undefined) {
      let text = "";
      try {
        text = await readFile(this.filePath, "utf8");
      } catch {
        text = "";
      }
      const parsed = parseRegistry(text);
      if (parsed) {
        registry = parsed;
      } else {
        await this.logWarn(
          "projects.json parse failed; treated as empty until next write repairs it",
        );
      }
    }
    this.cache = { key: key ?? "missing", registry };
    return registry;
  }

  async isEnabled(rootPath: string) {
    const registry = await this.read();
    return findRegistryEntry(registry, rootPath)?.enabled ?? false;
  }

  async mutate(
    fn: (reg: ProjectRegistry) => ProjectRegistry | undefined,
  ): Promise<ProjectRegistry | undefined> {
    return this.serialized(async () => {
      // 跨进程锁：serialized() 仅保证进程内互斥；PollerLock 保证多进程（多
      // opencode 窗口）互斥。锁内重读保证「读到即最新」（锁外无写者），
      // 因此不再需要 statKey CAS 前后对比重试。
      const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
      for (;;) {
        if (await this.lock.tryAcquire()) break;
        if (Date.now() >= deadline) return undefined; // 抢锁超时：不执行 fn、不抛错、不改缓存
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }
      try {
        // 锁内重读：statKey 兼作缓存比对 key（同旧实现 beforeKey）
        const key = await this.statKey();
        let registry: ProjectRegistry = EMPTY_REGISTRY;
        let hadParseError = false;
        if (key !== undefined) {
          let text = "";
          try {
            text = await readFile(this.filePath, "utf8");
          } catch {
            text = "";
          }
          const parsed = parseRegistry(text);
          if (parsed) {
            registry = parsed;
          } else if (text.trim().length > 0) {
            hadParseError = true;
          }
        }
        if (hadParseError) {
          try {
            await copyFile(this.filePath, `${this.filePath}.bak`);
            await this.logWarn(
              "projects.json was corrupt; backed up to projects.json.bak",
            );
          } catch {
            await this.logWarn("projects.json was corrupt; backup failed");
          }
        }
        const next = fn(registry);
        if (next === undefined) return undefined;
        if (next === registry && !hadParseError) {
          // 幂等无变化：不写盘，仅刷新缓存（损坏文件时仍走写盘以修复）
          this.cache = { key: key ?? "missing", registry: next };
          return next;
        }
        await this.writeAtomic(next);
        this.cache = {
          key: (await this.statKey()) ?? "missing",
          registry: next,
        };
        return next;
      } finally {
        await this.lock.release();
      }
    });
  }

  private async writeAtomic(registry: ProjectRegistry) {
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, serializeRegistry(registry), "utf8");
    try {
      await rename(tmp, this.filePath);
      return;
    } catch {
      // Windows: rename over an existing file can raise EPERM (user-profile
      // dirs under OneDrive/AV/sync tools). Fall back to delete+rename.
    }
    try {
      await rm(this.filePath, { force: true });
      await rename(tmp, this.filePath);
      return;
    } catch {
      // Last resort: overwrite via copy (reliably replaces on Windows).
      await copyFile(tmp, this.filePath);
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }
}
