// tests/e2e/real-rich-edit.test.mjs
//
// 真实环境 Telegram 富文本消息编辑探针（§15.2 探针契约）
// 依据 AGENTS.md 授权使用 ~/.otg/telegram.json 真实凭据探测富文本 edit payload。
//
// 探针目标：
//   - REAL-RICH-EDIT-001: sendRichMessage + rich_message.html 基线发送
//   - REAL-RICH-EDIT-002: editRichMessage + rich_message.html (候选 A, 携带 reply_markup)
//   - REAL-RICH-EDIT-003: editRichMessage + rich_message.html (候选 A, 省略 reply_markup)
//   - REAL-RICH-EDIT-004: editMessageText + rich_message.html (候选 B, 携带 reply_markup)
//   - REAL-RICH-EDIT-005: editMessageText + parse_mode "HTML" (候选 C, 省略 reply_markup)
//
// 纪律：
//   - 严禁 getUpdates / answerCallbackQuery
//   - 凭据不落盘、不输出 botToken（严格打码脱敏）
//   - 单次请求序列，无常驻守卫

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { telegramRequest } from "../../src/telegram/client.ts";
import { TelegramApiError } from "../../src/telegram/api-error.ts";

const TIMEOUT_MS = 30_000;

// ---- 凭据加载 ----
const configPath = join(homedir(), ".otg", "telegram.json");
let rawConfig;
try {
  rawConfig = JSON.parse(readFileSync(configPath, "utf8"));
} catch (error) {
  console.error(`FAIL: cannot read/parse ${configPath}: ${error.message}`);
  process.exit(1);
}
const botToken = rawConfig?.botToken;
const chatId = rawConfig?.chatId;
const proxy = rawConfig?.proxy;

const missing = [
  ["botToken", botToken],
  ["chatId", chatId],
].filter(([, v]) => typeof v !== "string" || v.length === 0);

if (missing.length > 0) {
  console.error(
    `FAIL: missing required field(s) in ${configPath}: ${missing.map(([k]) => k).join(", ")}`,
  );
  process.exit(1);
}

console.log(
  `config loaded: chatId=${chatId}, proxy=${proxy ? "set" : "(none)"}, botToken=<redacted len=${String(botToken).length}>`,
);

