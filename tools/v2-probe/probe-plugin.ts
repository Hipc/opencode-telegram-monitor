/**
 * opencode v2 integration probe plugin (default export, `setup` form).
 *
 * Loaded from an absolute local path via opencode.json:
 *   { "plugin": ["/probe/probe-plugin.ts"] }
 *
 * Records raw evidence to PROBE_LOG_FILE (mounted /evidence/events.jsonl):
 *  - probe.setup          : setup called once at load, client surface snapshot,
 *                           location/app/options values, multi-file import proof
 *  - probe.heartbeat      : setInterval tick every 2s (long-lived timer proof)
 *  - probe.dispose        : dispose callback returned from setup
 *  - probe.storage.*      : client.storage set/get/scan/remove round trip
 *  - probe.session.*      : client.session create/get/context
 *  - probe.tool.list      : client.tool.list
 *  - probe.permission.*   : permission.list / permission.reply round trip
 *  - event.<type>         : every raw event received from client.event.subscribe()
 */
import { PROBE_HELPER_VALUE, probeHelperDescribe } from "./probe-lib/helper.ts";
import { ensureLogDir, describeSurface, shapeOf, record } from "./probe-lib/log.ts";

const PLUGIN_ID = "probe-main";
const HEARTBEAT_MS = 2000;

export default {
  id: PLUGIN_ID,
  async setup(client: Record<string, any>): Promise<() => void> {
    ensureLogDir();

    record(PLUGIN_ID, "probe", "probe.setup", {
      pid: process.pid,
      cwd: process.cwd(),
      argv: process.argv.slice(0, 6),
      helperValue: PROBE_HELPER_VALUE,
      helperDescribe: probeHelperDescribe(),
      clientKeys: Object.keys(client),
      clientSurface: describeSurface(client),
      app: client.app,
      location: client.location,
      options: client.options,
      eventSubscribeType: typeof client.event?.subscribe,
      apiProbeEnabled: process.env.PROBE_API_PROBE === "1",
      permissionReply: process.env.PROBE_PERMISSION_REPLY ?? null,
    });

    // ---- long-lived background timer proof ----------------------------------
    let heartbeats = 0;
    const heartbeat = setInterval(() => {
      heartbeats += 1;
      record(PLUGIN_ID, "probe", "probe.heartbeat", {
        n: heartbeats,
        pid: process.pid,
        intervalMs: HEARTBEAT_MS,
      });
    }, HEARTBEAT_MS);

    // ---- event stream -------------------------------------------------------
    const stream = client.event.subscribe();
    void (async () => {
      try {
        for await (const event of stream) {
          record(PLUGIN_ID, "event", event?.type ?? "unknown", event);
          if (event?.type === "permission.asked") {
            await onPermissionAsked(client, event);
          }
        }
        record(PLUGIN_ID, "probe", "probe.event-stream.ended", {});
      } catch (error) {
        // Recorded, not swallowed: the loop stops here and the reason stays in evidence.
        record(PLUGIN_ID, "probe", "probe.event-stream.error", { error: String(error) });
      }
    })();

    // ---- optional API surface probe ----------------------------------------
    if (process.env.PROBE_API_PROBE === "1") {
      await runApiProbe(client);
    }

    return () => {
      clearInterval(heartbeat);
      record(PLUGIN_ID, "probe", "probe.dispose", { heartbeats, pid: process.pid });
    };
  },
};

let permissionReplied = false;

async function onPermissionAsked(client: Record<string, any>, event: any): Promise<void> {
  const data = event?.data ?? {};
  record(PLUGIN_ID, "probe", "probe.permission.asked.observed", {
    id: data.id,
    sessionID: data.sessionID,
    dataKeys: Object.keys(data),
    dataShape: shapeOf(data),
  });

  const listed = await client.permission.list({ sessionID: data.sessionID });
  record(PLUGIN_ID, "probe", "probe.permission.list", { sessionID: data.sessionID, listed: shapeOf(listed) });

  const decision = process.env.PROBE_PERMISSION_REPLY;
  if (!decision || permissionReplied) return;
  permissionReplied = true;

  const request = { sessionID: data.sessionID, requestID: data.id, decision };
  record(PLUGIN_ID, "probe", "probe.permission.reply.attempt", { request });
  try {
    const result = await client.permission.reply(request);
    record(PLUGIN_ID, "probe", "probe.permission.reply.result", { request, result: shapeOf(result) });
  } catch (error) {
    record(PLUGIN_ID, "probe", "probe.permission.reply.error", { request, error: String(error) });
  }
}

async function runApiProbe(client: Record<string, any>): Promise<void> {
  // --- storage ---
  const key = `probe/key-${Date.now()}`;
  await client.storage.set(key, { hello: "world", n: 1 });
  const got = await client.storage.get(key);
  const scan = await client.storage.scan({ prefix: "probe/", limit: 10 });
  await client.storage.remove(key);
  const afterRemove = await client.storage.get(key);
  record(PLUGIN_ID, "probe", "probe.storage.roundtrip", {
    key,
    got,
    scan: shapeOf(scan),
    afterRemove: afterRemove === undefined ? "undefined" : afterRemove,
  });

  // --- session create/get/context ---
  const created = await client.session.create({ title: "probe-api-session" });
  record(PLUGIN_ID, "probe", "probe.session.create", { created: shapeOf(created, 3) });
  const sessionID = created?.id ?? created?.data?.id;
  const fetched = await client.session.get({ sessionID });
  record(PLUGIN_ID, "probe", "probe.session.get", { sessionID, fetched: shapeOf(fetched, 3) });
  const context = await client.session.context({ sessionID });
  record(PLUGIN_ID, "probe", "probe.session.context", { sessionID, context: shapeOf(context, 3) });

  // --- tool list ---
  const tools = await client.tool.list();
  record(PLUGIN_ID, "probe", "probe.tool.list", {
    count: tools.length,
    first: tools.length > 0 ? shapeOf(tools[0], 2) : null,
    names: tools.map((tool: any) => tool.path ?? tool.name),
  });

  // --- permission list on empty session ---
  const listed = await client.permission.list({ sessionID });
  record(PLUGIN_ID, "probe", "probe.permission.list", { sessionID, listed: shapeOf(listed) });
}
