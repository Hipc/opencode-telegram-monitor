// tests/e2e/bundle-smoke.test.mjs
//
// API-006: bundle 产物 import 冒烟（计划「最终验证测试任务」API-006 条目；来源：插件约定——
// 根目录 monitor.ts 是 npm tarball / 本地单文件复制 / self-update staging 三种安装路径
// 消费的同一产物，必须可被插件宿主 import() 加载）。
//
// 前置：`node scripts/build.mjs`（API-004）已执行，根目录 monitor.ts 产物存在。
// 断言：
//   1. 产物可被 dynamic import() 加载（模块不抛错）；
//   2. default 导出为函数（原入口 `export default ... satisfies Plugin` 的形态；
//      opencode 插件按 default 函数挂载）；
//   3. TelegramSessionMonitor 命名导出存在且为函数（测试契约 §2.12 依赖的命名导出，
//      tests/behavior.test.mjs 同一导出面）。
// 断言全部落在本文件，由 bun 直接执行，无内联源码。
//
// 用法：bun tests/e2e/bundle-smoke.test.mjs（cwd = 仓库根；产物 monitor.ts 必须在场）

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 本文件位于 tests/e2e/，产物在仓库根：../../monitor.ts
const artifactURL = new URL("../../monitor.ts", import.meta.url);
const artifactPath = fileURLToPath(artifactURL);

if (!existsSync(artifactPath)) {
  console.error(
    "FAIL API-006: monitor.ts artifact not found; run `node scripts/build.mjs` first",
  );
  process.exit(1);
}

let failures = 0;

// 断言 1：产物可被 import() 加载（加载失败会在此抛 ERR_MODULE_NOT_FOUND / 语法错误）
let mod;
try {
  mod = await import(artifactURL.href);
  console.log("ok   API-006: bundle artifact import() loaded without error");
} catch (error) {
  failures += 1;
  console.error(`FAIL API-006: import() of monitor.ts threw: ${error.message}`);
}

if (mod) {
  // 断言 2：default 导出为函数（satisfies Plugin 形态）
  if (typeof mod.default !== "function") {
    failures += 1;
    console.error(
      `FAIL API-006: default export is not a function (got ${typeof mod.default})`,
    );
  } else {
    console.log("ok   API-006: default export is a function (Plugin entry shape)");
  }

  // 断言 3：TelegramSessionMonitor 命名导出存在且为函数
  if (typeof mod.TelegramSessionMonitor !== "function") {
    failures += 1;
    console.error(
      `FAIL API-006: named export TelegramSessionMonitor missing (got ${typeof mod.TelegramSessionMonitor})`,
    );
  } else {
    console.log("ok   API-006: named export TelegramSessionMonitor is a function/class");
  }
}

if (failures === 0) {
  console.log("3/3 API-006 assertions passed");
  process.exit(0);
}
console.error(`API-006: ${failures}/3 assertions failed`);
process.exit(1);