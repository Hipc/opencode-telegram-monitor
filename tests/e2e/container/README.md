# Container e2e harness + real-TG smoke recipe (ticket 05)

Reproducible, container-only verification tooling for the opencode v2 adaptation
(`docs/modules/opencode-v2-contract.md`). Everything runs inside docker; nothing
is installed on the host and no local opencode directory is touched.

| File | Purpose |
|---|---|
| `run.sh` | host entrypoint for every scenario |
| `lib/common.sh` | docker/port/ownership helpers |
| `probe-a1/` | §9/A.1 + A.6 supplementary probe (form reply channel, natural question flow) |
| `probe-lineage/` | §9 supplementary probe (subagent lineage / parentID observability) |
| `harness/` | container e2e scenario + mechanism-validation double + real-TG recipe scripts |
| `assert/` | node assertion suites over the collected evidence |
| `evidence/` | recorded outputs of the green runs in this round |

Requirements: docker with `hipc/opencode2:latest` (opencode v2.0.15) and
`otg-toolchain:latest` (node+bun for the bundle build); `node` on the host for
the assertion scripts.

Resource discipline: every container runs `--rm` with a unique `t05`/`t05b-`
name, no ports are published (the serve port lives in the container network
namespace and is picked dynamically, checked against the host listener table),
and the runner stops what it starts. `run.sh clean` removes leftover `t05*`
containers if a run is interrupted.

---

## 1. §9/A probe — form reply channel + natural question flow

```sh
tests/e2e/container/run.sh probe-a1          # ~25 s, container-only
tests/e2e/container/run.sh assert-probe-a1   # assertions over the evidence
```

Evidence: `evidence/probe-a1/` (`probe-a1.jsonl`, `sse-raw.txt`, `server-log.txt`,
`commands.txt`, `api-*.json`). Findings and the contract-facing verdict:
**`probe-a1/VERDICT.md`**.

Result summary (all 18 checks green):

- `client.rpc.session.form.reply` is **absent** (`Object.keys(client.rpc)` is
  `["register"]`); the client surface has no form/inbox reply method.
- **Supported channel:** in-process `fetch` to the server's own loopback API —
  `POST http://127.0.0.1:<port>/api/session/<sessionID>/form/<formID>/reply`
  with `authorization: Basic base64("opencode:" + <password>)`,
  `content-type: application/json`, body `{"answer":{"<key>": <value>}}` → `204`.
  Port from `process.argv` (`serve --port N`); password from
  `OPENCODE_SERVER_PASSWORD` / `OPENCODE_PASSWORD` (both visible to the plugin).
  No-auth and Bearer both return 401. `GET /openapi.json` carries the full API
  spec (`session.form.reply`, `session.form.cancel`, `session.inbox.*`).
- Natural question flow (A.6): the model `question` tool creates a
  `form.created` with `metadata.kind="question"`, fields `q0..qN`
  (`title`=`header`, `description`=question, options, `custom`), and after the
  plugin answers it, `form.replied` → `session.tool.success` →
  `session.execution.succeeded`. Headless `opencode run` auto-cancels the form
  (no UI); `opencode serve` keeps it pending, which is the flow the TG wizard
  can service.
- Limitation for the contract revision: port discovery only works when the
  server has a discoverable port (`opencode run --standalone` uses
  `serve --stdio --port 0`), so the reply step must fail visibly when it cannot
  be resolved — no invented fallback.

---

## 1b. §9 probe — subagent lineage / parentID

```sh
tests/e2e/container/run.sh probe-lineage          # ~50 s incl. one model turn
tests/e2e/container/run.sh assert-probe-lineage   # evidence summary
```

Findings and the contract-facing verdict: **`probe-lineage/VERDICT.md`**.
Evidence: `evidence/probe-lineage/`.

Result summary (all 7 structural checks green):

- **parent linkage IS observable**: a child session spawned by the real `subagent`
  tool carries `parentID` in `session.created` data and in
  `client.session.get` results; `GET /api/session?parentID=<root>` lists it.
- Deterministic model-free control: `POST /api/experimental/session/import` with
  an explicit `info.parentID` produces the same observable shape.
- Fork control: `session.fork` emits `session.forked` with `data.parentID`
  (= source), but the forked session itself has `parentID=null` and
  `fork:{sessionID,boundary}` — it is not a `parentID` child.
- No parent key appears in execution/step/tool event data or `session.context`.
- Contract input: §9 item closed as observable in contract revision r2; §2.1/
  §3.1 record the child-session shape (`parentID?` / `agent?` / `model?`). The
  adapted `src/**` consumes `parentID` since `401e7c1` (F1), restoring the v1
  parent/root projection and root token aggregation.

