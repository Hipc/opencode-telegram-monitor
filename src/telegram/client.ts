import {
  TELEGRAM_SEND_ATTEMPTS,
  TELEGRAM_SEND_TIMEOUT_MS,
} from "../constants";
import { dline } from "../diagnostics";
import { delay } from "../infra/delay";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type {
  TelegramConfig,
  ProxySpec,
  TelegramEnvelope,
} from "./types";
import { TelegramApiError } from "./api-error";

export type TransportContext = { config: TelegramConfig; signal: AbortSignal };

export async function telegramWithRetry<T>(
  method: string,
  body: Record<string, unknown>,
  ctx: TransportContext,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TELEGRAM_SEND_ATTEMPTS; attempt += 1) {
    if (ctx.signal.aborted)
      throw new Error("Plugin disposed");
    try {
      return await telegramRequest<T>(
        method,
        body,
        TELEGRAM_SEND_TIMEOUT_MS,
        ctx,
      );
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      lastError = error;
      if (error instanceof TelegramApiError && error.errorCode === 401)
        throw error;
      if (attempt === TELEGRAM_SEND_ATTEMPTS) break;
      const retryAfter =
        error instanceof TelegramApiError ? error.retryAfter : undefined;
      await delay(
        retryAfter ? retryAfter * 1_000 : 2 ** (attempt - 1) * 1_000,
      );
    }
  }
  throw lastError;
}

export async function telegramRequest<T>(
  method: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  ctx: TransportContext,
): Promise<T> {
  if (ctx.signal.aborted) throw new Error("Plugin disposed");
  const requestController = new AbortController();
  const abortRequest = () => requestController.abort();
  ctx.signal.addEventListener("abort", abortRequest, {
    once: true,
  });
  const timeout = setTimeout(abortRequest, timeoutMs);

  try {
    const url = `https://api.telegram.org/bot${ctx.config.botToken}/${method}`;
    if (ctx.config.proxy) {
      return await requestViaProxy<T>(
        url,
        body,
        requestController.signal,
        timeoutMs,
        ctx.config.proxy,
      );
    }
    return await requestDirect<T>(url, body, requestController.signal);
  } finally {
    clearTimeout(timeout);
    ctx.signal.removeEventListener("abort", abortRequest);
  }
}

export async function requestDirect<T>(
  url: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const envelope = (await response.json()) as TelegramEnvelope<T>;
  if (!response.ok || !envelope.ok || envelope.result === undefined) {
    throw new TelegramApiError(
      envelope.description ?? `Telegram HTTP ${response.status}`,
      envelope.error_code ?? response.status,
      envelope.parameters?.retry_after,
    );
  }
  return envelope.result;
}

