#!/usr/bin/env node
// Bundles the src/ sources into the single-file root `monitor.ts` artifact
// that every install path consumes (npm tarball, local-file copy, self-update
// staging). Run this before publishing or copying a local install:
//
//   node scripts/build.mjs
//
// After building, the artifact must report the package version from
// package.json in its `PLUGIN_VERSION` declaration — a broken artifact can
// never be released. Note on the declaration keyword: bun's bundler hoists
// module-scope bindings as `var` (e.g. `var PLUGIN_VERSION = "0.5.3";`), so a
// missing/wrong version exits 1, while the plugin's self-update literal
// (`const PLUGIN_VERSION = "..."`, checked by applyVersionUpdate on the staged
// tarball) is verified separately and only warned about if absent.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`build: ${message}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// 1) Bundle src/index.ts -> root monitor.ts (no minify; the opencode runtime
//    packages stay external — they are provided by the plugin host). Uses
//    paths relative to the repo root, matching the historical `bun build`
//    invocations of this project.
const build = spawnSync(
  "bun",
  [
    "build",
    "--target",
    "node",
    "--external",
    "@opencode-ai/plugin",
    "--external",
    "@opencode-ai/sdk",
    "src/index.ts",
    "--outfile",
    "monitor.ts",
  ],
  { cwd: root, stdio: "inherit" },
);
if (build.error) {
  fail(`could not run bun: ${build.error.message}`);
}
if (build.status !== 0) {
  fail(`bun build failed (exit code ${build.status})`);
}

const artifact = readFileSync(join(root, "monitor.ts"), "utf8");

// 2) Hard gate: the artifact must declare the package version. bun emits
//    `var PLUGIN_VERSION = "x.y.z";` at module scope (const is hoisted), so
//    accept either keyword as long as the quoted value matches package.json.
const declaration = artifact.match(/PLUGIN_VERSION = "([^"]+)";/);
if (!declaration) {
  fail("monitor.ts: PLUGIN_VERSION declaration not found in bundle output");
}
if (declaration[1] !== pkg.version) {
  fail(
    `monitor.ts bundle reports PLUGIN_VERSION ${declaration[1]}, expected ${pkg.version} from package.json`,
  );
}

// 3) Self-update compatibility: the plugin's applyVersionUpdate verifies the
//    staged tarball with `staged.includes('const PLUGIN_VERSION = "<v>"')`.
//    bun's bundler turns the exported const into `var`, so that literal is
//    normally absent from the bundle — self-update would reject this artifact
//    until the check is widened or the package.json fallback is adopted.
if (!/const PLUGIN_VERSION = "([^"]+)";/.test(artifact)) {
  console.error(
    `build: WARNING monitor.ts bundle lacks the \`const PLUGIN_VERSION = "${pkg.version}";\`\n` +
      `       literal (bun hoists module-scope const to var). self-update's staging\n` +
      `       verification looks for exactly that literal, so it will reject this\n` +
      `       artifact. Fix: widen the check or read package.json from the staged\n` +
      "       tarball (see docs/modules/split-contracts.md §4).",
  );
}

console.log(`build: bundled src/ -> monitor.ts (PLUGIN_VERSION ${pkg.version})`);