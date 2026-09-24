# §9 supplementary probe — subagent lineage / parentID — verdict (ticket 05)

**Run:** opencode **v2.0.15** in `hipc/opencode2:latest`, 2026-09-25, container-only.
**Reproduce:** `tests/e2e/container/run.sh probe-lineage` (then `run.sh assert-probe-lineage`).
**Raw evidence:** `tests/e2e/container/evidence/probe-lineage/` (`probe-lineage.jsonl`,
`sse-raw.txt`, `server-log.txt`, `commands.txt`, `api-*.json`, `child-session-created.json`).

## Verdict: parent linkage **IS observable** — via optional `parentID` (string, `^ses`)

The contract §9 claim "v2.0.15 无 parent 关联——`session.created` 数据与 `session.get` 形状均无
`parentID`" was drawn from root-session observations only. A real subagent child session
**does** carry `parentID`, in both the plugin event stream and the client API:

| Observation point | Root session | Subagent child session |
|---|---|---|
| `session.created` event `data.parentID` | key absent | `"ses_<parent>"` |
| `client.session.get({sessionID})` result `.parentID` | key absent | `"ses_<parent>"` |
| HTTP `GET /api/session?parentID=<root>` | — | lists the child |
| execution / step / tool event data | no parent key | no parent key (own `sessionID` only) |
| `session.context()` messages | no parent key | no parent key |

**Exact `session.created` shape for a model-spawned child** (`probe-lineage.jsonl`,
2026-09-25 run):

```json
{"sessionID":"ses_f2b531c22fferkdt3oasOoPCzf",
 "projectID":"470c8549ef01a2a9d3c85b22965766cefc874134",
 "location":{"directory":"/tmp"},
 "subpath":"",
 "parentID":"ses_f2b5334bfffeL3hMu80BIHYwa3",
 "slug":"gentle-moon",
 "title":"Verify lineage response",
 "agent":"general",
 "version":"2.0.15"}
```

**Exact `client.session.get` result keys for the child:**
`['id','parentID','projectID','agent','cost','tokens','time','title','location']` — root has
no `parentID` key (`['id','projectID','cost','tokens','time','title','location']`).

### How the child was produced (primary path)

Scripted `opencode serve` + `session.prompt` on the root session, free model
`opencode/space-bunny-free`, instruction to use the `subagent` tool. The model called the
v2 tool (event name `subagent`, `session.tool.input.started name="subagent"`) with:

```json
{"agent":"general","description":"Verify lineage response",
 "prompt":"Reply with exactly lineage-child-ok.","background":false}
```

→ child `session.created` (parentID set) → child `session.execution.started` /
`session.step.*` / `session.execution.succeeded` → root `session.tool.success`. The child's
own `session.get` and the root's `GET /api/session?parentID=` confirm the link. One
observed model flake (earlier run): a first tool call with `"model":"space-bunny-free"`
failed (`Invalid model ... Use "providerID/modelID"`) and the model recovered on the next
step with `"model":"opencode/space-bunny-free"`; the child still carried `parentID`. A
second observed child had no `model` key at all (inherited) — `agent`/`model` are optional.

### Breadth of attempts (so "not observable" cannot be claimed prematurely)

1. **Model-driven `subagent` tool** (primary): three child sessions across two
   probe runs, `parentID` present in every one (run 1: two children — the model's
   first tool call failed on an invalid `model` ref and it recovered on the next
   step; run 2: one child).
2. **Deterministic import control** — `POST /api/experimental/session/import` with an
   explicit `info.parentID`: accepted (HTTP 200), `session.created` and `session.get`
   both expose `parentID` (proves the field flows through the exact event/get path even
   without a model).
3. **Fork control** — `session.fork` on the root: emits `session.forked` with
   `data.parentID` (= fork source) and a `session.forked`-only lifecycle (no
   `session.created`); the **forked session itself has `parentID=null`** and
   `fork:{sessionID,boundary}`; it is **not** returned by `GET /api/session?parentID=`.
   Fork lineage is a separate field, not `parentID`.
4. **Field inventory** — every event `data`, every `session.get`, every `session.context`
   was deep-scanned for `/parent/i` keys: only `session.created:data.parentID`,
   `session.forked:data.parentID`, `session.get.parentID` were found.
5. **Stream parity** — every `session.created` seen on raw `GET /api/event` also appeared
   on the plugin's `client.event.subscribe()` stream (assert L3), so the plugin can
   consume `parentID` directly.
6. `client.session.list` is **absent** on the plugin client surface (`typeof undefined`,
   assert L6/probe), consistent with contract §3.2; the HTTP list-by-parent is server-side
   only.

## Contract-facing conclusions (revision input)

1. **§9 item "subagent lineage / parentID": close as observable.** `parentID` is an
   optional `Session.Info` field (OpenAPI: `{type:"string", pattern:"^ses"}`) populated by
   the subagent flow; it is visible in `session.created` data and `session.get` results.
2. **§2.1 field list extension (recommended):** child `session.created` data observed with
   `{sessionID, projectID, location, subpath, parentID?, slug, title, agent?, model?, version}`;
   `agent`/`model` appear when the spawn specified them (optional).
3. **Downstream impact (03 implementation, out of this ticket's writable scope):** the
   current `src/v2/types.ts` / projection does not consume `parentID` (03 was implemented
   on the "never populated" assumption), so v1 lineage features (`primarySession` /
   `childSessions` / `synchronizeIdleDescendants`) and root token aggregation over child
   sessions remain unfilled even though the data is available. This is a follow-up work
   item for dev-lead (new ticket or 03/04 revision); ticket 05 did not modify `src/**`.
4. **04 dependency unchanged:** nothing in the waiting/reply paths depends on lineage.
5. **Fork caveat for any future projection:** forked sessions use `fork.sessionID` and are
   not `parentID` children; a `session.created`-only consumer never sees them (they emit
   `session.forked` instead).

## Limitations

- Single opencode version (2.0.15) and single agent (`general`); no nested subagents
  (config default `subagent_depth = 1` prevents a subagent from spawning subagents).
- The model-driven path is inherently model-dependent (free model); the deterministic
  import control is the stable, model-free proof of field observability.
- `parentID` absence on roots is inferred from the key being absent (schema-optional), not
  from an explicit `null`; downstream code must treat missing as "root/unknown".
