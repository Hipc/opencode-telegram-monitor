// tests/e2e/real-permission-record.test.mjs
//
// E2E-210 真实环境测试（用户已明确授权使用 ~/.otg/telegram.json 真实 botToken/chatId
// 发送真实 Telegram 消息；沿用 real-keyboard-channel.test.mjs 已验证的授权与脱敏纪律）。
//
// 目标：模拟插件 scanSessionQueue（src/monitor.ts:1678）对 permission 记录的发送路径
// （契约 docs/modules/sessions-relay.md §6.2/§6.3 + §13.3/§13.4）：
//   1. 读 ~/.otg/telegram.json（botToken/chatId/proxy）+ ~/.otg/projects.json，
//      取遍历顺序中最后一条 type === "permission" 的 SessionRecord（即最新落盘记录），
//      记录其所属 project path/basename 作为 projectLabel；
//   2. 完全复刻 formatSessionRecordMessage（monitor.ts:1791-1810）组消息：
//      titleLine(iconForWaitingType) + fieldTable(Type/Session) + safeText(message,300) 节选，
//      整体 limitMessage（HTML 转义由 fieldRow/paragraph 内部 escapeHtml 完成）；
//   3. 复刻 permissionEntryID（monitor.ts:1758-1782）的纯长度规则换算 entryID
//      （callback_data `otg:perm:<entryID>:<once|always|reject>` ≤64B；超限截 44 字符；
//      仍超限 → undefined → 按插件 §13.4 降级为无键盘普通消息）；
//   4. telegramRequest("sendRichMessage", { chat_id, rich_message, reply_markup }, ctx)
//      —— 与 sendMessageWithKeyboard 完全同参，复用仓库统一传输入口。
//
// 断言：telegramRequest 内部对 envelope.ok === false / HTTP 非 2xx 抛 TelegramApiError，
// 故 promise resolve 即 envelope.ok === true；另断言 result.message_id 为数字。
// 打印 message_id / request_id / type / projectLabel（request_id 非敏感可打印；
// botToken 不得打印，输出前脱敏）。
//
// 禁止：getUpdates（老插件持锁轮询，并发会 409）/ answerCallbackQuery / editMessageText。
// 只发这 1 条。无常驻进程；凭据只在内存，不落盘。
// 提醒：消息下三按钮点击后，当前运行的老插件不认识 otg:perm: 回调（转圈无响应，无害）；
// 按钮渲染正常即达成本测试目的。
//
// 传输通道（沿用 real-keyboard-channel-diag D-001/D-002 结论）：本测试进程下
// proxy CONNECT 隧道不可用、直连 api.telegram.org 可用（TUN 透明代理接管出口），
// 故显式将 proxy 置空走 telegramRequest 内部 requestDirect 分支——仍复用统一入口
// 与 TelegramApiError/envelope 处理，非手写 fetch。
//
// 用法：bun tests/e2e/real-permission-record.test.mjs（cwd = 仓库根）

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { telegramRequest } from "../../src/telegram/client.ts";
import { TelegramApiError } from "../../src/telegram/api-error.ts";
import { titleLine, fieldTable, fieldRow, paragraph } from "../../src/format/html.ts";
import {
  limitMessage,
  buildSessionPermissionKeyboard,
  iconForWaitingType,
  shortID,
  PERM_CB_PREFIX,
} from "../../src/format/format.ts";
import { safeText } from "../../src/format/redact.ts";

const TIMEOUT_MS = 30_000; // 单条请求超时；远大于正常 RTT

// ---- E2E-210 前置：加载凭据（缺失即失败，不编造） ----
// .otg 目录解析：默认 homedir()/.otg（原生 Linux bun 运行时即真实 ~/.otg）；
// 本环境 bun 经 WSL interop 运行 Windows 二进制，os.homedir() 指向 C:\Users\hipc
// （Windows 侧同名目录内容不同），且本 interop 不透传 Linux 环境变量——
// 须用第 1 个 CLI 参数显式传 UNC 路径（\\wsl.localhost\<distro>\home\<user>\.otg）
// 访问 WSL 侧真实数据目录——读的是同一批物理文件，非另一份凭据。
const argDir = process.argv[2];
const otgDir = argDir ?? join(homedir(), ".otg");
const configPath = join(otgDir, "telegram.json");
let rawConfig;
try {
  rawConfig = JSON.parse(readFileSync(configPath, "utf8"));
} catch (error) {
  console.error(`FAIL E2E-210: cannot read/parse ${configPath}: ${error.message}`);
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
    `FAIL E2E-210: missing required field(s) in ${configPath}: ${missing.map(([k]) => k).join(", ")}`,
  );
  process.exit(1);
}
console.log(
  `config loaded: chatId=${chatId}, proxy=${proxy ? "set (will be cleared for requestDirect)" : "(none)"}, botToken=<redacted len=${String(botToken).length}>`,
);