---

## 2. Container e2e harness

Drives a real opencode v2 server with the plugin under test auto-discovered
from `<configDir>/plugin/telegram-session-monitor.ts`, a synthetic
`~/.otg/telegram.json` (no real credentials) and a pre-seeded
`~/.otg/projects.json` (`enabled: true`). Scripted sessions are deterministic
API triggers (`opencode api`), no model is required.

```sh
# mechanism validation (stub double, ~20 s):
T05_HARNESS_FORM_REPLY=1 tests/e2e/container/run.sh harness \
  --plugin tests/e2e/container/harness/plugins/harness-stub.ts
T05_HARNESS_FORM_REPLY=1 tests/e2e/container/run.sh assert-harness

# green-run against the adapted plugin (tickets 03+04 merged; builds the
# bundle from this worktree, 20 checks green — catalog 22, H3.6/H3.7 run only
# with the resolved-reply flags — see evidence/harness):
T05_HARNESS_FORM_REPLY=1 tests/e2e/container/run.sh harness
T05_HARNESS_FORM_REPLY=1 tests/e2e/container/run.sh assert-harness

# optional settled-request capture (ticket 04 isNotFoundError evidence; run
# into its own evidence dir so the canonical green-run evidence stays intact):
T05_HARNESS_OUT="$PWD/tests/e2e/container/evidence/harness-resolved-reply" \
T05_HARNESS_FORM_REPLY=1 T05_HARNESS_RESOLVED_REPLY=1 T05_HARNESS_REPLY_ERROR_PROBE=1 \
  tests/e2e/container/run.sh harness
T05_HARNESS_OUT="$PWD/tests/e2e/container/evidence/harness-resolved-reply" \
T05_HARNESS_FORM_REPLY=1 T05_HARNESS_RESOLVED_REPLY=1 T05_HARNESS_REPLY_ERROR_PROBE=1 \
  tests/e2e/container/run.sh assert-harness
```

`T05_HARNESS_FORM_REPLY=1` additionally exercises the form write-back closure
(only meaningful once the plugin implements the §9/A.1 channel; without it the
form check is reported as `pending`, never as a failure). `T05_HARNESS_MODEL=1`
adds an optional model-backed success turn (slow/flaky by nature; off by
default). `T05_HARNESS_RESOLVED_REPLY=1` adds P2c: it restores the pending
permission record and re-injects `reply:"once"` after the request was settled
(stale TG button), capturing the plugin's 404 classification / raw error shape
in `tgdiag-resolved-reply.txt`. `T05_HARNESS_REPLY_ERROR_PROBE=1` additionally
loads a diagnostic double that re-calls `client.permission.reply` on the settled
request and writes the full client-side error shape to `reply-error-shape.json`.

### Phases and observables

| Phase | Trigger | Observable |
|---|---|---|
| P0 | `opencode serve` + `plugin.list` boot | loader line `loading plugin .../telegram-session-monitor.ts`; `tgdiag.log` init marker |
| P1 | `session.permission.create` / `session.form.create` | `projects.json` SessionRecords `type=permission` (after the 1 s debounce) and `type=question` (immediate), `message` = full payload JSON |
| P2 | external `reply:"once"` injection (same write the TG button does) | record deleted + `permission.replied` on `GET /api/event` |
| P2b | external `q_answers:[["A"]]` injection (same write the TG wizard does) | record deleted + `form.replied` on the wire |
| P3 | bogus model + `session.prompt` → `session.execution.failed` | terminal notification attempt in `tgdiag.log` (`Telegram message send failed`) |
| P2c | optional settled-request re-reply (stale button) | H3.6 terminal-required: settled reply classified 404 (record deleted, no retry loop) in `tgdiag-resolved-reply.txt`; `reply-error-shape.json` client-side shape |

Assertion catalog (`assert/harness.mjs`): 22 check IDs — H1.1–H1.3 loading/init,
H2.1x permission record, H2.2x question record, H3.1/H3.2/H3.2a/H3.3 permission
closure, H3.4–H3.5 form closure (gated), H3.6 settled-reply classification
(gated; terminal-required — 404 must delete the record with no retry loop),
H3.7 client-side error-shape capture (gated), H4.1–H4.2 lifecycle. The canonical
green-run executes 20 of the 22 IDs; with the `RESOLVED_REPLY` +
`REPLY_ERROR_PROBE` flags all 22 run.
Green output is recorded in `evidence/harness/commands.txt` and the assertion
transcript is embedded in the ticket return.

