import { join } from "node:path";

import type { Plugin } from "@opencode-ai/plugin";

import { OTG_DIR } from "./constants";
import { SERVICE } from "./version";
import { loadConfig, writeInitializationError } from "./config/load-config";
import { ProjectRegistryStore, registerProject } from "./registry";
import { TelegramSessionMonitor } from "./monitor";
import type { TelegramConfig } from "./types";

// NOTE: 不要从这里 re-export TelegramSessionMonitor（类）或任何其它函数/类。
// opencode 的 legacy 插件加载器（getLegacyPlugins）会遍历模块的 **全部导出**
// 并把每个函数/类都当作 server 插件调用；re-export 类会被无 new 调用，
// 抛 "Cannot call a class constructor ... without |new|"，导致整个插件加载失败
// （2026-09-02 线上事故根因）。测试需要类时直接 import src/monitor.ts。

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