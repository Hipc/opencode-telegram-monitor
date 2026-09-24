// tests/e2e/bundle-smoke.test.mjs
//
// API-006: bundle 产物 import 冒烟（v2 入口契约 docs/modules/opencode-v2-contract.md
// §1.1/§1.2/§5.2）。来源：插件约定——根目录 monitor.ts 是 npm tarball / 本地单文件
// 复制 / self-update staging 三种安装路径消费的同一产物，必须可被插件宿主 import()。
//
// 前置：`node scripts/build.mjs` 已执行，根目录 monitor.ts 产物存在。
// 断言：
//   1. 产物可被 dynamic import() 加载（模块不抛错）；
//   2. default 导出为 `{ id: string, setup: function }`（v2 冻结形态；v1 的
//      default 函数形态在 v2 会被加载器拒绝）；
//   3. 除 default 外没有其它函数/类导出（回归断言，2026-09-02 事故：曾 re-export
//      TelegramSessionMonitor 类，插件加载器 Object.values(mod) 遍历全部导出、
//      把类当插件无 new 调用 → 整个插件加载失败）。
//      tests/behavior.test.mjs 需要类时直接 import src/monitor.ts，不依赖产物。
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
  // 断言 2：default 导出为 { id, setup } 形态（v2 §1.1 冻结）
  const definition = mod.default;
  const isDefinition =
    definition !== null &&
    typeof definition === "object" &&
    typeof definition.id === "string" &&
    definition.id.length > 0 &&
    typeof definition.setup === "function";
  if (!isDefinition) {
    failures += 1;
    console.error(
      `FAIL API-006: default export is not a {id, setup} definition (got ${JSON.stringify(
        definition === null || typeof definition !== "object"
          ? typeof definition
          : { id: definition.id, setup: typeof definition.setup },
      )})`,
    );
  } else {
    console.log(
      `ok   API-006: default export is a {id, setup} definition (id=${definition.id})`,
    );
  }

  // 断言 3：除 default 外不得有任何函数/类导出（插件加载器会把它们逐个当插件调用）。
  const extraFunctions = Object.entries(mod)
    .filter(([key]) => key !== "default")
    .filter(([, value]) => typeof value === "function")
    .map(([key]) => key);
  if (extraFunctions.length > 0) {
    failures += 1;
    console.error(
      `FAIL API-006: extra function/class exports present: ${extraFunctions.join(", ")} ` +
        "(opencode plugin loader would call them as plugins and fail)",
    );
  } else {
    console.log(
      "ok   API-006: no function/class exports besides default (opencode-loader safe)",
    );
  }
}

if (failures === 0) {
  console.log("3/3 API-006 assertions passed");
  process.exit(0);
}
console.error(`API-006: ${failures}/3 assertions failed`);
process.exit(1);
