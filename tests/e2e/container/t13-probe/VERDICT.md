# t13 shared-storage two-server probe — verdict (P1–P5)

**Run:** opencode **v2.0.15** in `hipc/opencode2:latest`, 2026-09-25, container-only.
**Reproduce:** `tests/e2e/container/run.sh t13-probe` (then `run.sh assert-t13-probe`).
**Raw evidence:** `tests/e2e/container/evidence/t13-probe/` (`t13-probe-final.jsonl`,
`p1-event-delivery.txt`, `p2-*.json/status`, `p3-*.json/status`, `p4-*.json`,
`p5-*.json`, `serve-a.log`, `serve-b.log`, `scenario.txt`).

## Topology

Two real servers share ONE HOME/XDG (the field topology from the incident log):

- **A** = `opencode serve --service --print-logs` — hosts the session; argv has no
  `--port`, env has no `OPENCODE_SERVER_PASSWORD`; registers
  `$XDG_STATE_HOME/opencode/service.json` (`{url,pid,password}`). Plugin root
  `/tmp/home` (`serve --service` activates on HOME).
- **B** = `opencode serve --hostname 127.0.0.1 --port <n> --print-logs` — same HOME,
  same `~/.local/share/opencode`, same `~/.otg`; plugin root `/tmp/home` too (a
  `project.updated` event from the shared storage boots the same location in B —
  `serve-b.log` line `location services booted directory=/tmp/home`).

Session + permission + two forms were created on A via the v2 HTTP API; both
processes ran the t13 probe plugin, which records every event with its pid.

## P1 — event delivery / creator: **only the host receives the session's events**

`t13-probe-final.jsonl` / `p1-event-delivery.txt`:

- A (pid 10) received `session.created`, `permission.asked`, `form.created` (×2),
  then `form.replied` / `form.cancelled` / `permission.replied` after the HTTP calls.
- B (pid 61), with the same root activated and the same storage, received **zero**
  session/form/permission events (its `probe.event` set is empty; only environment
  events such as `provider.updated`).

**Consequence:** the process that receives the `asked` event is the process whose
server hosts the session, so a creation-time `host_pid` stamp is a reliable
host determination (design (a)). B never creates a record for A's session.

## P2 — form route semantics: A (owner) vs B (non-owner)

| Call | A pending | B pending | A settled | B settled |
|---|---|---|---|---|
| `GET /api/session/<sid>/form/<fid>` (`session.form.get`) | **200** `state.status=pending` | **404** `FormNotFoundError` | **200** `state.status=answered` | **404** |
| `GET /api/session/<sid>/form` (`session.form.list`) | 200 `[form]` | 200 `[]` | — | — |
| `POST …/reply` (`session.form.reply`) | **204** | **404** `FormNotFoundError` | **409** `FormAlreadySettledError` | **404** |
| `DELETE …/<fid>` (`session.form.cancel`) | **204** | **404** `FormNotFoundError` | **409** `FormAlreadySettledError` | **404** |

Evidence: `p2-*.status` + `p2-*.json`.

**Consequence:** `404` is **ambiguous** (non-owner pending == non-owner settled ==
owner-missing) and must never be treated as settled; `409 FormAlreadySettledError`
is the only confirmed-settled signal. B's 404 reply does not settle A's form
(`p2-get-a-after-breply.status=200`).

## P3 — permission route semantics

| Call | A pending | B pending | B settled |
|---|---|---|---|
| `GET …/permission/<rid>` (`session.permission.get`) | **200** | **404** `PermissionNotFoundError` | — |
| `GET …/permission` (`session.permission.list`) | 200 `[perm]` | 200 `[]` | — |
| `POST …/permission/<rid>/reply` (`session.permission.reply`) | **204** | **404** `PermissionNotFoundError` | **404** `PermissionNotFoundError` |

Evidence: `p3-*.status` + `p3-*.json`.

**Consequence:** a non-owner can never settle a permission; its
`PermissionNotFoundError` is indistinguishable from the owner's already-settled
response (harness-resolved-reply evidence), so the host gate must run **before**
the reply call. (There is a host-only presence API if a future revision wants a
second layer: `session.permission.get` 200 on the host vs 404 on the non-host.)

## P4 — `session.get` diff: **identical** from A and B

`p4-session-get-a.json` vs `p4-session-get-b.json` (and the raw HTTP bodies) are
byte-identical; the shared DB serves the same payload to the non-host.

**Consequence:** the t10 `session.get` ownership gate fails open in this topology
(explains why `apply skipped` never fired in the field log). This is the direct
justification for the `host_pid` stamp.

## P5 — multiselect field type: **round-trips unchanged**

- `form.created` field: `{"key":"tags","title":"Tags","type":"multiselect","options":[{"value":"x","label":"X"},…],"custom":false}`.
- `session.form.get` on A returns the same shape (`p5-get-a-multiselect.json`).

**Consequence:** the wizard mapping `multiple = field.type === "multiselect"`
(`src/monitor.ts parseQuestionPayload`) is correct; no additional bug.

## Verdict for the fix

The evidence supports **design (a) creation-time host stamp** as the ownership
gate (`host_pid` = the process that received the `asked` event), with the t13
404-classification revision (409 terminal, 404 ambiguous → never delete) and the
legacy `session.get` gate kept only for records without a stamp.
