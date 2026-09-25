#!/usr/bin/env bun
// t13 unit tests: telegramWithRetry permanent-error handling.
//
// Field evidence: 55/70 answerCallbackQuery calls in the incident window were
// HTTP 400 ("query is too old" class) and were retried 3x each, amplifying a
// single tap into 6-18 API calls / 30-73s and delaying the serial poll loop.
// 400 is permanent — retrying it can never succeed.
//
// Frozen semantics after t13:
//   - 400 and 401 throw on the first attempt (no delay, no retry);
//   - 429 retries using retry_after;
//   - 5xx and network errors keep the bounded retry (TELEGRAM_SEND_ATTEMPTS).
//
// Run: HOME=$(mktemp -d) bun tests/telegram-retry.test.mjs
import { TelegramApiError } from "../src/telegram/api-error.ts";

const clientModule = await import(
  new URL("../src/telegram/client.ts", import.meta.url).href
);
const { telegramWithRetry } = clientModule;

const realFetch = globalThis.fetch;
let failures = 0;
let total = 0;

async function runCase(name, fn) {
  total += 1;
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error.message}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const ctx = {
  config: { botToken: "123456789:TESTTOKEN_DO_NOT_USE", chatId: "123" },
  signal: new AbortController().signal,
};

function installFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options?.body });
    return handler(calls.length);
  };
  return calls;
}

// TRY-1: HTTP 400 is permanent -> exactly one attempt, no retry delay.
await runCase("TRY-1 400 throws immediately with a single attempt", async () => {
  const calls = installFetch(() =>
    response(400, {
      ok: false,
      error_code: 400,
      description:
        "Bad Request: query is too old and response timeout expired or query ID is invalid",
    }),
  );
  const started = Date.now();
  let caught;
  try {
    await telegramWithRetry("answerCallbackQuery", { callback_query_id: "1" }, ctx);
  } catch (error) {
    caught = error;
  }
  const elapsed = Date.now() - started;
  if (!(caught instanceof TelegramApiError) || caught.errorCode !== 400) {
    throw new Error(`expected TelegramApiError(400), got ${caught}`);
  }
  if (calls.length !== 1) {
    throw new Error(`400 must not be retried: attempts=${calls.length}`);
  }
  if (elapsed > 500) {
    throw new Error(`400 must throw without retry delay: ${elapsed}ms`);
  }
});

// TRY-2: 401 stays permanent (existing behavior).
await runCase("TRY-2 401 throws immediately with a single attempt", async () => {
  const calls = installFetch(() =>
    response(401, { ok: false, error_code: 401, description: "Unauthorized" }),
  );
  let caught;
  try {
    await telegramWithRetry("sendRichMessage", { chat_id: 1 }, ctx);
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof TelegramApiError) || caught.errorCode !== 401) {
    throw new Error(`expected TelegramApiError(401), got ${caught}`);
  }
  if (calls.length !== 1) {
    throw new Error(`401 must not be retried: attempts=${calls.length}`);
  }
});

// TRY-3: 429 keeps retrying and honours retry_after (tiny value in test).
await runCase("TRY-3 429 retries with retry_after and succeeds", async () => {
  const calls = installFetch((attempt) =>
    attempt === 1
      ? response(429, {
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 0.001",
          parameters: { retry_after: 0.001 },
        })
      : response(200, { ok: true, result: { message_id: 7 } }),
  );
  const result = await telegramWithRetry("sendMessage", { chat_id: 1 }, ctx);
  if (result?.message_id !== 7) {
    throw new Error(`expected retry success result, got ${JSON.stringify(result)}`);
  }
  if (calls.length !== 2) {
    throw new Error(`429 must retry exactly once here: attempts=${calls.length}`);
  }
});

// TRY-4: 5xx keeps the bounded retry (3 attempts, then success on the last).
await runCase("TRY-4 5xx retries up to the bounded attempts and succeeds", async () => {
  const calls = installFetch((attempt) =>
    attempt < 3
      ? response(500, { ok: false, error_code: 500, description: "Internal Server Error" })
      : response(200, { ok: true, result: { ok: true } }),
  );
  const result = await telegramWithRetry("sendMessage", { chat_id: 1 }, ctx);
  if (result?.ok !== true) {
    throw new Error(`expected retry success result, got ${JSON.stringify(result)}`);
  }
  if (calls.length !== 3) {
    throw new Error(`5xx must retry to the attempt cap: attempts=${calls.length}`);
  }
});

// TRY-5: network errors keep retrying too.
await runCase("TRY-5 network error retries and succeeds on the next attempt", async () => {
  const calls = installFetch((attempt) => {
    if (attempt === 1) throw new Error("ECONNRESET");
    return response(200, { ok: true, result: { ok: true } });
  });
  const result = await telegramWithRetry("sendMessage", { chat_id: 1 }, ctx);
  if (result?.ok !== true) {
    throw new Error(`expected retry success result, got ${JSON.stringify(result)}`);
  }
  if (calls.length !== 2) {
    throw new Error(`network error must retry: attempts=${calls.length}`);
  }
});

console.log(`\n${total - failures}/${total} cases passed`);
process.exit(failures === 0 ? 0 : 1);
