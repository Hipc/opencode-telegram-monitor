import { join } from "node:path";

import { OTG_DIR } from "./constants";
import { SERVICE } from "./version";
import { loadConfig, writeInitializationError } from "./config/load-config";
import { dline } from "./diagnostics";
import { errorCategory } from "./format";
import { ProjectRegistryStore, registerProject } from "./registry";
import { TelegramSessionMonitor } from "./monitor";
import type { TelegramConfig } from "./types";
import type { V2Client } from "./v2/types";

// NOTE: 不要从这里 re-export TelegramSessionMonitor（类）或任何其它函数/类。
// opencode 的插件加载器会遍历模块的 **全部导出** 并把每个函数/类都当作插件
// 调用；re-export 类会被无 new 调用，抛 "Cannot call a class constructor ...
// without |new|"，导致整个插件加载失败（2026-09-02 线上事故根因）。
// 测试需要类时直接 import src/monitor.ts。
//
// v2 入口契约（docs/modules/opencode-v2-contract.md §1.2，冻结）：
//   default export = { id, setup }；setup 每次激活调用一次，可返回 dispose。
//   setup 参数是 promise 返回包装的 V2Client（本地类型 §4.1）。
//   root = client.location.directory（§1.5）；envelope 原样交给 accept()（§1.6）。

export default {
  id: "telegram-session-monitor",
  async setup(client: V2Client) {
    const root = client.location?.directory;
    if (typeof root !== "string" || root.length === 0) {
      // §1.5 冻结：root 唯一来源是 client.location.directory。缺失即宿主契约
      // 违规，明确失败并保留原因，不做任何猜测/兜底。
      throw new Error(
        "telegram-session-monitor: client.location.directory is missing (opencode v2 setup contract violated)",
      );
    }

    const otgDir = OTG_DIR;
    const configPath = join(otgDir, "telegram.json");

    let config: TelegramConfig | undefined;
    try {
      config = await loadConfig(configPath);
    } catch (error) {
      const category =
        error instanceof SyntaxError ? "invalid JSON" : "invalid configuration";
      writeInitializationError(`Telegram plugin disabled: ${category}`);
      return;
    }

    if (!config) return;
    const telegramConfig = config;

    const registry = new ProjectRegistryStore(
      join(otgDir, "projects.json"),
      (message) => {
        dline(`[warn] ${message}`);
        console.warn(`[${SERVICE}] ${message}`);
      },
    );
    try {
      await registry.ensureDir();
      await registry.mutate((reg) => registerProject(reg, root));
    } catch (error) {
      writeInitializationError(
        `Telegram plugin disabled: cannot initialize ~/.otg registry: ${(error as Error).message}`,
      );
      return;
    }

    const monitor = new TelegramSessionMonitor(
      client,
      telegramConfig,
      root,
      registry,
    );
    monitor.initialize();

    // 长活 async iterator（§1.2）：逐条把原始 v2 envelope 交给 accept()，
    // 直到 shutdown/reload 时 host 结束流。dispose 经 AbortController 标记，
    // 实际停流由 host 保证（探针实测 probe.dispose → event-stream.ended）。
    const abort = new AbortController();
    void (async () => {
      try {
        for await (const event of client.event.subscribe()) monitor.accept(event);
        dline("event stream ended");
      } catch (error) {
        // 流结束/异常都记录（不吞不抛）：dispose 场景由 host 结束流。
        dline(
          `event stream error: ${errorCategory(error, { root, botToken: telegramConfig.botToken })}`,
        );
        console.error(
          `[${SERVICE}] event stream error: ${(error as Error).message}`,
        );
      }
    })();

    // dispose 等价物（§1.4）：中止订阅迭代 + monitor.dispose()（幂等、清定时器、
    // 释放 poller.lock、await 在途任务；不动用户配置/注册表）。
    return () => {
      abort.abort();
      void monitor.dispose();
    };
  },
};
