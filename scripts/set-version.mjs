#!/usr/bin/env node
// Sets the plugin version everywhere it appears, driven by ONE argument:
// the release version (e.g. "1.2.3", with or without the "v" prefix).
//
// The release version is the single source of truth for a published build:
//   - src/version.ts -> const PLUGIN_VERSION = "..."
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

const versionPath = join(root, "src", "version.ts");
const packagePath = join(root, "package.json");
const readmePath = join(root, "README.md");

// 1) src/version.ts: const PLUGIN_VERSION = "..." (single source of truth)
//    (`export const ...` is fine — the unanchored regex matches the substrings)
const versionFile = readFileSync(versionPath, "utf8");
if (!/const PLUGIN_VERSION = "[^"]+";/.test(versionFile)) {
  fail("PLUGIN_VERSION constant not found in src/version.ts");
}
writeFileSync(
  versionPath,
  versionFile.replace(/const PLUGIN_VERSION = "[^"]+";/, `const PLUGIN_VERSION = "${version}";`),
  "utf8",
);

// 2) package.json: "version": "..."
const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
pkg.version = version;
writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

// 3) README.md: the npm install pin inside the opencode.json example.
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

console.log(`set-version: src/version.ts, package.json, README.md -> ${version}`);