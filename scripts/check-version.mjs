#!/usr/bin/env node
// Verifies that the release version (from a git tag, e.g. v0.5.1) matches EVERY
// place the plugin version is pinned, BEFORE you create the tag:
//
//   - package.json -> "version": "..."   (single source of truth)
//   - README.md    -> the npm install pin ("opencode-telegram-monitor@...")
//
// Usage (run this, then tag only if it exits 0):
//   node scripts/check-version.mjs v0.5.1
//   node scripts/check-version.mjs 0.5.1        # "v" prefix optional
//
// Any mismatch exits with code 1 and prints exactly which file disagrees, so
// the tag can never point at a version the package does not report. Bump the
// version first with `node scripts/set-version.mjs <version>` (which rewrites
// both files in one pass), then verify, then tag.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`check-version: ${message}`);
  process.exit(1);
}

const raw = process.argv[2];
if (!raw) fail("usage: node scripts/check-version.mjs <version> (e.g. v0.5.1)");
const version = raw.startsWith("v") ? raw.slice(1) : raw;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`invalid version "${raw}" (expected semver like 1.2.3 or v1.2.3)`);
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");

const mismatches = [];

if (pkg.version !== version) {
  mismatches.push(`package.json reports ${pkg.version}, expected ${version}`);
}

const readmePins = [
  ...readme.matchAll(/opencode-telegram-monitor@([^"\s]+)"/g),
].map((m) => m[1]);
if (readmePins.length === 0) {
  mismatches.push("README.md: npm install pin not found");
} else {
  const bad = readmePins.filter((pin) => pin !== version);
  if (bad.length > 0) {
    mismatches.push(
      `README.md pins ${readmePins.join(", ")}, expected ${version}`,
    );
  }
}

if (mismatches.length > 0) {
  fail(
    `${raw} does not match the pinned version:\n  - ${mismatches.join("\n  - ")}\nRun \`node scripts/set-version.mjs ${raw}\` first.`,
  );
}

console.log(`check-version: ${raw} matches package.json, README.md`);