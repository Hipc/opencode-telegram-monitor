export const SERVICE = "telegram-session-monitor";
export const TARGET_OPENCODE_VERSION = "1.18.23";
// Single source of truth for the npm package version. The publish script
// (scripts/set-version.mjs) reads this constant and writes it into
// package.json before `npm publish`, so the two never drift apart.
export const PLUGIN_VERSION = "0.5.3";

// Self-update: the npm package name and registry endpoints used to check for
// and download newer releases. The update is atomic (staging dir + backup +
// verify + rollback) so an offline machine keeps running the cached version
// and never ends up with a half-installed plugin.
export const NPM_PACKAGE_NAME = "opencode-telegram-monitor";
export const NPM_REGISTRY_BASE = "https://registry.npmjs.org";
export const SELF_UPDATE_FETCH_TIMEOUT_MS = 10_000;
// Only touch the plugin cache under ~/.cache/opencode (npm installs). A
// manually copied local file (~/.config/opencode/plugins/...) is left alone.
export const OPENCODE_CACHE_MARKERS = [".cache/opencode", ".cache\\opencode"];
