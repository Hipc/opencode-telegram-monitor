// tests/e2e/version-injection.test.mjs
//
// E2E-001: 构建产物版本注入实证（计划 docs/todos/version-from-package-json.md「最终验证
// 测试任务」E2E-001；来源：本计划验收标准① + docs/modules/version-injection.md §3.1/§3.3）。
//
// 断言：
//   1. `node scripts/build.mjs`（cwd = 仓库根）exit 0；
//   2. 产物根目录 monitor.ts 含 `var PLUGIN_VERSION = "<pkg.version>";`（== package.json
//      version，--define 注入真实生效，不是凭语义推断）；
//   3. 产物不再含 dev fallback 字符串 "0.0.0-dev"（define 生效后 typeof 守卫被常量折叠，
//      残留即注入失败信号）。
// 断言全部落在本文件，无内联源码。
// 用法：node tests/e2e/version-injection.test.mjs（cwd = 仓库根）
// 注意：必须用 node（Linux）执行而非 bun——bun 在本机是 WSL interop Windows 二进制，
// 若由 bun.exe 运行本文件，内部 spawnSync("bun")（build.mjs 依赖）会在 Windows PATH
// 找不到可执行文件而 ENOENT。
// 产物 monitor.ts 是 gitignore 的构建产物，测试后无需清理。

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const expected = pkg.version;

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`FAIL E2E-001: ${msg}`);
};

// 断言 1：构建脚本 exit 0（cwd = 仓库根；build.mjs 内部以相对路径调 bun）
const build = spawnSync("node", ["scripts/build.mjs"], {
  cwd: root,
  encoding: "utf8",
  timeout: 60_000,
});
if (build.error) {
  fail(`node scripts/build.mjs could not run: ${build.error.message}`);
} else if (build.status !== 0) {
  fail(`node scripts/build.mjs exited ${build.status}: ${build.stderr || build.stdout}`);
} else {
  console.log(`ok   E2E-001: node scripts/build.mjs exited 0 (${(build.stdout || "").trim()})`);
}

// 断言 2：产物含 `var PLUGIN_VERSION = "<pkg.version>";`（== package.json version）
const artifact = readFileSync(new URL("../../monitor.ts", import.meta.url), "utf8");
const needle = `var PLUGIN_VERSION = "${expected}";`;
if (!artifact.includes(needle)) {
  fail(`monitor.ts missing literal ${needle} (injection not effective)`);
} else {
  console.log(`ok   E2E-001: monitor.ts contains ${needle}`);
}

// 断言 3：产物不含 dev fallback 字符串（注入生效则被折叠）
if (artifact.includes("0.0.0-dev")) {
  fail("monitor.ts still contains dev fallback \"0.0.0-dev\" (define did not fold the guard)");
} else {
  console.log("ok   E2E-001: monitor.ts has no 0.0.0-dev fallback residue");
}

if (failures === 0) {
  console.log("3/3 E2E-001 assertions passed");
  process.exit(0);
}
console.error(`E2E-001: ${failures}/3 assertions failed`);
process.exit(1);