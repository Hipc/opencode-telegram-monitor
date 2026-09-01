#!/usr/bin/env node
// Bundles the src/ sources into the single-file root `monitor.ts` artifact
// that every install path consumes (npm tarball, local-file copy, self-update
// staging). Run this before publishing or copying a local install:
//
//   node scripts/build.mjs
//
// The bundle's `PLUGIN_VERSION` is injected from package.json "version" via
// bun's `--define` (replacing the `__PLUGIN_VERSION__` injection point in
// src/version.ts), so package.json stays the single source of truth. After
// building, the artifact must report the package version — a broken artifact
// can never be released. Note on the declaration keyword: bun's bundler
// hoists module-scope bindings as `var` (e.g. `var PLUGIN_VERSION = "0.5.3";`),
// so a missing/wrong version exits 1.
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
//    invocations of this project. `__PLUGIN_VERSION__` is replaced at build
//    time with the package.json "version" string literal (see
//    docs/modules/version-injection.md §2.1); JSON.stringify yields the
//    double-quoted literal bun needs for the define, letting the typeof
//    guard in src/version.ts constant-fold.
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
    "--define",
    `__PLUGIN_VERSION__:${JSON.stringify(pkg.version)}`,
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

// 2) Hard gate: the artifact must declare the injected package version.
//    bun emits `var PLUGIN_VERSION = "x.y.z";` at module scope (const is
//    hoisted), so accept either keyword as long as the quoted value matches
//    package.json.
const declaration = artifact.match(/PLUGIN_VERSION = "([^"]+)";/);
if (!declaration) {
  fail("monitor.ts: PLUGIN_VERSION declaration not found in bundle output");
}
if (declaration[1] !== pkg.version) {
  fail(
    `monitor.ts bundle reports PLUGIN_VERSION ${declaration[1]}, expected ${pkg.version} from package.json`,
  );
}

console.log(`build: bundled src/ -> monitor.ts (PLUGIN_VERSION ${pkg.version})`);