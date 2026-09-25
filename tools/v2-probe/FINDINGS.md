# opencode v2.0.15 plugin integration — container probe findings

Ticket: `01 — opencode v2 集成探针（容器实测证据）`
Probe run inside image `hipc/opencode2:latest` (Ubuntu 24.04, opencode **v2.0.15**, `opencode` at
`/root/.opencode/bin/opencode`, no node/bun/git inside, baked HTTP proxy). Nothing was installed on
the host; every opencode process ran in `docker run --rm` containers. Evidence is raw JSONL written
by the probe plugin plus captured command output under `evidence/<scenario>/`.

How to reproduce: `./run-probe.sh all` (see "Reproduction" at the bottom). Each scenario directory
contains `commands.txt` (the exact docker invocation + full container output), `events.jsonl`
(raw probe JSONL), and where applicable `server-log.txt` and `sse-raw.txt`.

Legend for evidence strength:

- **[observed]** — recorded by the probe at runtime in this round; pointer to the evidence file.
- **[binary]** — read from the opencode v2.0.15 binary's embedded JS (`grep -abo` on
  `/root/.opencode/bin/opencode`); used only to interpret observed behaviour, not as a substitute.

---

## A. Loading contract

### A1. Default export form: `{id, effect}` vs `{id, setup}`

- **[binary]** The definition schema accepts exactly one of two function properties:

  ```js
  var qD=o({default:G([
    o({id:t,effect:Yn((e)=>typeof e==="function")}),
    o({id:t,setup:Yn((e)=>typeof e==="function")})
  ])});
  ```

  Any other shape (including a module with no default export) fails with the message observed in
  `evidence/variants/arm-*`: `Plugin must export a default definition with an id and an effect or
  setup function.` — e.g. a helper `.ts` file that discovery treated as a plugin.

- **[observed] `setup` form** — `evidence/load/events.jsonl`, `evidence/api/events.jsonl`,
  `evidence/variants/arm-setup.jsonl`:
  `probe.setup` is recorded **once per activation** with `pid`, `cwd`, `argv`,
  `clientKeys`/`clientSurface` (full snapshot below). `setup(client)` is called once at load.

- **[observed] `effect` form** — `evidence/variants/arm-effect.jsonl`: the `effect` variant loaded
  and recorded `probe.effect-form` with `contextKeys` and `contextSurface`. Note that the raw
  context members return Effect values, not promises (see A1b).

- **[observed] `effect` may be an `async` function** in practice: the probe's `effect` is
  `async (context) => { ... }` and activation completed (no `failed to load plugin` line; the
  record was written). We did not test returning a meaningful Effect from a third-party TS plugin
  (no Effect library is importable from a plain local plugin), so this is only evidence that a
  promise-returning `effect` does not block activation in this build.

- **[observed] A1b. Context given to `effect` vs client given to `setup`** — both have the same 25
  top-level keys; `setup` receives promise-returning wrappers, `effect` receives the raw
  Effect-returning host context plus `storage`:

  ```
  [observed, evidence/variants/arm-effect.jsonl]
  contextKeys = ["app","location","options","rpc","agent","aisdk","provider","model","command",
                 "event","experimental","generate","integration","mcp","permission","plugin",
                 "reference","skill","storage","shell","tool","vcs","websearch","worktree","session"]
  [observed, evidence/variants/arm-setup.jsonl / evidence/load/events.jsonl]
  clientKeys  = ["app","location","options","agent","aisdk","command","event","experimental",
                 "generate","model","provider","integration","mcp","permission","plugin","reference",
                 "rpc","skill","storage","tool","vcs","websearch","worktree","session","shell"]
  ```

### A2. Loading a local `.ts` plugin — the exact rules

Three layouts were tested (config `plugin` array with absolute file path; config `plugin` array with
absolute directory; `<configDir>/plugin/` auto-discovery):

