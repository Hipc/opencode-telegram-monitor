import { join } from "node:path";

import type { Plugin } from "@opencode-ai/plugin";

import { OTG_DIR } from "./constants";
import { SERVICE } from "./version";
import { loadConfig, writeInitializationError } from "./config/load-config";
import { ProjectRegistryStore, registerProject } from "./registry";
import { TelegramSessionMonitor } from "./monitor";
import type { TelegramConfig } from "./types";

export { TelegramSessionMonitor } from "./monitor";

export default (async ({ client, directory, worktree }) => {
  const root = worktree === "/" ? directory : worktree;
  const otgDir = OTG_DIR;
  const configPath = join(otgDir, "telegram.json");

  let config: TelegramConfig | undefined;
  try {
    config = await loadConfig(configPath);
  } catch (error) {
    const category =
      error instanceof SyntaxError ? "invalid JSON" : "invalid configuration";
    await writeInitializationError(
      client,
      `Telegram plugin disabled: ${category}`,
    );
    return {};
  }

  if (!config) return {};

  const registry = new ProjectRegistryStore(
    join(otgDir, "projects.json"),
    (message) =>
      client.app.log({
        body: { service: SERVICE, level: "warn", message },
      }),
  );
  try {
    await registry.ensureDir();
    await registry.mutate((reg) => registerProject(reg, root));
  } catch (error) {
    await writeInitializationError(
      client,
      `Telegram plugin disabled: cannot initialize ~/.otg registry: ${(error as Error).message}`,
    );
    return {};
  }

  const monitor = new TelegramSessionMonitor(client, config, root, registry);
  monitor.initialize();

  return {
    event: async ({ event }) => {
      monitor.accept(event);
    },
    dispose: () => monitor.dispose(),
  };
}) satisfies Plugin;