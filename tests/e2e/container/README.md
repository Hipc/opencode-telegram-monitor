# Container e2e harness + real-TG smoke recipe (ticket 05)

Reproducible, container-only verification tooling for the opencode v2 adaptation
(`docs/modules/opencode-v2-contract.md`). Everything runs inside docker; nothing
is installed on the host and no local opencode directory is touched.

| File | Purpose |
|---|---|
| `run.sh` | host entrypoint for every scenario |
| `lib/common.sh` | docker/port/ownership helpers |
| `probe-a1/` | §9/A.1 + A.6 supplementary probe (form reply channel, natural question flow) |
| `harness/` | container e2e scenario + mechanism-validation double + real-TG recipe scripts |
| `assert/` | node assertion suites over the collected evidence |
| `evidence/` | recorded outputs of the green runs in this round |

Requirements: docker with `hipc/opencode2:latest` (opencode v2.0.15) and
`otg-toolchain:latest` (node+bun for the bundle build); `node` on the host for
the assertion scripts.

Resource discipline: every container runs `--rm` with a unique `t05-` name,
no ports are published (the serve port lives in the container network
namespace and is picked dynamically, checked against the host listener table),
and the runner stops what it starts. `run.sh clean` removes leftover `t05-`
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

## 2. Container e2e harness

Drives a real opencode v2 server with the plugin under test auto-discovered
from `<configDir>/plugin/telegram-session-monitor.ts`, a synthetic
`~/.otg/telegram.json` (no real credentials) and a pre-seeded
`~/.otg/projects.json` (`enabled: true`). Scripted sessions are deterministic
API triggers (`opencode api`), no model is required.

```sh
# mechanism validation now (stub double, ~18 s, all 20 checks green):
T05_HARNESS_FORM_REPLY=1 tests/e2e/container/run.sh harness \
  --plugin tests/e2e/container/harness/plugins/harness-stub.ts
T05_HARNESS_FORM_REPLY=1 tests/e2e/container/run.sh assert-harness

# final green-run (after tickets 03/04 are merged; builds the bundle first):
tests/e2e/container/run.sh harness            # T05_PLUGIN_SRC defaults to this worktree
T05_HARNESS_FORM_REPLY=1 tests/e2e/container/run.sh assert-harness
```

`T05_HARNESS_FORM_REPLY=1` additionally exercises the form write-back closure
(only meaningful once the plugin implements the §9/A.1 channel; without it the
form check is reported as `pending`, never as a failure). `T05_HARNESS_MODEL=1`
adds an optional model-backed success turn (slow/flaky by nature; off by
default).

### Phases and observables

| Phase | Trigger | Observable |
|---|---|---|
| P0 | `opencode serve` + `plugin.list` boot | loader line `loading plugin .../telegram-session-monitor.ts`; `tgdiag.log` init marker |
| P1 | `session.permission.create` / `session.form.create` | `projects.json` SessionRecords `type=permission` (after the 1 s debounce) and `type=question` (immediate), `message` = full payload JSON |
| P2 | external `reply:"once"` injection (same write the TG button does) | record deleted + `permission.replied` on `GET /api/event` |
| P2b | external `q_answers:[["A"]]` injection (same write the TG wizard does) | record deleted + `form.replied` on the wire |
| P3 | bogus model + `session.prompt` → `session.execution.failed` | terminal notification attempt in `tgdiag.log` (`Telegram message send failed`) |

Assertion catalog (`assert/harness.mjs`): H1.1–H1.3 loading/init,
H2.1x permission record, H2.2x question record, H3.1–H3.3 permission closure,
H3.4–H3.5 form closure (gated), H4.1–H4.2 lifecycle.
Green output is recorded in `evidence/harness/commands.txt` and the assertion
transcript is embedded in the ticket return.

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
the container, and runs one brief real notification. The host directory is
never written (verified below).

### 3a. Mechanism check (runnable now, no Telegram traffic)

```sh
tests/e2e/container/run.sh real-tg-recipe --check
```

Observed evidence (`evidence/real-tg-recipe/commands.txt`):

- `/host-otg` appears in `/proc/mounts` with `ro`;
- `touch /host-otg/...` fails with `Read-only file system`;
- the config copies to `/tmp/home/.otg` (6 entries, names/sizes only printed);
- a marker written into the copy does not appear under `/host-otg`.

### 3b. Full run (orchestrator-scheduled after 03/04)

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
4. safe mode: writes a fresh guard `poller.lock` so the copied lock is
   not-stale and the container does not poll for up to 60 s (a brief run stays
   under that); full mode: removes copied `*.lock` files;
5. runs `timeout 180 opencode run --standalone "Reply with exactly: tg-smoke-ok"`
   with the plugin auto-discovered;
6. collects `tgdiag.log`, the server log and the copied registry into
   `evidence/real-tg-recipe/`, and reports whether any send-failure line exists.

**Expected observations:** one `✅` lifecycle notification for `proj` in the
real Telegram chat; the copied `tgdiag.log` shows `MODULE LOADED` /
`initialize() called` / `runTelegram() started` and **no**
`Telegram message send failed`; in safe mode `poller lock held elsewhere`;
host `~/.otg` unchanged (the runner also records before/after fingerprints in
`host-otg-{before,after,diff}.txt` as information).

---

## 4. Pending items (explicitly not faked)

- **Final green-run against the adapted plugin (tickets 03/04)** — pending by
  design; the orchestrator schedules `run.sh harness` + `assert-harness` after
  both merge. The stub run above validates the harness mechanics only.
- **Real-TG smoke execution** — pending until the adapted bundle exists; the
  mechanism is validated now (§3a).
- **Form write-back closure** — the channel is proven (§1), the harness phase is
  ready and gated; it passes against the stub double. It turns green for the
  real plugin once 04 applies `q_answers` through the contract-revised channel.
- **Model-backed success lifecycle** — `T05_HARNESS_MODEL=1` optional path;
  the deterministic P3 failure path is the default CI-stable lifecycle check.

## 5. Evidence layout

`evidence/probe-a1/` raw probe run · `evidence/harness/` stub-run mechanism
validation (all checks green, form phase included) · `evidence/real-tg-recipe/`
read-only mount check · `evidence/build/` toolchain build transcript.
Regenerating any scenario replaces its evidence directory (`run.sh` wipes it
first), so re-running is safe and reproducible.