| Layout | Result | Evidence |
| --- | --- | --- |
| `"plugin": ["/probe/probe-plugin.ts"]` (absolute **file**) | **REJECTED** — server logs `level=WARN message="configured plugin path must be a directory" target=/probe/probe-plugin.ts`; plugin not loaded; `events.jsonl` stays 0 bytes | `evidence/file-path/commands.txt`, `evidence/file-path/events.jsonl` (empty) |
| `"plugin": ["/probe/plugin-package"]` (absolute **directory** with `package.json` + `index.ts`) | **WORKS** — `msg="loading plugin" id=/probe/plugin-package entrypoint=file:///probe/plugin-package/index.ts`, `probe.setup` recorded | `evidence/package-dir/commands.txt`, `evidence/package-dir/events.jsonl` |
| `<configDir>/plugin/*.ts` auto-discovery (no config entry) | **WORKS** — `msg="loading plugin" id=/tmp/home/.config/opencode/plugin/probe-autodiscover.ts entrypoint=file:///...` | `evidence/load/commands.txt`, `evidence/load/events.jsonl` |

Additional observed rules:

- **[observed]** Config array entries are resolved from the config file's directory for `./` and
  `../` prefixes; absolute entries are used as-is; bare names are package targets. An absolute
  **file** target is dropped by the config source with the warning above (the module loader itself
  would accept file targets — that is the path used by auto-discovery).
- **[observed]** Both config keys are accepted: legacy `"plugin"` (string or `[package, options]`)
  and v2 `"plugins"` (string or `{package, options}`). The package-dir control used `"plugin"`;
  `evidence/variants` earlier used `"plugins"` successfully before the recipe was consolidated.
- **[observed]** Auto-discovery scans `<configDir>/plugin/` **and** `<configDir>/plugins/`, loading
  every `.ts`/`.js` file and every directory found there. Helper `.ts` files placed in `plugin/`
  are themselves treated as plugins and fail validation — negative control
  `evidence/variants/arm-helper-in-plugin-server.txt` + `commands.txt`:
  `msg="loading plugin" id=.../plugin/extless-helper.ts` then
  `level=WARN message="failed to load plugin" ... Plugin must export a default definition with an
  id and an effect or setup function. (cause: SchemaError(Missing key at ["default"]))`.
  Keep helpers outside `plugin/`.
- **[observed]** TS is compiled at load by the Bun-based binary — the entrypoints were plain `.ts`
  (no build step, no node_modules) and executed.
