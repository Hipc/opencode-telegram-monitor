#!/usr/bin/env node
// Fake Telegram Bot API endpoint for the t09-dupe-fix container scenario.
//
// Runs in the otg-toolchain container on the scenario's docker network and
// speaks the exact transport the plugin uses (src/telegram/client.ts
// requestViaProxy): a plain-HTTP CONNECT "proxy" that answers
// `200 Connection established` and then terminates TLS on the same socket with
// a test certificate for api.telegram.org, replying to each Bot API POST with
// a Telegram envelope `{"ok":true,"result":...}`.
//
// This is test-only infrastructure, not a product fallback: it exists so the
// duplicate-record scenario can observe *successful* sends (and the message_id
// the plugin must persist) without a real bot token or any real Telegram
// traffic. The scenario container opts into the test certificate via
// NODE_TLS_REJECT_UNAUTHORIZED=0 (container-local env; never product code).
//
// Every request is appended to T09_FAKE_TG_LOG as one JSON line:
//   {at, method, target, message_id, chat_id, html}
// (`html` = rich_message.html of send calls, i.e. the rendered record text —
// used by the assertions to identify which request_id a send belongs to).
//
// Env:
//   T09_FAKE_TG_PORT           listen port (default 8443)
//   T09_FAKE_TG_CERT/KEY       PEM paths for the api.telegram.org test cert
//   T09_FAKE_TG_LOG            JSONL request log path
//   T09_FAKE_TG_POLL_DELAY_MS  getUpdates hold time (default 2000; avoids a
//                              hot poll loop when answering immediately)
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createServer as createNetServer } from "node:net";
import { TLSSocket, createSecureContext } from "node:tls";

const PORT = Number(process.env.T09_FAKE_TG_PORT ?? 8443);
const LOG = process.env.T09_FAKE_TG_LOG ?? "/evidence/fake-telegram.jsonl";
const CERT = process.env.T09_FAKE_TG_CERT;
const KEY = process.env.T09_FAKE_TG_KEY;
const POLL_DELAY_MS = Number(process.env.T09_FAKE_TG_POLL_DELAY_MS ?? 2000);

if (!CERT || !KEY) {
  console.error("fake-telegram: T09_FAKE_TG_CERT and T09_FAKE_TG_KEY required");
  process.exit(1);
}
const secureContext = createSecureContext({
  cert: readFileSync(CERT),
  key: readFileSync(KEY),
});

let nextMessageID = 9000;

function log(entry) {
  mkdirSync(dirname(LOG), { recursive: true });
  appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
}

function respond(socket, result, delayMs) {
  const payload = JSON.stringify({ ok: true, result });
  const write = () => {
    if (socket.destroyed) return;
    socket.write(
      "HTTP/1.1 200 OK\r\n" +
        "Content-Type: application/json\r\n" +
        `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
        "Connection: close\r\n\r\n" +
        payload,
    );
    socket.end();
  };
  if (delayMs > 0) setTimeout(write, delayMs);
  else write();
}

function handleRequest(socket, head, body, target) {
  const requestLine = head.split("\r\n")[0] ?? "";
  const pathMatch = /^POST\s+(\S+)\s+HTTP\/1\.[01]$/.exec(requestLine);
  const path = pathMatch ? pathMatch[1] : requestLine;
  const method = path.split("/").pop() ?? "?";
  let parsedBody;
  try {
    parsedBody = body.length > 0 ? JSON.parse(body) : undefined;
  } catch {
    parsedBody = undefined;
  }
  let result;
  let delayMs = 0;
  if (method === "getUpdates") {
    result = [];
    delayMs = POLL_DELAY_MS;
  } else if (method === "sendRichMessage" || method === "sendMessage") {
    nextMessageID += 1;
    result = { message_id: nextMessageID };
  } else {
    result = true;
  }
  const isMessageResult =
    result !== null &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    typeof result.message_id === "number";
  log({
    at: new Date().toISOString(),
    method,
    target,
    message_id: isMessageResult ? result.message_id : undefined,
    chat_id: parsedBody?.chat_id,
    html: parsedBody?.rich_message?.html,
  });
  respond(socket, result, delayMs);
}

function attachHttp(tlsSocket, target) {
  let buffer = Buffer.alloc(0);
  tlsSocket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const head = buffer.subarray(0, headerEnd).toString("latin1");
      const contentLength = Number(
        /content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0,
      );
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + contentLength) return;
      const body = buffer
        .subarray(bodyStart, bodyStart + contentLength)
        .toString("utf8");
      buffer = buffer.subarray(bodyStart + contentLength);
      handleRequest(tlsSocket, head, body, target);
    }
  });
  tlsSocket.on("error", (error) =>
    log({ at: new Date().toISOString(), event: "tls_error", error: String(error) }),
  );
}

const server = createNetServer((socket) => {
  let buffer = "";
  let upgraded = false;
  const onData = (chunk) => {
    if (upgraded) return;
    buffer += chunk.toString("latin1");
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const head = buffer.slice(0, headerEnd);
    const leftover = buffer.slice(headerEnd + 4);
    const first = head.split("\r\n")[0] ?? "";
    const match = /^CONNECT\s+(\S+)\s+HTTP\/1\.[01]$/.exec(first);
    if (!match) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.end();
      return;
    }
    socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
    upgraded = true;
    socket.removeListener("data", onData);
    socket.pause();
    if (leftover.length > 0) socket.unshift(Buffer.from(leftover, "latin1"));
    const tlsSocket = new TLSSocket(socket, {
      isServer: true,
      secureContext,
    });
    log({ at: new Date().toISOString(), event: "connect", target: match[1] });
    attachHttp(tlsSocket, match[1]);
    tlsSocket.on("secure", () =>
      log({ at: new Date().toISOString(), event: "tls_ok", target: match[1] }),
    );
  };
  socket.on("data", onData);
  socket.on("error", () =>
    log({ at: new Date().toISOString(), event: "socket_error" }),
  );
});

server.listen(PORT, "0.0.0.0", () => {
  log({ at: new Date().toISOString(), event: "listening", port: PORT });
  console.log(`fake-telegram: listening on 0.0.0.0:${PORT}`);
});