// ---- E2E-210 前置：读 projects.json，找最新一条 permission 记录 ----
const registryPath = join(otgDir, "projects.json");
let registry;
try {
  registry = JSON.parse(readFileSync(registryPath, "utf8"));
} catch (error) {
  console.error(`FAIL E2E-210: cannot read/parse ${registryPath}: ${error.message}`);
  process.exit(1);
}
// 遍历 projects[].sessions（文件顺序 = 落盘顺序），取最后一条 type === "permission"
// 的记录及其所属 entry（projectLabel = basename(entry.path)，同 scanSessionQueue:1685）。
let matched = undefined; // { record, entryPath }
for (const entry of registry?.projects ?? []) {
  for (const record of entry?.sessions ?? []) {
    if (record?.type === "permission") matched = { record, entryPath: entry.path };
  }
}
if (!matched) {
  console.error(
    `FAIL E2E-210: no type==="permission" record found in ${registryPath} (${(registry?.projects ?? []).length} project entries) — not fabricating a record`,
  );
  process.exit(1);
}
const { record, entryPath } = matched;
const projectLabel = basename(entryPath) || entryPath;
console.log(
  `record selected: request_id=${record.request_id}, type=${record.type}, projectLabel=${projectLabel}, project=${entryPath}, session_name=${record.session_name || "(empty)"}, created_at=${record.created_at}, send=${record.send}, resolved=${record.resolved}`,
);

// ---- E2E-210：完全复刻 formatSessionRecordMessage（monitor.ts:1791-1810） ----
const redactCtx = { root: entryPath, botToken }; // 同插件：safeText 去敏 ctx（botToken/路径打码）
const rows = [
  fieldRow("Type", record.type),
  fieldRow("Session", safeText(record.session_name || shortID(record.session_id), 100, redactCtx)),
];
const excerpt = paragraph(safeText(record.message, 300, redactCtx));
const text = limitMessage(
  [titleLine(iconForWaitingType(record.type), projectLabel), fieldTable(rows), excerpt].join("\n"),
);

// ---- E2E-210：复刻 permissionEntryID 纯长度规则（monitor.ts:1758-1782，契约 §13.4） ----
function permissionEntryID(requestID) {
  const full = PERM_CB_PREFIX + requestID + ":always";
  if (Buffer.byteLength(full, "utf8") <= 64) return requestID;
  const shortID44 = requestID.slice(0, 44);
  if (Buffer.byteLength(PERM_CB_PREFIX + shortID44 + ":always", "utf8") > 64) return undefined;
  return shortID44;
}
const entryID = permissionEntryID(record.request_id);
const keyboard =
  entryID === undefined
    ? undefined // 插件 §13.4 兜底：退化为无键盘普通消息
    : buildSessionPermissionKeyboard(entryID);
console.log(
  `keyboard: entryID=${entryID ?? "(undefined → send without keyboard per §13.4)"}, buttons=${keyboard ? keyboard.inline_keyboard[0].map((b) => `${b.text}→${b.callback_data}`).join(" | ") : "none"}`,
);

// ---- E2E-210：发送（与 sendMessageWithKeyboard 完全同参；requestDirect 分支） ----
const ctx = {
  config: { botToken, chatId, proxy: undefined },
  signal: new AbortController().signal,
};
console.log("transport: requestDirect branch (proxy tunnel unavailable in test process, see diag D-001/D-002)");

try {
  // envelope.ok === false / HTTP 非 2xx 时 telegramRequest 抛 TelegramApiError，
  // resolve 即 envelope.ok === true（断言 1）；message_id 为数字（断言 2）。
  const result = await telegramRequest(
    "sendRichMessage",
    {
      chat_id: chatId,
      rich_message: { html: text },
      reply_markup: keyboard,
    },
    TIMEOUT_MS,
    ctx,
  );
  const messageId = result?.message_id;
  if (typeof messageId !== "number") {
    console.error(
      `FAIL E2E-210: sendRichMessage resolved but result has no numeric message_id: ${JSON.stringify(result).slice(0, 200)}`,
    );
    process.exit(1);
  }
  console.log(`PASS E2E-210: envelope.ok === true, message_id=${messageId}`);
  console.log(`E2E-210 summary: message_id=${messageId}, request_id=${record.request_id}, type=${record.type}, projectLabel=${projectLabel}`);
  console.log(
    "NOTE: clicking the three buttons under this message is a no-op on the currently running (old) plugin — it does not recognize otg:perm: callbacks (spinner, harmless). Button rendering is the success criterion.",
  );
  process.exit(0);
} catch (error) {
  if (error instanceof TelegramApiError) {
    console.error(
      `FAIL E2E-210: TelegramApiError from sendRichMessage: code=${error.errorCode} description=${error.message}`,
    );
  } else {
    console.error(`FAIL E2E-210: sendRichMessage threw: ${error.message}`);
  }
  process.exit(1);
}
