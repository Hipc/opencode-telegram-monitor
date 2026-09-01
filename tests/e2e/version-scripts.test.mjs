// tests/e2e/version-scripts.test.mjs
//
// 版本脚本收缩契约测试（计划 docs/todos/version-from-package-json.md「最终验证测试任务」；
// 来源：本计划验收标准② + docs/modules/version-injection.md §4.1/§4.2）。
//
// 用例：
//   API-001: `node scripts/check-version.mjs <pkg.version>` exit 0，输出提及 package.json 与 README
//   API-002: `node scripts/check-version.mjs 9.9.9`        exit 1，错误信息指明 package.json/README 不符，
//            且不再提及 src/version.ts
//   API-003: 在仓库临时副本上 `node scripts/set-version.mjs 9.9.9` —— 副本内 package.json + README.md
//            更新、src/version.ts 不变；测后清理副本（不污染真仓库，契约 §4.1 约束）
// 断言全部落在本文件，无内联源码。
// 用法：node tests/e2e/version-scripts.test.mjs（cwd = 仓库根）
// 注意：必须用 node（Linux）执行而非 bun——bun 在本机是 WSL interop Windows 二进制，
// 由 bun.exe 运行会让内部 spawnSync 落入 Windows 域（见 version-injection.test.mjs 说明）。

import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const current = pkg.version; // 0.5.3

let failures = 0;
const fail = (id, msg) => {
  failures += 1;
  console.error(`FAIL ${id}: ${msg}`);
};

// ---- API-001: check-version 对当前 version exit 0，输出提及 package.json 与 README ----
{
  const run = spawnSync("node", ["scripts/check-version.mjs", current], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
  });
  const out = `${run.stdout || ""}${run.stderr || ""}`;
  if (run.error) {
    fail("API-001", `could not run: ${run.error.message}`);
  } else if (run.status !== 0) {
    fail("API-001", `check-version.mjs ${current} exited ${run.status}: ${out}`);
  } else if (!out.includes("package.json") || !out.includes("README.md")) {
    fail("API-001", `success output must mention package.json and README.md, got: ${out}`);
  } else {
    console.log(`ok   API-001: check-version.mjs ${current} exited 0, output mentions package.json + README.md`);
  }
}

// ---- API-002: check-version 对 9.9.9 exit 1，错误指明 package.json/README，不含 src/version.ts ----
{
  const run = spawnSync("node", ["scripts/check-version.mjs", "9.9.9"], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
  });
  const out = `${run.stdout || ""}${run.stderr || ""}`;
  if (run.error) {
    fail("API-002", `could not run: ${run.error.message}`);
  } else if (run.status !== 1) {
    fail("API-002", `check-version.mjs 9.9.9 must exit 1, exited ${run.status}: ${out}`);
  } else if (!out.includes("package.json") || !out.includes("README.md")) {
    fail("API-002", `error output must point at package.json and README.md, got: ${out}`);
  } else if (out.includes("src/version.ts")) {
    fail("API-002", `error output must NOT mention src/version.ts, got: ${out}`);
  } else {
    console.log("ok   API-002: check-version.mjs 9.9.9 exited 1, names package.json/README.md, no src/version.ts");
  }
}

// ---- API-003: 临时副本上 set-version.mjs 9.9.9 —— 只改 package.json + README.md，不动 src/version.ts ----
{
  const tmp = mkdtempSync(join(tmpdir(), "otg-ver-api003-"));
  try {
    // 造一个最小仓库副本：脚本只依赖 package.json、README.md、自身与 src/version.ts（验证不变性）
    mkdirSync(join(tmp, "scripts"), { recursive: true });
    cpSync(join(root, "package.json"), join(tmp, "package.json"));
    cpSync(join(root, "README.md"), join(tmp, "README.md"));
    cpSync(join(root, "scripts", "set-version.mjs"), join(tmp, "scripts", "set-version.mjs"));
    if (existsSync(join(root, "src", "version.ts"))) {
      mkdirSync(join(tmp, "src"), { recursive: true });
      cpSync(join(root, "src", "version.ts"), join(tmp, "src", "version.ts"));
    }
    const versionTsBefore = existsSync(join(tmp, "src", "version.ts"))
      ? readFileSync(join(tmp, "src", "version.ts"), "utf8")
      : null;

    const run = spawnSync("node", ["scripts/set-version.mjs", "9.9.9"], {
      cwd: tmp,
      encoding: "utf8",
      timeout: 15_000,
    });
    const out = `${run.stdout || ""}${run.stderr || ""}`;
    if (run.error) {
      fail("API-003", `could not run: ${run.error.message}`);
    } else if (run.status !== 0) {
      fail("API-003", `set-version.mjs 9.9.9 exited ${run.status}: ${out}`);
    } else {
      const pkgAfter = JSON.parse(readFileSync(join(tmp, "package.json"), "utf8"));
      const readmeAfter = readFileSync(join(tmp, "README.md"), "utf8");
      const versionTsAfter = versionTsBefore
        ? readFileSync(join(tmp, "src", "version.ts"), "utf8")
        : null;

      let api003Ok = true;
      if (pkgAfter.version !== "9.9.9") {
        fail("API-003", `copy package.json version = ${pkgAfter.version}, expected 9.9.9`);
        api003Ok = false;
      }
      if (!readmeAfter.includes("opencode-telegram-monitor@9.9.9")) {
        fail("API-003", "copy README.md npm install pin was not updated to 9.9.9");
        api003Ok = false;
      }
      if (versionTsBefore !== null) {
        if (versionTsAfter !== versionTsBefore) {
          fail("API-003", "copy src/version.ts was modified; set-version must not touch it");
          api003Ok = false;
        } else if (versionTsAfter.includes("9.9.9")) {
          fail("API-003", "copy src/version.ts now contains 9.9.9");
          api003Ok = false;
        }
      } else if (existsSync(join(tmp, "src", "version.ts"))) {
        fail("API-003", "set-version created src/version.ts in the copy (must not exist as a version source)");
        api003Ok = false;
      }
      if (api003Ok) {
        console.log("ok   API-003: set-version.mjs 9.9.9 on temp copy updated package.json + README.md, src/version.ts untouched");
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    if (!existsSync(tmp)) {
      console.log("ok   API-003: temp copy cleaned up");
    } else {
      fail("API-003", `temp copy cleanup failed, ${tmp} still exists`);
    }
  }
}

if (failures === 0) {
  console.log("3/3 API-001/002/003 assertions passed");
  process.exit(0);
}
console.error(`version-scripts: ${failures} failures`);
process.exit(1);