/**
 * Extensionless-import variant: imports "../extless-helper" WITHOUT the ".ts"
 * extension to prove whether the v2 loader resolves extensionless relative TS
 * imports for local plugin files.
 *
 * The helper lives at the config-dir root (one level above plugin/), so the
 * plugin discovery scan does not pick it up as a plugin itself.
 */
import { ensureLogDir, record } from "../probe-lib/log.ts";
import { EXTLESS_HELPER_VALUE } from "../extless-helper";

// Module-evaluation marker: distinguishes "module never evaluated" from
// "module evaluated but setup never called".
ensureLogDir();
record("probe-extless", "probe", "probe.module-evaluated", {
  pid: process.pid,
  extlessHelperValue: EXTLESS_HELPER_VALUE,
});

export default {
  id: "probe-extless",
  async setup(client: Record<string, any>): Promise<void> {
    ensureLogDir();
    record("probe-extless", "probe", "probe.setup", {
      pid: process.pid,
      extlessHelperValue: EXTLESS_HELPER_VALUE,
      clientKeys: Object.keys(client ?? {}),
    });
  },
};
