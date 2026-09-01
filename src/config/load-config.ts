import { readFile } from "node:fs/promises";
import type { PluginInput } from "@opencode-ai/plugin";
import type { TelegramConfig } from "../types";
import { SERVICE } from "../version";

export async function loadConfig(
  configPath: string,
): Promise<TelegramConfig | undefined> {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }

  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Telegram config must be a JSON object");
  }

  const config = value as Record<string, unknown>;
  if (
    typeof config.botToken !== "string" ||
    !/^\d+:[A-Za-z0-9_-]{20,}$/.test(config.botToken)
  ) {
    throw new Error("Telegram config has an invalid botToken");
  }
  if (typeof config.chatId !== "string" || !/^\d+$/.test(config.chatId)) {
    throw new Error("Telegram config has an invalid chatId");
  }
  let proxy: string | undefined;
  if (config.proxy !== undefined) {
    if (typeof config.proxy !== "string") {
      throw new Error("Telegram config has an invalid proxy");
    }
    try {
      const parsed = new URL(config.proxy);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("unsupported protocol");
      }
      proxy = config.proxy;
    } catch {
      throw new Error("Telegram config has an invalid proxy");
    }
  }

  return {
    botToken: config.botToken,
    chatId: config.chatId,
    proxy,
  };
}

export function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === "ENOENT"
  );
}

export async function writeInitializationError(
  client: PluginInput["client"],
  message: string,
): Promise<void> {
  try {
    await client.app.log({
      body: {
        service: SERVICE,
        level: "error",
        message,
      },
    });
  } catch {
    console.error(`[${SERVICE}] ${message}`);
  }
}
