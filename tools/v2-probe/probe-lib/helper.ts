/**
 * Multi-file import fixture: imported by probe-plugin.ts with an explicit ".ts"
 * extension. Importing this file transitively imports ./log.ts.
 */
import { describeSurface } from "./log.ts";

export const PROBE_HELPER_VALUE = "probe-helper-loaded";

export function probeHelperDescribe(): { helperValue: string; describeWorks: boolean } {
  return {
    helperValue: PROBE_HELPER_VALUE,
    describeWorks: typeof describeSurface({ nested: { fn: () => undefined } }) === "object",
  };
}
