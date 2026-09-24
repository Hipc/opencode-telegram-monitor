/**
 * Directory-package entry: proves that a config array entry may point at a
 * DIRECTORY (absolute) which opencode resolves through package.json to this
 * file. See ../../FINDINGS.md §A for the file-path rejection contrast.
 */
import plugin from "../probe-plugin.ts";

export default plugin;
