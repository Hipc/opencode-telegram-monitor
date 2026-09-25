/**
 * Effect-form variant: default export {id, effect}.
 *
 * The loader accepts `effect` as an alternative to `setup`. The raw plugin host
 * context is passed to `effect` (its members return Effect values, not promises),
 * so this variant only snapshots the context surface.
 */
import { ensureLogDir, describeSurface, record } from "../probe-lib/log.ts";

export default {
  id: "probe-effect",
  async effect(context: Record<string, any>): Promise<void> {
    ensureLogDir();
    record("probe-effect", "probe", "probe.effect-form", {
      pid: process.pid,
      contextKeys: Object.keys(context ?? {}),
      contextSurface: describeSurface(context),
      eventSubscribeType: typeof context?.event?.subscribe,
      app: context?.app,
      location: context?.location,
      options: context?.options,
      storagePresent: context?.storage !== undefined,
    });
  },
};