Note on H3.3: the adapted plugin's success path is silent by design — it logs
only the 404 terminal path and apply failures (contract §3.3 / 04). H3.3
therefore asserts "the request was tracked and no apply failure was logged";
the positive closure evidence is H3.1 (record deleted) plus H3.2/H3.2a
(`permission.replied` on the wire with the injected decision). The earlier
stub-era regex expected a stub-only diag marker and was fixed here.

### Bundle build

```sh
tests/e2e/container/run.sh build   # copies the worktree into otg-toolchain and runs node scripts/build.mjs
```

The artifact is written to `evidence/build/plugin-under-test.ts` (generated,
not committed); the transcript is committed. The harness never builds on the
host.

---

## 3. Real-TG smoke recipe

Reads the host `~/.otg` (real bot credentials) **read-only**, copies it inside
the container, and drives one trivial session through a long-lived
`opencode serve` until the terminal notification send is attempted (and
asserted). `T05_REAL_SMOKE_HOST_OTG=<dir>` points the recipe at a synthetic
copy instead of `~/.otg` — used for the send-path mechanism check in §3b. The
host directory is never written (verified below).

### 3a. Read-only mount check (runnable now, no Telegram traffic)

```sh
tests/e2e/container/run.sh real-tg-recipe --check
```

Observed evidence (`evidence/real-tg-recipe/commands.txt`):

- `/host-otg` appears in `/proc/mounts` with `ro`;
- `touch /host-otg/...` fails with `Read-only file system`;
- the config copies to `/tmp/home/.otg` (6 entries, names/sizes only printed);
- a marker written into the copy does not appear under `/host-otg`.

### 3b. Full run (final verification phase) — serve-based, asserts the send path

```sh
# safe mode (default): the container never calls getUpdates, so it cannot
# compete with the host bot. Lifecycle notifications still send.
tests/e2e/container/run.sh real-tg-recipe --run

# full mode: the container may poll getUpdates (waiting-record notifications);
# only run when no other opencode instance is active for the same bot token.
T05_REAL_SMOKE_FULL=1 tests/e2e/container/run.sh real-tg-recipe --run
```

Inside the container (`harness/real-tg-recipe.sh`):

1. refuses to continue if `/host-otg` is writable;
2. copies `/host-otg` to `/tmp/home/.otg` (real `telegram.json` is used as-is;
   contents are never printed);
3. writes a synthetic `projects.json` in the **copy** with the container project
   `/tmp/proj` `enabled: true` (the host registry points at host paths);
4. records the pre-run diag line offset (the copy is a snapshot, so every later
   line belongs to this run); safe mode writes a fresh guard `poller.lock` and
   **keeps refreshing its mtime every 10 s** for the whole run — the lock TTL is
   60 s, so a longer run must not let the container consider the lock stale and
   poll `getUpdates` against the host bot; full mode removes copied lock files;
5. starts a long-lived `opencode serve --hostname 127.0.0.1 --port <free>` with
   a synthetic password and drives one trivial turn via `opencode api
   session.create` + `session.prompt`; after `step ended ... finish=stop` it
   **keeps the server alive ≥ 15 s** so the 5 s idle debounce finalizes and the
   ✅ terminal notification send actually fires, then stops the server process
   group and confirms the port is released;
6. collects `tgdiag.log`, the server log, the password-filtered serve stdout and
   the copied registry into `evidence/real-tg-recipe/`, and finally scans
   **this run's own diag block** (pre-run offset + plugin PID) for the send.

**Expected observations:** one `✅` lifecycle notification for `proj` in the
real Telegram chat; the run's own diag block shows `MODULE LOADED` /
`initialize() called` / `runTelegram() started`, `poller lock held elsewhere`
(safe mode; no `getUpdates` lines) and the proxy send diagnostics
`requestViaProxy[sendRichMessage] ... http done status=200`; host `~/.otg`
unchanged (fingerprints in `host-otg-{before,after,diff}.txt`, identical
headers so the diff compares entries only).

**The recipe FAILS unless the run's own diag block shows a send attempt** —
absence of a failure line alone is no longer sufficient. Possible RESULT lines:

- `RESULT: ok send succeeded ...` — `sendRichMessage http 200` in this run's block;
- `RESULT: FAIL send attempt reached Telegram but was rejected (401); ...` — the
  attempt is proven but the token is invalid (expected in the synthetic check);
