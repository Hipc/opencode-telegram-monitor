/**
 * Auto-discovery entry for the opencode v2 probe.
 *
 * opencode v2 scans `<configDir>/plugin/*.ts|*.js` and loads each file found
 * (opencode.json does not need a `plugin` entry for these). This wrapper is the
 * only file placed in the config `plugin/` directory; it imports the real probe
 * and its libs from the config-dir root (outside `plugin/`) so the directory
 * scan does not pick up the lib folder itself.
 */
import plugin from "../probe-plugin.ts";

export default plugin;
