#!/usr/bin/env node
// Sets the plugin version everywhere it appears, driven by ONE argument:
// the release version (e.g. "1.2.3", with or without the "v" prefix).
//
// The release version is the single source of truth for a published build:
//   - monitor.ts  -> const PLUGIN_VERSION = "..."
//   - package.json -> "version": "..."
//   - README.md    -> the npm install pin ("opencode-telegram-monitor@...")
//
// The publish workflow runs this script against the checked-out tag so the
// published tarball always reports the tag's version, then commits the changes
// back to main with [skip ci].
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

const monitorPath = join(root, "monitor.ts");
const packagePath = join(root, "package.json");
const readmePath = join(root, "README.md");

// 1) monitor.ts: const PLUGIN_VERSION = "..." (single source of truth)
const monitor = readFileSync(monitorPath, "utf8");
if (!/const PLUGIN_VERSION = "[^"]+";/.test(monitor)) {
  fail("PLUGIN_VERSION constant not found in monitor.ts");
}
writeFileSync(
  monitorPath,
  monitor.replace(/const PLUGIN_VERSION = "[^"]+";/, `const PLUGIN_VERSION = "${version}";`),
  "utf8",
);

// 2) package.json: "version": "..."
const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
pkg.version = version;
writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

// 3) README.md: npm install pin "opencode-telegram-monitor@<version>"
const readme = readFileSync(readmePath, "utf8");
if (!/opencode-telegram-monitor@[^"]+"/.test(readme)) {
  fail("npm install pin not found in README.md");
}
writeFileSync(
  readmePath,
  readme.replace(/opencode-telegram-monitor@[^"]+"/g, `opencode-telegram-monitor@${version}"`),
  "utf8",
);

console.log(`set-version: monitor.ts, package.json, README.md -> ${version}`);