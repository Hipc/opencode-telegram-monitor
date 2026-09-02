// tests/e2e/real-keyboard-channel-diag.test.mjs
//
// 传输层诊断对照（诊断目标：主测试 real-keyboard-channel.test.mjs 三条全部
// "Client network socket disconnected before secure TLS connection was established"
// 且 ~/.otg/tgdiag.log 零 requestViaProxy 条目 → 怀疑测试进程走了 requestDirect
// （fetch 直连，无 dline 日志）而非 proxy 隧道；真实插件进程同一时刻经 proxy 正常）。
//
// 用 client.ts 导出的底层函数做 A/B 对照（只调 getMe：只读、不影响轮询锁、
// 不触发 getUpdates 409、不向 TG 发消息）：
//   - D-001: requestDirect("getMe") —— 预期失败（直连被网络环境切断）→ 证明必须走 proxy
//   - D-002: requestViaProxy("getMe") —— 预期成功（proxy CONNECT + 内层 TLS 可用）
// 另打印 OTG_DIR/DIAG_PATH 解析结果，核对 dline 日志写到哪里。
//
// 用法：bun tests/e2e/real-keyboard-channel-diag.test.mjs（cwd = 仓库根）

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { requestDirect, requestViaProxy } from "../../src/telegram/client.ts";
import { TelegramApiError } from "../../src/telegram/api-error.ts";
import { OTG_DIR, DIAG_PATH } from "../../src/constants.ts";

const TIMEOUT_MS = 30_000;

console.log(`homedir()=${homedir()}`);
console.log(`OTG_DIR=${OTG_DIR}`);
console.log(`DIAG_PATH=${DIAG_PATH}`);

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
if (typeof botToken !== "string" || typeof chatId !== "string") {
  console.error("FAIL: missing botToken/chatId in config");
  process.exit(1);
}
console.log(
  `config loaded: chatId=${chatId}, proxy=${proxy ? "set" : "(none)"}` +
    (proxy
      ? `, proxy.host=${new URL(proxy).hostname}, proxy.port=${new URL(proxy).port}, proxy.protocol=${new URL(proxy).protocol}`
      : "") +
    `, botToken=<redacted len=${botToken.length}>`,
);

const signal = new AbortController().signal;
let failures = 0;

// ---- D-001：requestDirect（fetch 直连）对照 —— 记录性断言：预期失败并记录错误 ----
try {
  const me = await requestDirect(
    `https://api.telegram.org/bot${botToken}/getMe`,
    {},
    signal,
  );
  console.log(
    `ok   D-001: requestDirect getMe unexpectedly SUCCEEDED (id=${me?.id}, username=@${me?.username}) — direct egress works here`,
  );
} catch (error) {
  const desc =
    error instanceof TelegramApiError
      ? `TelegramApiError code=${error.errorCode} ${error.message}`
      : error.message;
  console.log(`info D-001: requestDirect getMe failed as expected: ${desc}`);
}

// ---- D-002：requestViaProxy（CONNECT 隧道）—— 预期成功 ----
if (!proxy) {
  console.error("FAIL D-002: no proxy configured; cannot test tunnel path");
  failures += 1;
} else {
  try {
    const me = await requestViaProxy(
      `https://api.telegram.org/bot${botToken}/getMe`,
      {},
      signal,
      TIMEOUT_MS,
      proxy,
    );
    console.log(
      `ok   D-002: requestViaProxy getMe succeeded (id=${me?.id}, username=@${me?.username}) — tunnel path works under bun CLI`,
    );
  } catch (error) {
    failures += 1;
    const desc =
      error instanceof TelegramApiError
        ? `TelegramApiError code=${error.errorCode} ${error.message}`
        : error.message;
    console.error(`FAIL D-002: requestViaProxy getMe failed: ${desc}`);
  }
}

process.exit(failures === 0 ? 0 : 1);
