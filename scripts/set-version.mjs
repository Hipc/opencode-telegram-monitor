#!/usr/bin/env node
// Sets the release version in the release-facing files, driven by ONE argument:
// the release version (e.g. "1.2.3", with or without the "v" prefix).
//
// package.json "version" is the single source of truth — scripts/build.mjs
// reads it at bundle time and injects it into the built monitor.ts via
// `bun build --define` (see docs/modules/version-injection.md). This script
// syncs the remaining release-facing surface so everything reports one version:
//   - package.json -> "version": "..."
//   - README.md    -> the npm install pin ("opencode-telegram-monitor@...")
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`set-version: ${message}`);
  process.exit(1);
}

const raw = process.argv[2];
if (!raw) fail("usage: node scripts/set-version.mjs <version> (e.g. 1.2.3 or v1.2.3)");
const version = raw.startsWith("v") ? raw.slice(1) : raw;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`invalid version "${raw}" (expected semver like 1.2.3)`);
}

const packagePath = join(root, "package.json");
const readmePath = join(root, "README.md");

// 1) package.json: "version": "..."
const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
pkg.version = version;
writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

// 2) README.md: the npm install pin inside the opencode.json example.
// Match ONLY a `"opencode-telegram-monitor@x.y.z"` literal inside the plugin
// array (an exact semver followed by a closing quote), so the generic
// `x.y.z` placeholders in the release-script examples are never rewritten.
const readme = readFileSync(readmePath, "utf8");
if (!/"opencode-telegram-monitor@\d+\.\d+\.\d+"/.test(readme)) {
  fail('npm install pin ("opencode-telegram-monitor@x.y.z") not found in README.md');
}
writeFileSync(
  readmePath,
  readme.replace(/"opencode-telegram-monitor@\d+\.\d+\.\d+"/g, `"opencode-telegram-monitor@${version}"`),
  "utf8",
);

console.log(`set-version: package.json, README.md -> ${version}`);