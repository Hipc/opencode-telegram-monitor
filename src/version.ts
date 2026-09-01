export const SERVICE = "telegram-session-monitor";
export const TARGET_OPENCODE_VERSION = "1.18.23";
// PLUGIN_VERSION is injected at bundle time by scripts/build.mjs from
// package.json "version" (see docs/modules/version-injection.md). Running the
// sources directly (tests/dev) without the define yields the dev fallback
// below; a released bundle always carries the real package version.
declare const __PLUGIN_VERSION__: string | undefined;
export const PLUGIN_VERSION =
  typeof __PLUGIN_VERSION__ !== "undefined"
    ? __PLUGIN_VERSION__
    : "0.0.0-dev";

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