// 传输通道：使用 config 中的 proxy（若有）；无 proxy 则直连
const ctx = {
  config: { botToken, chatId, proxy },
  signal: new AbortController().signal,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseMessageId(result) {
  if (typeof result?.message_id === "number") return result.message_id;
  if (typeof result?.message?.message_id === "number") return result.message.message_id;
  if (typeof result?.messageId === "number") return result.messageId;
  return undefined;
}

// 富文本 AST 定位：telegramRequest 返回 envelope.result，rich_message 字段路径按实际响应键名
// 发现（§15.2 实测结论：赢家响应 rich_message.blocks 保留 table/cells/is_compact），不做假设。
function locateRichMessage(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  if (payload.rich_message && typeof payload.rich_message === "object")
    return payload.rich_message;
  if (
    payload.result &&
    typeof payload.result === "object" &&
    payload.result.rich_message
  )
    return payload.result.rich_message;
  if (
    payload.message &&
    typeof payload.message === "object" &&
    payload.message.rich_message
  )
    return payload.message.rich_message;
  return undefined;
}

function summarizeBlocks(blocks) {
  if (!Array.isArray(blocks)) return `blocks=<${typeof blocks}>`;
  return `blocks[${blocks.length}] types=[${blocks
    .map((b) => (b && typeof b === "object" ? (b.type ?? "?") : String(b)))
    .join(",")}]`;
}

// 记录硬断言失败次数：任何硬断言失败都要求退出码非 0（§15.2 判定规则，不得放宽）。
let hardAssertFailures = 0;

const probeResults = {};

// ---- 探针执行 ----
console.log("");
console.log("=== Starting Real Rich Message Edit Probe ===");

let targetMessageId = undefined;

// REAL-RICH-EDIT-001: sendRichMessage 基线发送
try {
  const res001 = await telegramRequest(
    "sendRichMessage",
    {
      chat_id: chatId,
      rich_message: {
        html: "<p><b>[REAL-RICH-EDIT-001]</b> 基线发送测试</p><table compact><tr><th>测试项</th><td>基线发送</td></tr><tr><th>状态</th><td>等待编辑验证</td></tr></table>",
      },
      reply_markup: {
        inline_keyboard: [[{ text: "测试按钮 (001)", callback_data: "otg:test:probe001" }]],
      },
    },
    TIMEOUT_MS,
    ctx,
  );
  targetMessageId = parseMessageId(res001);
  if (typeof targetMessageId !== "number") {
    throw new Error(`sendRichMessage succeeded but no numeric message_id: ${JSON.stringify(res001)}`);
  }
  probeResults["REAL-RICH-EDIT-001"] = { ok: true, messageId: targetMessageId, raw: res001 };
  console.log(`ok   REAL-RICH-EDIT-001: sendRichMessage sent, message_id=${targetMessageId}`);
} catch (error) {
  probeResults["REAL-RICH-EDIT-001"] = { ok: false, error: error.message };
  console.error(`FAIL REAL-RICH-EDIT-001: sendRichMessage failed: ${error.message}`);
  process.exit(1);
}

await sleep(1500);

// REAL-RICH-EDIT-002: 候选 A editRichMessage + rich_message.html (含 keyboard)
try {
  const res002 = await telegramRequest(
    "editRichMessage",
    {
      chat_id: chatId,
      message_id: targetMessageId,
      rich_message: {
        html: "<p><b>[REAL-RICH-EDIT-002]</b> 候选 A editRichMessage (带键盘)</p><table compact><tr><th>测试项</th><td>候选 A</td></tr><tr><th>状态</th><td>已编辑 (键盘保留)</td></tr></table>",
      },
      reply_markup: {
        inline_keyboard: [[{ text: "A-保留按钮 (002)", callback_data: "otg:test:probe002" }]],
      },
    },
    TIMEOUT_MS,
    ctx,
  );
  const mid002 = parseMessageId(res002);
  probeResults["REAL-RICH-EDIT-002"] = { ok: true, messageId: mid002, raw: res002 };
  console.log(`ok   REAL-RICH-EDIT-002: editRichMessage (with keyboard) succeeded, result=${JSON.stringify(res002).slice(0, 150)}`);
} catch (error) {
  probeResults["REAL-RICH-EDIT-002"] = { ok: false, error: error.message };
  console.log(
    `info REAL-RICH-EDIT-002: editRichMessage (with keyboard) failed (预期对照失败): ${error.message} (code=${error instanceof TelegramApiError ? error.errorCode ?? "n/a" : "n/a"})`,
  );
}

await sleep(1500);

// REAL-RICH-EDIT-003: 候选 A editRichMessage + rich_message.html (省略 keyboard)
try {
  const res003 = await telegramRequest(
    "editRichMessage",
    {
      chat_id: chatId,
      message_id: targetMessageId,
      rich_message: {
        html: "<p><b>[REAL-RICH-EDIT-003]</b> 候选 A editRichMessage (无键盘)</p><table compact><tr><th>测试项</th><td>候选 A</td></tr><tr><th>状态</th><td>已编辑 (键盘移除)</td></tr></table>",
      },
    },
    TIMEOUT_MS,
    ctx,
  );
  const mid003 = parseMessageId(res003);
  probeResults["REAL-RICH-EDIT-003"] = { ok: true, messageId: mid003, raw: res003 };
  console.log(`ok   REAL-RICH-EDIT-003: editRichMessage (omit keyboard) succeeded, result=${JSON.stringify(res003).slice(0, 150)}`);
} catch (error) {
  probeResults["REAL-RICH-EDIT-003"] = { ok: false, error: error.message };
  console.log(
    `info REAL-RICH-EDIT-003: editRichMessage (omit keyboard) failed (预期对照失败): ${error.message} (code=${error instanceof TelegramApiError ? error.errorCode ?? "n/a" : "n/a"})`,
  );
}

await sleep(1500);

// REAL-RICH-EDIT-004: 候选 B editMessageText + rich_message.html (含 keyboard)
try {
  const res004 = await telegramRequest(
    "editMessageText",
    {
      chat_id: chatId,
      message_id: targetMessageId,
      rich_message: {
        html: "<p><b>[REAL-RICH-EDIT-004]</b> 候选 B editMessageText+rich_message (带键盘)</p><table compact><tr><th>测试项</th><td>候选 B</td></tr><tr><th>状态</th><td>已编辑 (键盘保留)</td></tr></table>",
      },
      reply_markup: {
        inline_keyboard: [[{ text: "B-保留按钮 (004)", callback_data: "otg:test:probe004" }]],
      },
    },
    TIMEOUT_MS,
    ctx,
  );
  const mid004 = parseMessageId(res004);

  // ---- 观察 + 硬断言（§15.2 判定规则 1/5；溯源 docs/modules/sessions-relay.md §15.2）----
  // 先打印实际响应键名，再按发现的结构断言；不凭空假设路径。
  const res004Keys = Object.keys(res004 ?? {}).sort();
  console.log(
    `info REAL-RICH-EDIT-004: response top-level keys = ${res004Keys.join(", ") || "(empty)"}`,
  );
  const richMessage004 = locateRichMessage(res004);
  const richKeys004 = richMessage004 ? Object.keys(richMessage004).sort() : [];
  const blocks004 = richMessage004?.blocks;
  const tableBlock004 = Array.isArray(blocks004)
    ? blocks004.find((b) => b?.type === "table")
    : undefined;
  const astOk =
    richMessage004 !== undefined &&
    Array.isArray(blocks004) &&
    tableBlock004 !== undefined &&
    tableBlock004.cells !== undefined &&
    tableBlock004.is_compact === true;
  const keyboardRetained = res004?.reply_markup !== undefined;
  console.log(
    `info REAL-RICH-EDIT-004: rich_message.path=${richMessage004 ? (res004?.rich_message ? "res.rich_message" : "res.result.rich_message") : "MISSING"} keys=[${richKeys004.join(",") || "(empty)"}] ${summarizeBlocks(blocks004)} table={type:${tableBlock004?.type} cells:${Array.isArray(tableBlock004?.cells) ? `array[${tableBlock004.cells.length}]` : typeof tableBlock004?.cells} is_compact:${tableBlock004?.is_compact}} reply_markup.present=${keyboardRetained}`,
  );
  if (!astOk) {
    throw new Error(
      `REAL-RICH-EDIT-004 assertion failed: winner AST must keep table/cells/is_compact=true; actual keys=[${res004Keys.join(",")}] rich_message=${richMessage004 ? "found" : "MISSING"} ${summarizeBlocks(blocks004)} table=${tableBlock004 ? JSON.stringify({ type: tableBlock004.type, cellsType: typeof tableBlock004.cells, is_compact: tableBlock004.is_compact }) : "not found"}`,
    );
  }
  if (!keyboardRetained) {
    throw new Error(
      "REAL-RICH-EDIT-004 assertion failed: reply_markup was sent but response has no reply_markup (keyboard retention broken)",
    );
  }
  probeResults["REAL-RICH-EDIT-004"] = {
    ok: true,
    messageId: mid004,
    astOk: true,
    keyboardRetained: true,
    raw: res004,
  };
  console.log(
    `ok   REAL-RICH-EDIT-004: editMessageText+rich_message succeeded, message_id=${mid004}, AST table/cells/is_compact confirmed, keyboard retained`,
  );
} catch (error) {
  const msg004 = String(error?.message ?? error);
  const isHard004 = msg004.startsWith("REAL-RICH-EDIT-004 assertion failed");
  probeResults["REAL-RICH-EDIT-004"] = {
    ok: false,
    error: msg004,
    hardAssertionFailure: isHard004,
  };
  if (isHard004) {
    hardAssertFailures += 1;
    console.error(`FAIL REAL-RICH-EDIT-004: ${msg004}`);
  } else {
    console.log(
      `info REAL-RICH-EDIT-004: editMessageText+rich_message failed: ${msg004} (code=${error instanceof TelegramApiError ? error.errorCode ?? "n/a" : "n/a"})`,
    );
  }
}

await sleep(1500);

// REAL-RICH-EDIT-004b: 候选 B editMessageText + rich_message.html (省略 keyboard)
try {
  const res004b = await telegramRequest(
    "editMessageText",
    {
      chat_id: chatId,
      message_id: targetMessageId,
      rich_message: {
        html: "<p><b>[REAL-RICH-EDIT-004b]</b> 候选 B editMessageText+rich_message (无键盘)</p><table compact><tr><th>测试项</th><td>候选 B</td></tr><tr><th>状态</th><td>已编辑 (键盘已移除)</td></tr></table>",
      },
    },
    TIMEOUT_MS,
    ctx,
  );
  const mid004b = parseMessageId(res004b);

  // ---- 硬断言：省略 reply_markup 必须移除键盘（§15.2 判定规则 5，键盘两态契约）----
  const keyboardRemoved = res004b?.reply_markup === undefined;
  if (!keyboardRemoved) {
    throw new Error(
      `REAL-RICH-EDIT-004b assertion failed: reply_markup omitted but response still contains it (keyboard removal broken); response keys=[${Object.keys(res004b ?? {}).sort().join(",")}]`,
    );
  }
  probeResults["REAL-RICH-EDIT-004b"] = {
    ok: true,
    messageId: mid004b,
    keyboardRemoved,
    raw: res004b,
  };
  console.log(
    `ok   REAL-RICH-EDIT-004b: editMessageText+rich_message (omit keyboard) succeeded, keyboardRemoved=${keyboardRemoved} (hard-asserted)`,
  );
} catch (error) {
  const msg004b = String(error?.message ?? error);
  const isHard004b = msg004b.startsWith("REAL-RICH-EDIT-004b assertion failed");
  probeResults["REAL-RICH-EDIT-004b"] = {
    ok: false,
    error: msg004b,
    hardAssertionFailure: isHard004b,
  };
  if (isHard004b) {
    hardAssertFailures += 1;
    console.error(`FAIL REAL-RICH-EDIT-004b: ${msg004b}`);
  } else {
    console.log(
      `info REAL-RICH-EDIT-004b: editMessageText+rich_message (omit keyboard) failed: ${msg004b} (code=${error instanceof TelegramApiError ? error.errorCode ?? "n/a" : "n/a"})`,
    );
  }
}
try {
  const res005 = await telegramRequest(
    "editMessageText",
    {
      chat_id: chatId,
      message_id: targetMessageId,
      text: "<p><b>[REAL-RICH-EDIT-005]</b> 候选 C editMessageText+parse_mode HTML (无键盘)</p><table compact><tr><th>测试项</th><td>候选 C</td></tr><tr><th>状态</th><td>已编辑</td></tr></table>",
      parse_mode: "HTML",
    },
    TIMEOUT_MS,
    ctx,
  );
  const mid005 = parseMessageId(res005);
  probeResults["REAL-RICH-EDIT-005"] = { ok: true, messageId: mid005, raw: res005 };
  console.log(`ok   REAL-RICH-EDIT-005: editMessageText+parse_mode succeeded, result=${JSON.stringify(res005).slice(0, 150)}`);
} catch (error) {
  probeResults["REAL-RICH-EDIT-005"] = { ok: false, error: error.message };
  console.log(
    `info REAL-RICH-EDIT-005: editMessageText+parse_mode failed (预期对照失败): ${error.message} (code=${error instanceof TelegramApiError ? error.errorCode ?? "n/a" : "n/a"})`,
  );
}

console.log("");
console.log("=== Probe Evaluation Summary ===");
let winner = null;
if (probeResults["REAL-RICH-EDIT-002"]?.ok && probeResults["REAL-RICH-EDIT-003"]?.ok) {
  winner = {
    candidate: "A",
    method: "editRichMessage",
    carrier: "rich_message",
    description: "editRichMessage + rich_message.html (Candidate A, symmetric)",
  };
} else if (probeResults["REAL-RICH-EDIT-004"]?.ok) {
  winner = {
    candidate: "B",
    method: "editMessageText",
    carrier: "rich_message",
    description: "editMessageText + rich_message.html (Candidate B)",
  };
} else if (probeResults["REAL-RICH-EDIT-005"]?.ok) {
  winner = {
    candidate: "C",
    method: "editMessageText",
    carrier: "parse_mode",
    description: "editMessageText + parse_mode HTML (Candidate C)",
  };
}

console.log(`Probe Results: ${JSON.stringify(probeResults, null, 2)}`);
if (winner) {
  console.log("");
  console.log(`WINNER DETERMINED: Candidate ${winner.candidate} -> ${winner.description}`);
  console.log(`Wire method: ${winner.method}, payload carrier: ${winner.carrier}.html`);
} else {
  console.error("");
  console.error("FAIL: No candidate satisfied the probe criteria! Blocking issue.");
  process.exit(1);
}

// 键盘两态汇总（§15.2 判定规则 5）与硬断言退出码收口
const win004 = probeResults["REAL-RICH-EDIT-004"];
const win004b = probeResults["REAL-RICH-EDIT-004b"];
if (win004?.ok && win004b?.ok) {
  console.log(
    `Keyboard two-state verified: reply_markup present -> retained (004), omitted -> removed (004b keyboardRemoved=${win004b.keyboardRemoved})`,
  );
}
if (hardAssertFailures > 0) {
  console.error(
    `FAIL: ${hardAssertFailures} hard assertion(s) failed (see FAIL lines above); exiting non-zero.`,
  );
  process.exit(1);
}
console.log("ALL REAL-RICH-EDIT hard assertions passed; exit code 0.");