- **[observed] Multi-file local imports work**, both with an explicit extension and extensionless:
  - `probe-plugin.ts` → `./probe-lib/helper.ts` → `./log.ts` (extension form, `node:fs`/`node:path`
    imports) — `evidence/load/events.jsonl` (`helperValue: "probe-helper-loaded"`).
  - `probe-extless.ts` → `../extless-helper` (no extension) and `../probe-lib/log.ts` —
    `evidence/variants/arm-extless.jsonl` shows `probe.module-evaluated` and `probe.setup` with
    `extlessHelperValue: "extless-helper-loaded"`.
  - Each local plugin file is loaded with its **own module instance** of shared dependencies
    (observed: per-plugin `seq` counters each start at 1 in the same process, and after a reload
    the same plugin's module state is fresh — see A3).
- **[observed]** A module that evaluates but whose `setup` is never called was seen once in a
  multi-plugin `plugin/` directory where a helper `.ts` was also present (probe-extless wrote its
  module-evaluation marker but no `setup` record, with no `failed to load plugin` line). The
  isolated arms (`evidence/variants/arm-*`) do not reproduce it, so it is recorded as an observed
  anomaly rather than a rule. The safe recipe used by all committed scenarios is: one plugin per
  file, helpers outside `plugin/`.

### A3. Lifecycle: once-at-load, dispose, reload, long-lived timers

- **[observed] `setup` runs once per activation** and may **return a dispose function**; the probe
  returns `() => { clearInterval(heartbeat); record("probe.dispose", ...) }`.
- **[observed] Dispose on server shutdown**: `evidence/load/events.jsonl` ends with
  `probe.dispose {heartbeats: 1}` then `probe.event-stream.ended`; `evidence/api/events.jsonl`
  has `probe.dispose {heartbeats: 19}` before the first reload.
- **[observed] Dispose + re-setup on config reload**: running `opencode reload --server ...`
  produced, in order:
  `probe.dispose {heartbeats: 19}` → `probe.event-stream.ended` → **new `probe.setup` record**
  (same pid) → new heartbeats starting at `n: 1` → later `probe.dispose {heartbeats: 3}` on
  shutdown. Evidence: `evidence/api/events.jsonl` (search `probe.dispose` / `probe.setup`).
  The second activation's records start at `seq: 1` again, i.e. the plugin module is re-imported
  fresh (module-level state is reset) and `setup` is invoked again.
- **[observed] Long-lived background timers work**: a `setInterval` started in `setup` kept firing
  across a 3-minute run (`evidence/variants/events.jsonl` from the earlier combined run reached
  `probe.heartbeat n: 91`; the current isolated arms show 5–22 heartbeats over ~10–45 s). The
  interval is independent of session activity and stops only when the plugin's dispose runs.
- **[observed] Event subscription is a long-lived async iterator** from
  `client.event.subscribe()`; it survives the whole process and ends (`probe.event-stream.ended`)
  on shutdown. Docs on the HTTP equivalent describe it as volatile: a slow consumer overflows and
  fails the stream, and events during disconnection are missed (`[binary]` event route description).

### A4. root / directory / worktree values in v2

- **[observed]** `client.location` (also present on every event as `event.location`):

  ```json
  {"directory": "/tmp",
   "project": {"id": "470c8549...", "directory": "/tmp", "canonical": "/tmp"}}
  ```

  `workspaceID` is present but `undefined` for a plain directory run. `client.location` is the v2
  replacement for v1's `directory`/`worktree` plugin arguments; there is also a `worktree` namespace
  (`list/create/remove/refresh`) for git worktree management.
- **[observed]** `client.app` = `{"name":"cli","version":"2.0.15","channel":"latest"}` (no `log`
  method — see C).
- **[observed]** `client.options` = `{}` — the per-plugin options object from config
  (`["pkg", options]` / `{package, options}`); the probe recipe passes none.
- **[observed]** `process.cwd()` was `/tmp` (the session directory) and `process.argv` was the
  server invocation, e.g. `["bun","/$bunfs/root/opencode","serve","--port","18131","--print-logs"]`.

---

## B. Events

### B1. Envelope shape

**[observed]** every plugin event (from `client.event.subscribe()`) is an object:

```json
{"id":"evt_0d42377ef001...","created":1790265489391,"type":"session.inbox.enqueued",
 "durable":{"aggregateID":"ses_...","seq":1,"version":1},
 "location":{"directory":"/tmp"},
 "data":{ ...type-specific... }}
```

- `durable` is present on durable/aggregate events (`session.created`, `session.deleted`,
  `session.inbox.*`, `session.execution.*`, `session.step.*`, `session.tool.*`, ...), absent on
  ephemeral ones (`permission.asked`, `permission.replied`, `form.*`, `session.usage.updated`,
  `session.text.*`, `session.reasoning.*`, `session.tool.progress`, ...).
- `data` carries the type-specific payload; IDs are prefixed (`ses_`, `msg_`, `prt_`, `per_`,
  `frm_`, `evt_`, `sh_`, `call_`).
- Raw wire format of `GET /api/event` (SSE) is `data: {json}\n\n` with `: heartbeat` comments; the
  event set observed on the wire was **identical** to the plugin stream plus a `server.connected`
  event. Evidence: `evidence/api/sse-raw.txt`.

### B2. Captured event families (≥1 real payload each)

All pointers are `evidence/<scenario>/events.jsonl` unless noted.

| Family | Captured | Key observed fields (exact names) |
| --- | --- | --- |
| `session.created` | api | `data.sessionID, projectID, location.directory, subpath, slug, title, version:"2.0.15"`, optional `permissions`; `durable.seq:0` |
| `session.deleted` | api | `data.sessionID`; `durable.version:2` |
| `session.execution.started/succeeded` | load, api | `data.sessionID` |
| `session.execution.failed` | session-error | `data.sessionID, error:{type:"provider.no-route", message:"Model unavailable: opencode/definitely-not-a-model"}` |
| `session.execution.interrupted` | tool-permission | `data.sessionID, reason` |
| `session.inbox.enqueued` | load, tool-permission, api | `data.sessionID, inboxID, item:{type:"user", payload:{text, files}, delivery:"steer"|"queue"}` |
| `session.inbox.delivered` | load, api | `data.sessionID, inboxID` |
| `session.inbox.cancelled` | api | `data.sessionID, inboxID` |
| `session.inbox.delivery.changed` | api | `data.sessionID, inboxID, delivery` |
| `form.created` | api | `data.form:{id, sessionID, title, fields:[...]}` — full question shape incl. `options` and `custom` |
| `form.replied` | api | `data.id, sessionID, answer:{key:value,...}` |
| `form.cancelled` | api | `data.id, sessionID` |
| `permission.asked` | tool-permission, auto-approve, api | V2 shape `data.id, sessionID, action:"shell", resources:["echo ..."], save:["echo *"], source:{type:"tool", messageID, id}` (API-created requests omit `save`/`source`) |
| `permission.replied` | tool-permission, auto-approve, api | `data.sessionID, requestID, reply:"once"` |
| `session.tool.input.started` | tool-permission, auto-approve | `data.sessionID, assistantMessageID, id:"call_...", name:"shell"` |
| `session.tool.input.ended` | tool-permission, auto-approve | `... id, text:"{\"command\": ...}"` |
| `session.tool.called` | tool-permission, auto-approve | `... id, input:{command}, executed:false` |
| `session.tool.progress` | auto-approve | `... id, metadata:{shellID}` |
| `session.tool.success` | auto-approve | `... id, content:[{type:"text",text}], metadata:{status,truncated,exit}` |
| `session.tool.failed` | tool-permission | `... id, error:{type:"aborted",message:"Tool execution interrupted"}, metadata` |
| `session.step.started` | load | `assistantMessageID, agent:"build", model:{id,providerID}, started` |
| `session.step.streamed/ended` | load, auto-approve | `ended` carries `finish, rawFinish, cost, tokens:{input,output,reasoning,cache:{read,write}}` |
| `session.step.failed` | tool-permission | `assistantMessageID, error:{...}, ...` |
| `session.text.started/delta/ended` | load | `assistantMessageID, ordinal, text/delta` |
| `session.reasoning.started/delta/ended` | load | `assistantMessageID, ordinal, state:{reasoningField}` |
| `session.usage.updated` (ephemeral) | load, api | `data.sessionID, cost, tokens:{input,output,reasoning,cache:{read,write}}` |
| `session.shell.started/ended` | tool-permission | `data.sessionID, shell:{id,command,status,...}, output` (from the interrupted tool) |
| `shell.created/exited/deleted` | tool-permission | standalone shell lifecycle events |
| `session.instructions.updated` | all runs | `data.sessionID, delta, text?` |
| `session.reasoning.*`, `session.skill.activated`, `session.compaction.*` | in catalog | catalog confirmed from the V2 event union; `session.compaction.*` not triggered in this round |
| environment events | all runs | `provider.updated`, `model.updated`, `agent.updated`, `command.updated`, `skill.updated`, `websearch.updated`, `reference.updated`, `integration.updated`, `plugin.updated`, `models-dev.refreshed`, `location.shutdown` |

`session.error` (v1 name) was **not** observed; the v2 failure events are
`session.execution.failed` / `session.step.failed` (see B4).

### B3. Question / inbox channel in v2

- v1's `question.asked` is replaced by the **form** system: `form.created` /
  `form.replied` / `form.cancelled`, with the full question shape in `data.form.fields[]` —
  including `options:[{value,label,description?}]`, `custom:boolean` (allow free input),
  `type:"string"|"number"|"integer"|"boolean"|"multiselect"|"external"`, `required`, `hidden`,
  `when`, `format`, `minLength/maxLength/pattern`, `default`. Observed payload:
  `evidence/api/events.jsonl` (`form.created` with a string field having `options` + `custom:true`).
- The **inbox** is the durable prompt queue: items are `user` / `synthetic` / `compaction` / `move`
  with `delivery:"steer"|"queue"`; events `session.inbox.enqueued`, `.delivered`, `.cancelled`,
  `.delivery.changed` all captured in `evidence/api/events.jsonl`.
- API surface for both (HTTP, `[binary]` + observed via `opencode api`):
  `session.form.list/create/get/reply/cancel` and
  `session.inbox.list/cancel/update`.

### B4. v1-compat events are NOT on the plugin event stream

- **[observed]** In every scenario (4+ full runs incl. model turns and tool calls), no
  `session.updated`, `message.updated`, `message.part.updated`, `message.part.delta`,
  `session.idle`, or `session.error` event was received. The raw `/api/event` SSE capture contains
  exactly the same V2 types (plus `server.connected`), so they are not merely filtered out for
  plugins: `evidence/api/sse-raw.txt`.
- **[binary]** v2 does define a V1 compat schema (`PermissionV1.*`, `SessionV1.*`,
  `session.updated`, `message.updated`, `message.part.updated`, `session.idle`, `session.error`)
  and DB tables (`todo`, `message`) for migration, but nothing in the observed runtime path
  publishes those onto the event bus used by plugins.
- Consequence for the port: `message.updated`/`message.part.updated` consumers must switch to
  `session.step.*` / `session.text.*` / `session.tool.*`; `session.idle` consumers must switch to
  `session.execution.succeeded|failed|interrupted` (plus inbox empty state if needed).

### B5. Todo source in v2

- **[observed]** `client.tool.list()` returned 60 tools; the name list contains no `todo`/`todoread`/
  `todowrite` tool (`evidence/api/events.jsonl`, `probe.tool.list.names`).
- **[observed]** The client surface has no todo namespace or method; `session.context()` returned
  the message array only (`[]` on a fresh session).
- **[observed]** No `todo.*` event in any run or in the raw SSE.
- **[binary]** A `todo` DB table exists in the migration history
  (`session_id, content, status, priority, position, time_created, time_updated`) and
  `session.message.content.updated` exists in the event catalog, but no code path publishing or
  exposing todos was found; binary string search over the opencode core region found only the
  migration SQL.
- Conclusion: **todo data is not observable in v2.0.15** through the plugin API or event stream.
  Absence verified by (a) client key/method enumeration, (b) tool list enumeration, (c) full event
  capture incl. raw SSE, (d) binary string search. If todos matter, the port must be re-scoped.

### B6. Token / cost usage

- **[observed]** `session.usage.updated` (ephemeral): `{sessionID, cost, tokens:{input, output,
  reasoning, cache:{read, write}}}` — fires during a turn (`evidence/load/events.jsonl`).
- **[observed]** `session.step.ended`: `{sessionID, assistantMessageID, finish, rawFinish, cost,
  tokens:{...}}` — per step (`evidence/auto-approve/events.jsonl`).
- **[observed]** `client.session.get({sessionID})` returns cumulative `cost` and `tokens` on the
  session object (`evidence/api/events.jsonl`, `probe.session.get`).
- `session.usage.recorded` exists in the durable event catalog (`[binary]`) but was not triggered
  in this round; treat it as unobserved.

---

## C. Client API signatures (observed)

### C1. Full client surface

`[observed]` `Object.keys(client)` and per-namespace members (typeof), from
`evidence/api/events.jsonl` → `probe.setup.clientSurface`:

```
app:        {name, version, channel}                      // metadata only, NO log method
location:   {directory, workspaceID, project}
options:    {}                                            // per-plugin config options
agent:      get, list, transform, reload
aisdk:      hook
command:    list, transform, reload
event:      subscribe
experimental: terminal
generate:   text
model:      list, default, transform, reload
provider:   list, get, transform, reload
integration: list, get, connect, oauth, command, transform, reload, connection
mcp:        list, transform, reload
permission: hook, list, get, reply
plugin:     list
reference:  list, transform, reload
rpc:        (function; Object.assign of rpc client + register)
skill:      list, transform, reload
storage:    get, set, remove, scan
tool:       reload, list, transform, hook
vcs:        get, base, branch, status, diff, reload, transform
websearch:  providers, query, reload, transform
worktree:   list, create, remove, refresh, reload, transform
session:    hook, create, get, switchAgent, switchModel, prompt, generate, command, synthetic,
            interrupt, update, move, wait, context
shell:      hook
```

Notably absent vs v1: `app.log`, `session.list`, `session.messages`, `session.todo`, `client.tui`.

### C2. Observed call results (exact shapes)

- **storage** (`[observed]` `probe.storage.roundtrip`, both api runs):
  - `await client.storage.set("probe/key-<ts>", {hello:"world", n:1})` → resolved `undefined`
  - `await client.storage.get(key)` → `{"hello":"world","n":1}`
  - `await client.storage.scan({prefix:"probe/", limit:10})` → `{entries:[{key, value}]}`
    (`next` field when more pages exist; keys are returned without the internal plugin prefix)
  - `await client.storage.remove(key)` → `undefined`; subsequent `get` → `undefined`
  - `[binary]` storage keys are namespaced per plugin id as `plugin:<hex-encoded id>:`.
- **session** (`[observed]`):
  - `client.session.create({title})` → session object directly (not `{data}`):
    `{id, projectID, cost, tokens:{input,output,reasoning,cache:{read,write}}, time:{created,updated}, title, location:{directory}}`
  - `client.session.get({sessionID})` → same shape.
  - `client.session.context({sessionID})` → array of context messages (after last compaction);
    `[]` on a fresh session.
  - `client.session.prompt({text, delivery?})` → `undefined` (the HTTP call returned the admitted
    inbox item; the plugin client resolves void).
- **tool** (`[observed]`): `client.tool.list()` → 60 tools; each
  `{name, description, input:fn, output:fn, options:{namespace, permission, codemode}, execute:fn, id}`.
- **permission** (`[observed]`, `evidence/api/events.jsonl`, `evidence/tool-permission/events.jsonl`):
  - `client.permission.list({sessionID})` → array of pending requests; full shape
    `{id, sessionID, action, resources, save?, source?}`.
  - `client.permission.get({sessionID, requestID})` — same object or an error if not found.
  - `client.permission.reply({sessionID, requestID, decision, message?})` where
    `decision ∈ "once" | "always" | "reject"` — **this is the exact request shape**; it resolved
    `undefined` and the server emitted
    `permission.replied {sessionID, requestID, reply:"once"}`.
  - HTTP equivalents (`[observed]` via `opencode api`):
    `POST /api/session/:sessionID/permission/:requestID/reply` body `{"decision":"once"}`;
    `POST /api/session/:sessionID/permission` body
    `{action, resources, save?, metadata?, source?, agent?}` → `{data:{id, effect:"ask"}}`;
    reply to an already-resolved request → HTTP 404 (`evidence/tool-permission/commands.txt`).
- **event** (`[observed]`): `client.event.subscribe()` returns an async iterable of the event
  envelope in B1; iterate with `for await`.
- **logging**: there is no `app.log`; the probe's `console.log` lines did not appear in the server
  log file or serve stdout (checked `evidence/*/server-log.txt` and captured stdout).
  Evidence capture therefore must write to a file (as the probe does). No `[binary]` evidence of a
  plugin log sink was found in the client surface.

### C3. Session query note (no list/messages)

`session.list`, `session.messages`, and `session.todo` are not exposed on the plugin client.
Available v2 alternatives:

- `client.session.get({sessionID})` for status/usage.
- `client.session.context({sessionID})` for messages after the last compaction.
- `client.session.wait({sessionID})` to await idle.
- HTTP API (reachable from a plugin via `fetch` + server password, or from tests via
  `opencode api`): `GET /api/session` (list), `GET /api/session/:id/message` (messages, with
  `limit/order/cursor/type`), `GET /api/session/:id/context`, `GET /api/session/:id/inbox`.

---

## D. Trigger recipes (reproducible)

All recipes are implemented in `scripts/*.sh` and driven by `./run-probe.sh <scenario>`. Each
container run uses `--rm`, publishes no ports, and writes evidence to the scenario directory.

### D1. Load + client surface + real session events — `load`

```sh
cp probe files into $HOME/.config/opencode/...      # see scripts/load.sh
timeout 180 opencode run --standalone --print-logs --format json "Reply with exactly: hello"
```

Observed: `run_exit=0`; session events as in B2; heartbeat; dispose on shutdown. The run exits by
itself when the session goes idle. `evidence/load/`.

### D2. Real shell tool call → `permission.asked` → probe replies — `tool-permission`

Config: `permissions: [{action:"shell", resource:"*", effect:"ask"}]`.
Prompt: `Use the shell tool to run exactly this command: echo permission-probe-ok. Then report the output.`
Probe env: `PROBE_PERMISSION_REPLY=once`.

Observed behaviour (important): headless `opencode run` **auto-rejects** permission requests it
cannot prompt for — stdout shows
`! permission requested: shell (echo permission-probe-ok); auto-rejecting`. The probe's
`permission.reply` raced the CLI's auto-reject: the plugin call itself resolved `undefined` and
`permission.replied` was emitted, but the tool had already been interrupted
(`session.tool.failed error.type:"aborted"`). A 404 from the CLI's own late reply attempt is
visible in `evidence/tool-permission/commands.txt`. This still proves the reply request shape
end-to-end; for a *successful* permission flow use `--auto` (D3) or the serve/API route (D4).
Run is terminated by its own 180s `timeout` (or normally when the model gives up).

### D3. Auto-approve flow (asked + replied + tool success) — `auto-approve`

Same config/prompt plus `--auto`:

```sh
timeout 180 opencode run --standalone --auto --print-logs --format json "Use the shell tool ..."
```

Observed in `evidence/auto-approve/events.jsonl`: `session.tool.called` → `permission.asked`
(`save:["echo *"]`, `source:{type:"tool",...}`) → `permission.replied {reply:"once"}` →
`session.tool.progress` → `session.tool.success {content:[{type:"text",text:"auto-approve-ok\n"}],
metadata:{exit:0}}` → `session.step.ended` with tokens/cost.

### D4. Deterministic serve + API triggers — `api`

```sh
OPENCODE_SERVER_PASSWORD="$PROBE_PASSWORD" setsid opencode serve --port 18131 --print-logs > /tmp/serve.log 2>&1 &
export OPENCODE_PASSWORD="$PROBE_PASSWORD"                 # client auth env
opencode api --server http://127.0.0.1:18131 plugin.list    # also boots the instance
SID=$(opencode api ... session.create -d '{"title":"probe-api",
      "permissions":[{"action":"shell","resource":"*","effect":"ask"}]}' | grep -o '"id":"ses_[^"]*"' ...)
opencode api ... session.permission.create --param sessionID=$SID -d '{"action":"shell","resources":["echo probe"]}'
opencode api ... session.form.create  --param sessionID=$SID -d '{"title":"...","fields":[...options/custom...]}'
opencode api ... session.form.reply / session.form.cancel
opencode api ... session.prompt --param sessionID=$SID -d '{"text":"...","delivery":"steer"|"queue"}'
opencode api ... session.inbox.cancel / session.inbox.update
opencode reload --server http://127.0.0.1:18131              # triggers dispose + re-setup
opencode api ... session.remove --param sessionID=$SID       # emits session.deleted
kill -TERM -$SPID
```

Notes:

- `opencode api --server ...` requires the password via `OPENCODE_PASSWORD`; `serve` accepts a
  fixed one via `OPENCODE_SERVER_PASSWORD` (otherwise it prints a random one:
  `server password <base64url>`).
- `session.permission.create` only creates a request when the session ruleset says `ask`
  (`{data:{id, effect:"ask"}}`); the probe then replies and `permission.replied` is emitted.
- `session.create` with an unknown model → HTTP 400 (`Model unavailable`), so the error path was
  triggered through the CLI instead (D5).
- The raw SSE comparison stream is captured with
  `curl -s -N -u opencode:$PW http://127.0.0.1:$PORT/api/event > /evidence/sse-raw.txt`.
- Evidence: `evidence/api/`.

### D5. Failure events — `session-error`

```sh
timeout 120 opencode run --standalone --print-logs --format json \
  --model opencode/definitely-not-a-model "hello"
```

Observed: `run_exit=1` and `session.execution.failed`
`{sessionID, error:{type:"provider.no-route", message:"Model unavailable: opencode/definitely-not-a-model"}}`
(`evidence/session-error/events.jsonl`).

### D6. Negative/positive loading controls — `file-path`, `package-dir`

- `file-path`: config `"plugin": ["/probe/probe-plugin.ts"]` → warning
  `configured plugin path must be a directory`, no plugin loaded, empty `events.jsonl`.
- `package-dir`: config `"plugin": ["/probe/plugin-package"]` (directory with
  `package.json` → `index.ts`) → loads, `probe.setup` recorded.

---

## E. Not observable / negative results (and how absence was checked)

| Item | Result | How checked |
| --- | --- | --- |
| v1 events `session.updated`, `message.updated`, `message.part.updated`, `session.idle`, `session.error` | not emitted | 4+ full runs incl. model turns/tool calls; raw `/api/event` SSE identical; event catalog is V2-only |
| `todo.*` event / todo API / todo tool | absent in v2.0.15 | client key enumeration; `tool.list` (60 tools, no todo); all events; binary string search (only migration SQL) |
| `app.log` | absent (`app` = `{name,version,channel}`) | client surface snapshot; no log sink found |
| `session.list`, `session.messages` on plugin client | absent | client surface snapshot; HTTP API has them |
| permission reply to an already-resolved request | HTTP 404 | `evidence/tool-permission/commands.txt` |
| `session.error` on provider failure | replaced by `session.execution.failed` | `evidence/session-error/events.jsonl` |
| `session.compaction.*` | catalogued but not triggered | needs a long session; out of scope for this probe |
| `session.usage.recorded` (durable) | catalogued but not triggered | `session.usage.updated`/`session.step.ended` cover usage |

## F. Environment quirks worth knowing for ticket 05

- The free model (`opencode/mimo-v2.6-flash-free`, default) does call tools (shell) reliably, but
  one model turn hung for ~178s and ended with `{"type":"error","error":{"type":"unknown","message":"Transport"}}`
  before the CLI's 180s timeout. Every long command must carry its own `timeout`.
- `opencode serve` boots the server instance (and therefore activates plugins) lazily; a plain
  `serve` with no request never loaded plugins in this round. Make one API call after startup when
  using serve-only recipes.
- Server logs land in `$HOME/.local/share/opencode/log/opencode.log`; `--print-logs` on
  `run --standalone` also mirrors them to stderr. Plugin `console.log` output was not visible in
  either.
- Containers run as root (opencode lives under `/root`); evidence files are chowned back with
  `otg-toolchain:latest` by `run-probe.sh`.

## G. Evidence index

| Path | Contents |
| --- | --- |
| `evidence/load/` | plugin load, full client surface, session/step/text/usage events, dispose |
| `evidence/tool-permission/` | real tool call, permission.asked, probe reply attempt (race with CLI auto-reject), tool failure |
| `evidence/auto-approve/` | full permission lifecycle asked→replied→tool success, tokens |
| `evidence/api/` | deterministic API triggers: storage/session/tool/permission/form/inbox, reload dispose+setup, session.deleted, `sse-raw.txt`, server logs |
| `evidence/variants/` | 3 isolated loading arms: setup form, effect form, extensionless import (+ server logs) |
| `evidence/session-error/` | `session.execution.failed` payload |
| `evidence/file-path/` | negative control: absolute file path rejected (empty `events.jsonl`) |
| `evidence/package-dir/` | positive control: absolute directory package loads |