- `RESULT: FAIL send attempt failed before Telegram accepted it ...`;
- `RESULT: FAIL send attempt started but no completion line observed`;
- `RESULT: FAIL no send attempt observed` — no send diagnostics at all,
  including the pre-fix `opencode run --standalone` shape where the server exits
  before the 5 s debounce fires (`dispose` clears the timer).

The container exits non-zero on any FAIL. Duration: ~20-40 s (model turn + 15 s
hold + shutdown), plus the one-off bundle build.

Note: the positive (`200`) check reads the **proxy transport** diagnostics
(`requestViaProxy[sendRichMessage]`); a direct-mode config (no `proxy`) emits no
send-success line, so a successful direct-mode send would be reported as
`no send attempt observed`. The recipe targets the host config, which uses the
proxy.

#### Send-path mechanism check (synthetic credentials, no real messages)

Run the same recipe against a synthetic `/host-otg` copy — the real `~/.otg` is
not mounted, no real message is sent:

```sh
mkdir -p /tmp/tg-synthetic-otg
cat > /tmp/tg-synthetic-otg/telegram.json <<'JSON'
{"botToken":"123456:TESTTOKEN_DO_NOT_USE","chatId":"123","proxy":"http://10.0.10.100:17892"}
JSON
T05_REAL_SMOKE_HOST_OTG=/tmp/tg-synthetic-otg \
  tests/e2e/container/run.sh real-tg-recipe --run
```

Success criterion: the run's own diag block shows the send attempt reaching
Telegram — `requestViaProxy[sendRichMessage] ... http done status=401` plus
`[error] Telegram message send failed {"error":"TelegramApiError(401)"}`, 5 s
after `step ended` (the idle debounce). The recipe reports FAIL **by design**
here (the fake token is rejected); the proof is the attempt, not a 200.
Recorded output: `evidence/real-tg-sendpath-check/` (2026-09-25, plugin bundle
built from this worktree).

---

## 4. Status (explicitly not faked)

- **Green-run against the adapted plugin (tickets 03/04)** — **done**: 20
  checks green (catalog 22; H3.6/H3.7 run only with the resolved-reply flags),
  form write-back closure included (`evidence/harness/`, run 2026-09-25 on task
  HEAD `8f3572f`).
- **Settled-request reply capture (ticket 04 `isNotFoundError`)** — **done and
  fixed**: the real v2 `client.permission.reply` error on an already-settled
  request is a plain `Error` (`name="Error"`,
  `message="Permission request not found: <perID>"`, no `status`/`_tag`/
  enumerable props); since `401e7c1` (F2) `isNotFoundError` classifies that
  exact text as terminal — record deleted, no retry loop (contract §3.3 r2).
  Raw HTTP 404 body `{"_tag":"PermissionNotFoundError",...}` and the full
  client-side shape are in `evidence/harness-resolved-reply/`.
- **Subagent lineage / parentID** — **done** (see §1b): observable and
  consumed by `src/**` since `401e7c1` (F1); contract revision r2 closes the
  §9 item.
- **Real-TG smoke execution** — **pending** (final verification phase, real
  credentials): the `--run` recipe is now serve-based and fails unless this
  run's own diag block shows a send attempt (it no longer runs
  `opencode run --standalone`, which exited before the 5 s idle debounce could
  fire). The send path itself is self-checked with synthetic credentials —
  `evidence/real-tg-sendpath-check/` shows the proxy send attempt reaching
  Telegram 5 s after `step ended` (401 rejection, by design); the
  real-credential `--run` executes in the orchestrator's final phase.
- **Model-backed success lifecycle** — `T05_HARNESS_MODEL=1` optional path;
  the deterministic P3 failure path is the default CI-stable lifecycle check.

## 5. Evidence layout

`evidence/probe-a1/` form-channel probe run · `evidence/probe-lineage/`
subagent-lineage probe run · `evidence/harness/` green-run against the adapted
plugin (20 checks green — catalog 22, form phase included; H3.6/H3.7 run only
with the settled-reply flags) ·
`evidence/harness-resolved-reply/` settled-request capture (H3.6/H3.7) ·
`evidence/real-tg-recipe/` read-only mount check ·
`evidence/real-tg-sendpath-check/` synthetic-credential send-path mechanism
check (serve-based recipe; `RESULT: FAIL ... rejected (401)` by design — the
proof is the send attempt in the run's own diag block) · `evidence/build/`
toolchain build transcript. Regenerating any scenario replaces its evidence
directory (`run.sh` wipes it first), so re-running is safe and reproducible.
