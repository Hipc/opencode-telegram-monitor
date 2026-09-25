# §9/A.1 + A.6 supplementary probe — verdict (ticket 05)

**Run:** opencode **v2.0.15** in `hipc/opencode2:latest`, 2026-09-25, container-only.
**Reproduce:** `tests/e2e/container/run.sh probe-a1` (then `run.sh assert-probe-a1`).
**Raw evidence:** `tests/e2e/container/evidence/probe-a1/` (`probe-a1.jsonl`, `sse-raw.txt`,
`server-log.txt`, `commands.txt`, `api-*.json`).

## Verdict: form reply channel **SUPPORTED** (in-process HTTP, Basic auth)

A plugin running inside the opencode server process can settle a form with a plain `fetch`
against the server's own loopback HTTP API:

```
POST http://127.0.0.1:<port>/api/session/<sessionID>/form/<formID>/reply
Headers:
  authorization: Basic base64("opencode:" + <password>)
  content-type: application/json
Body:
  {"answer": {"<fieldKey>": <value>, ...}}
Response:
  204 No Content                — form settled, form.replied emitted
  401 Unauthorized              — missing/wrong credentials (Bearer is NOT accepted)
  400 FormInvalidAnswerError | InvalidRequestError
  404 SessionNotFoundError | FormNotFoundError
  409 FormAlreadySettledError
```

- `<port>`: discovered from `process.argv` (`["bun","/$bunfs/root/opencode","serve","--port","<N>",...]`).
- `<password>`: `process.env.OPENCODE_SERVER_PASSWORD` (serve side) or
  `process.env.OPENCODE_PASSWORD` (client env) — **both were visible inside the plugin process**
  (`probe.setup.envPresence`, evidence run 2026-09-25).
- Username is the literal `opencode` (observed Basic challenge `realm="Secure Area"`; Basic with
  `opencode:<password>` → 200/204, Bearer → 401).
- OpenAPI 3.1 document: `GET /openapi.json` (auth required, 250 037 bytes) — operation
  `session.form.reply`; `session.form.cancel` = `DELETE /api/session/<sid>/form/<fid>`;
  global list = `GET /api/form`.
- Answer value types (`Form.Value` in the OpenAPI spec): string | number | boolean |
  array-of-string (multiselect). Option fields use `option.value` (string), not the label.

## Evidence matrix (all observed in one green run)

| Check | Result | Evidence |
|---|---|---|
| Deterministic control form (created via `opencode api session.form.create`) | no-auth **401**, Bearer **401**, Basic **204**, `form.replied` on both plugin stream and `GET /api/event` | `probe-a1.jsonl` (`probe.reply.http.attempt`, `form.replied`), `sse-raw.txt` |
| Natural question flow (A.6): model calls the `question` tool | `form.created` with `metadata.kind="question"` | `probe-a1.jsonl`, `sse-raw.txt` |
| Natural form answered by the plugin over the channel | `form.replied` + `session.tool.success` (question call) + `session.execution.succeeded` | `probe-a1.jsonl` |
| `client.rpc.session.form.reply` | **ABSENT** — `Object.keys(client.rpc)` = `["register"]` only; recursive walk found no form/inbox/answer/reply/question member | `probe.setup.rpcPaths`, `probe.reply.rpc.candidate` |
| `client.session` namespace | no form/inbox/answer methods (hook/create/get/switchAgent/switchModel/prompt/generate/command/synthetic/interrupt/update/move/wait/context) | `probe.setup.clientSurface` |
| `client.permission.reply` | present (control; contract §3.1) | `probe.setup.clientSurface` |
| Bearer token auth | rejected 401 (`www-authenticate: Basic realm="Secure Area"`) | `probe.reply.http.attempt` (`bearer`) |

Breadth of attempts (so "no supported channel" cannot be claimed prematurely): client surface
enumeration (top level + per-namespace + recursive `rpc` walk with interest filter), HTTP matrix
(no-auth / Bearer / Basic), plus the natural-flow end-to-end reply. The rpc path and every
non-Basic HTTP variant were tried and are recorded as failures/absences.

## A.6 natural question flow — exact shape (contract §2.6 input)

Prompt: `Use the question tool to ask me which option I prefer: option A or option B. Do not use
any other tool. After asking, stop.` (free default model, `opencode serve` + `session.prompt`).

Event sequence (observed):

```
session.tool.input.started   {id:"call_...", name:"question"}
session.tool.called          {id:"call_...", input:{questions:[{question, header, options:[{label, description}]}]}}
form.created                 {form:{id:"frm_...", sessionID, title:"Questions",
                                  metadata:{kind:"question", tool:{messageID, id:"call_..."}},
                                  fields:[{key:"q0", title:"Preference", description:"Which option do you prefer?",
                                           type:"string", options:[{value:"Option A", label:"Option A", description:"Select option A"}, ...],
                                           custom:true}]}}
form.replied                 {id:"frm_...", sessionID, answer:{q0:"Option A"}}
session.tool.success         {id:"call_..."}
session.execution.succeeded  {sessionID}
```

Contract-relevant observations:

1. `data.form.metadata` (`{kind:"question", tool:{messageID, id}}`) is present on natural
   question forms and **absent** on API-created forms. §2.6's field list should be extended
   with `metadata?` (recommended, not required for the waiting record).
2. `fields[]` items carry `description` and `custom` in addition to the §2.6 list — the frozen
   list already allows extra fields for rendering; no change needed.
3. Question-tool fields map `questions[] -> fields[]` with keys `q0..qN`, `title = header`,
   `description = question`, `options = [{value:label, label, description}]`, `custom:true`.
4. Headless `opencode run` **auto-cancels** the form immediately (`form.cancelled` →
   `session.tool.failed {type:"aborted"}` → `session.execution.interrupted {reason:"shutdown"}`)
   because there is no UI to present it. Under `opencode serve` the form stays pending until a
   reply arrives — this is the flow the plugin's TG wizard can service.
5. A pending question form does not block the session's `execution.*` terminal events in the
   serve scenario after a reply; if never answered it stays pending (no auto-cancel observed).

## Limitations / open points for the contract revision

- **Port discovery:** the channel needs the loopback port. It is in `process.argv` for
  `opencode serve --port N`, but `opencode run --standalone` starts `serve --stdio --port 0`
  (ephemeral port, not in argv), so the in-process HTTP channel is only usable when the port is
  discoverable (explicit serve / service mode). Ticket 04 must not invent a fallback: if the
  port cannot be resolved, the reply step must fail visibly (log), per the no-fallback rule.
- The channel is an **HTTP loopback call**, not a client-contract method — the contract's
  "HTTP `fetch` to自身 server" decision (§3.2) is the one that must be revised by dev-lead.
- No `session.form.reply` method exists on the plugin client surface in v2.0.15; this probe is
  the evidence the contract §9/A.1 requires before ticket 04 wires form reply.