export async function requestViaProxy<T>(
  url: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  timeoutMs: number,
  proxy: string,
): Promise<T> {
  const proxySpec = parseProxy(proxy);
  const target = new URL(url);
  const targetPort = Number(target.port) || 443;
  const payload = JSON.stringify(body);
  const methodName = target.pathname.split("/").pop() ?? "?";

  dline(`requestViaProxy[${methodName}] start`);
  const socket = await openTunnel(
    proxySpec,
    target.hostname,
    targetPort,
    signal,
    timeoutMs,
  );
  dline(`requestViaProxy[${methodName}] tunnel ok`);

  const secure = tlsConnect({ socket, servername: target.hostname });
  await new Promise<void>((resolveTLS, rejectTLS) => {
    const onAbort = () => secure.destroy(new Error("Plugin disposed"));
    const onError = (error: Error) => {
      cleanup();
      rejectTLS(error);
    };
    const onConnect = () => {
      cleanup();
      resolveTLS();
    };
    const cleanup = () => {
      secure.removeListener("secureConnect", onConnect);
      secure.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    secure.once("secureConnect", onConnect);
    secure.once("error", onError);
  });
  dline(`requestViaProxy[${methodName}] tls ok`);

  // Send the HTTP request directly over the TLS socket instead of wrapping it
  // with http.request(): using http.request({ createConnection }) over a proxy
  // CONNECT tunnel hangs (the request never completes and abort cannot reject
  // it), which kept deleteWebhook/polling stuck forever. Direct writes work
  // reliably over the tunnel (verified against the Telegram API).
  const response = await new Promise<{ status: number; body: string }>(
    (resolveResponse, reject) => {
      let responseBuffer = Buffer.alloc(0);
      let settled = false;

      const cleanup = () => {
        secure.removeListener("data", onData);
        secure.removeListener("end", onEnd);
        secure.removeListener("error", onError);
        signal.removeEventListener("abort", onAbort);
      };
      const finish = (status: number, body: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        dline(
          `requestViaProxy[${methodName}] http done status=${status} bodyLen=${body.length}`,
        );
        resolveResponse({ status, body });
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        dline(
          `requestViaProxy[${methodName}] http fail: ${(error as Error).message}`,
        );
        reject(error);
      };
      const onAbort = () => fail(new Error("Plugin disposed"));
      const onError = (error: Error) => fail(error);
      const onEnd = () => {
        dline(`requestViaProxy[${methodName}] http end`);
        // Connection: close — stream ended; parse whatever we buffered.
        if (!settled) {
          const headerEnd = responseBuffer.indexOf("\r\n\r\n");
          if (headerEnd >= 0) {
            const head = responseBuffer.toString("latin1", 0, headerEnd);
            const status =
              Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(head)?.[1]) || 0;
            finish(
              status,
              responseBuffer.subarray(headerEnd + 4).toString("utf8"),
            );
          } else {
            fail(new Error("Connection closed before HTTP response"));
          }
        }
      };
      const onData = (chunk: Buffer) => {
        responseBuffer = Buffer.concat([responseBuffer, chunk]);
        const headerEnd = responseBuffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const head = responseBuffer.toString("latin1", 0, headerEnd);
        dline(
          `requestViaProxy[${methodName}] http header (${responseBuffer.length} bytes): ${head.split("\r\n")[0]}`,
        );
        const status =
          Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(head)?.[1]) || 0;
        const contentLengthMatch = /content-length:\s*(\d+)/i.exec(head);
        const body = responseBuffer.subarray(headerEnd + 4).toString("utf8");
        if (contentLengthMatch) {
          const len = Number(contentLengthMatch[1]);
          if (Buffer.byteLength(body) >= len) {
            finish(status, body.slice(0, len));
          }
        } else if (body.length > 0 || /^HTTP\/\d(?:\.\d)?\s+204/.test(head)) {
          // Telegram always sends content-length; fall back for edge cases.
          finish(status, body);
        }
      };

      signal.addEventListener("abort", onAbort, { once: true });
      secure.on("data", onData);
      secure.on("end", onEnd);
      secure.on("error", onError);
      secure.setTimeout(timeoutMs, () =>
        fail(new Error("Telegram request timed out")),
      );
      secure.write(
        `POST ${target.pathname}${target.search} HTTP/1.1\r\n` +
          `Host: ${target.hostname}\r\n` +
          "Content-Type: application/json\r\n" +
          `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
          "Connection: close\r\n" +
          "\r\n" +
          payload,
      );
      dline(
        `requestViaProxy[${methodName}] http written, waiting for response`,
      );
    },
  );

  let envelope: TelegramEnvelope<T>;
  try {
    envelope = JSON.parse(response.body) as TelegramEnvelope<T>;
  } catch {
    throw new TelegramApiError(`Telegram HTTP ${response.status}`);
  }
  if (
    response.status < 200 ||
    response.status >= 300 ||
    !envelope.ok ||
    envelope.result === undefined
  ) {
    throw new TelegramApiError(
      envelope.description ?? `Telegram HTTP ${response.status}`,
      envelope.error_code ?? response.status,
      envelope.parameters?.retry_after,
    );
  }
  return envelope.result;
}

export function parseProxy(value: string): ProxySpec {
  const parsed = new URL(value);
  const secure = parsed.protocol === "https:";
  return {
    host: parsed.hostname,
    port: Number(parsed.port) || (secure ? 443 : 80),
    secure,
    auth: parsed.username
      ? Buffer.from(
          `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`,
        ).toString("base64")
      : undefined,
  };
}

export function openTunnel(
  proxy: ProxySpec,
  targetHost: string,
  targetPort: number,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Socket> {
  return new Promise((resolveTunnel, reject) => {
    const socket = proxy.secure
      ? tlsConnect({
          host: proxy.host,
          port: proxy.port,
          servername: proxy.host,
        })
      : netConnect({ host: proxy.host, port: proxy.port });

    let settled = false;
    let buffer = Buffer.alloc(0);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      socket.removeListener("error", onError);
      socket.removeListener("data", onData);
      socket.removeListener("end", onEnd);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onError = (error: Error) => fail(error);
    const onEnd = () =>
      fail(new Error("Proxy closed before CONNECT completed"));
    const onAbort = () => fail(new Error("Plugin disposed"));
    const onTimeout = () => fail(new Error("Proxy CONNECT timed out"));

    timer = setTimeout(onTimeout, timeoutMs);
    socket.on("error", onError);
    socket.on("end", onEnd);
    signal.addEventListener("abort", onAbort, { once: true });

    const onData = (chunk: Buffer) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        if (buffer.length > 64 * 1024)
          fail(new Error("Proxy CONNECT response too large"));
        return;
      }
      const head = buffer.toString("latin1", 0, headerEnd);
      const status =
        Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(head)?.[1]) || 0;
      if (status >= 200 && status < 300) {
        settled = true;
        cleanup();
        socket.pause();
        const leftover = buffer.subarray(headerEnd + 4);
        if (leftover.length > 0) socket.unshift(leftover);
        resolveTunnel(socket);
      } else {
        fail(
          new TelegramApiError(
            `Proxy CONNECT rejected with HTTP ${status}`,
            status || undefined,
          ),
        );
      }
    };
    socket.on("data", onData);

    const authority = `${targetHost}:${targetPort}`;
    let connectRequest = `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n`;
    if (proxy.auth) {
      connectRequest += `Proxy-Authorization: Basic ${proxy.auth}\r\n`;
    }
    connectRequest += "Proxy-Connection: keep-alive\r\n\r\n";
    socket.write(connectRequest);
  });
}
