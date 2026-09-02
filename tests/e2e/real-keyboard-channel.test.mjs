// tests/e2e/real-keyboard-channel.test.mjs
//
// 真实环境诊断测试（用户已明确授权使用 ~/.otg/telegram.json 真实 botToken/chatId/proxy
// 发送真实 Telegram 消息，仅限本次诊断——覆盖 AGENTS.md「不用真实凭据」默认纪律）。
//
// 诊断目标：插件 permission 按钮消息经 sendRichMessage（非官方 Bot API 方法名）+
// reply_markup 发送（src/monitor.ts sendMessageWithKeyboard），但用户真实 TG 收到的消息
// 没有按钮。本测试用真实凭据对比两条通道：
//   - E2E-201：sendRichMessage + reply_markup（插件当前使用的非官方方法名）
//   - E2E-202：官方 sendMessage + parse_mode HTML + reply_markup（对照通道）
//   - E2E-203：纯文本 sendMessage（对照/兜底）
//
// 断言：每条请求成功返回（telegramRequest 内部对 envelope.ok === false /
// HTTP 非 2xx 抛 TelegramApiError，故 promise resolve 即 HTTP ok）；记录并打印
// message_id。若某方法返回 404/方法不存在，该条断言失败并如实报告——
// 这本身就是关键诊断结论。
//
// 注意：
//   - reply_markup 是否真的让 TG 显示按钮无法从 API 响应判断，需用户肉眼确认：
//     E2E-201 下方有无按钮、E2E-202 下方有无按钮。
//   - 禁止调用 getUpdates（老插件正在持锁轮询，并发 getUpdates 会 409 冲突）。
//     禁止 answerCallbackQuery / editMessageText。只发这 3 条。
//   - 凭据只在内存，不得打印 botToken（输出前脱敏）。
//
// 用法：bun tests/e2e/real-keyboard-channel.test.mjs（cwd = 仓库根）

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { telegramRequest } from "../../src/telegram/client.ts";
import { TelegramApiError } from "../../src/telegram/api-error.ts";

const TIMEOUT_MS = 30_000; // 单条请求超时；远大于正常 RTT，覆盖 proxy CONNECT 建隧道耗时

// ---- 凭据加载（缺失即失败，不编造） ----
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

// 传输通道说明（依据 real-keyboard-channel-diag.test.mjs D-001/D-002 诊断结论）：
// 本测试进程下 proxy CONNECT 隧道（http://<tailscale-ip>:7890）内层 TLS 握手被断
// （D-002 FAIL），而直连 api.telegram.org 可用（D-001 getMe OK，TUN 透明代理接管出口）。
// 故此处显式将 proxy 置空，走 telegramRequest 内部的 requestDirect 分支——仍复用仓库
// 统一传输入口与 TelegramApiError/envelope 处理，非手写 fetch。
const ctx = { config: { botToken, chatId, proxy: undefined }, signal: new AbortController().signal };
console.log("transport: requestDirect branch (proxy tunnel unavailable in test process, see diag D-001/D-002)");

let failures = 0;

// 每条消息独立 try/catch：一条失败不阻断后续对照通道（诊断需要三条各自的结果）。
async function sendAndReport(testId, method, body) {
  try {
    const result = await telegramRequest(method, body, TIMEOUT_MS, ctx);
    const messageId = result?.message_id;
    if (typeof messageId !== "number") {
      failures += 1;
      console.error(
        `FAIL ${testId}: ${method} resolved but result has no numeric message_id: ${JSON.stringify(result).slice(0, 200)}`,
      );
      return;
    }
    console.log(`ok   ${testId}: ${method} sent, message_id=${messageId}`);
  } catch (error) {
    failures += 1;
    if (error instanceof TelegramApiError) {
      console.error(
        `FAIL ${testId}: TelegramApiError from ${method}: code=${error.errorCode} description=${error.message}`,
      );
    } else {
      console.error(`FAIL ${testId}: ${method} threw: ${error.message}`);
    }
  }
}

// ---- E2E-201：sendRichMessage + reply_markup（插件当前使用的非官方方法名） ----
await sendAndReport("E2E-201", "sendRichMessage", {
  chat_id: chatId,
  rich_message: {
    html: "<b>[E2E-201]</b> sendRichMessage + reply_markup 键盘测试\n若此消息下方出现按钮，说明该通道支持键盘",
  },
  reply_markup: {
    inline_keyboard: [[{ text: "TEST-A 按钮", callback_data: "otg:test:e2e201" }]],
  },
});

// ---- E2E-202：官方 sendMessage + parse_mode HTML + reply_markup（对照通道） ----
await sendAndReport("E2E-202", "sendMessage", {
  chat_id: chatId,
  text: "<b>[E2E-202]</b> 官方 sendMessage + parse_mode HTML + reply_markup 键盘测试\n若此消息下方出现按钮，说明应换用官方通道",
  parse_mode: "HTML",
  reply_markup: {
    inline_keyboard: [[{ text: "TEST-B 按钮", callback_data: "otg:test:e2e202" }]],
  },
});

// ---- E2E-203：纯文本 sendMessage 对照/兜底 ----
await sendAndReport("E2E-203", "sendMessage", {
  chat_id: chatId,
  text: "[E2E-203] 纯文本 sendMessage 对照",
});

// ---- 收口 ----
console.log(
  failures === 0
    ? "3/3 E2E-201/202/203 HTTP assertions passed; button visibility requires human verification in TG"
    : `${failures}/3 tests failed (see FAIL lines above)`,
);
process.exit(failures === 0 ? 0 : 1);
