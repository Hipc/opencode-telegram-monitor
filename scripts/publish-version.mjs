#!/usr/bin/env node
// Reads PLUGIN_VERSION from monitor.ts (the single source of truth) and
// writes it into package.json before `npm publish`. Keeps the two in sync
// so the self-update check inside the plugin can compare against the exact
// published version.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const monitorPath = join(root, "monitor.ts");
const packagePath = join(root, "package.json");

const source = readFileSync(monitorPath, "utf8");
const match = source.match(/const PLUGIN_VERSION = "([^"]+)"/);
if (!match) {
  console.error("publish-version: PLUGIN_VERSION constant not found in monitor.ts");
  process.exit(1);
}
const version = match[1];

const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
pkg.version = version;
writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
console.log(`publish-version: package.json version -> ${version}`);