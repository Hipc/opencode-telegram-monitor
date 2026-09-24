#!/usr/bin/env bash
# Real-TG smoke recipe — full run (executed by the orchestrator with the
# adapted plugin; NOT run automatically in ticket 05).
#
# Sends exactly one real Telegram lifecycle notification for a trivial model
# turn. The host ~/.otg is mounted read-only and copied to /tmp/home/.otg; all
# writes (registry, lock, diag) land in the copy only. Credentials are never
# printed.
#
# Run shape: `opencode serve` stays alive while `opencode api` drives one
# trivial session to completion. The terminal notification flows
# session.execution.succeeded -> idle -> 5 s idle debounce -> finalizeIdle ->
# sendMessage, so the server is kept alive well past the debounce (>= 15 s
# after `step ended ... finish=stop`) before it is stopped. The recipe then
# scans THIS run's own diag block (line offset captured before serve + the
# plugin PID) and FAILS unless a send attempt is visible there; absence of a
# failure line alone is not evidence of a send.
#
# Environment:
#   T05_PLUGIN          path to the adapted single-file bundle (inside /plugin)
#   T05_PORT            loopback port for `opencode serve` (inside the container)
#   T05_PASSWORD        synthetic serve password (never printed; api client env)
#   T05_REAL_SMOKE_FULL 0 (default, safe: poller lock guarded, no getUpdates)
#                       or 1 (container takes the lock; requires no other
#                       opencode instance running against the same bot token)
#
# Expected observations (see README runbook):
#   - the real Telegram chat receives one ✅ lifecycle notification for the
#     container project ("proj");
#   - THIS run's diag block (PID-scoped, past the pre-run line offset) shows
#     MODULE LOADED / initialize() called / runTelegram() started,
#     `requestViaProxy[sendRichMessage] ... http done status=200` (send
#     succeeded), and NO "Telegram message send failed" line;
#   - in safe mode the diag shows "poller lock held elsewhere" and no
#     `getUpdates` line (the guard lock is refreshed for the whole run);
#   - the host ~/.otg is byte-identical (read-only mount + verified isolation).
#
# With synthetic credentials the same recipe is the send-path mechanism check:
# a 401 rejection line proves the send attempt reached Telegram (see README
# §3b); the recipe reports FAIL because the send itself did not succeed.
#
# Note: the positive send check reads the proxy transport diagnostics; a
# direct-mode config (no proxy) emits no send-success line, so a direct-mode
# success is reported as "no send attempt observed". The host config uses the
# proxy, which is what this recipe targets.
set -x

export HOME=/tmp/home
ROOT=/tmp/proj
mkdir -p "$HOME/.config/opencode/plugin" "$HOME/.otg" "$ROOT"
cd "$ROOT"

PLUGIN_SRC="${T05_PLUGIN:?T05_PLUGIN required}"
cp "$PLUGIN_SRC" "$HOME/.config/opencode/plugin/telegram-session-monitor.ts"

# ---- 1. read-only host mount guard -----------------------------------------
if touch /host-otg/t05-must-not-write 2>/dev/null; then
  rm -f /host-otg/t05-must-not-write
  echo "FATAL: /host-otg is writable; refusing to run the real-TG recipe"
  exit 1
fi
echo "ok: /host-otg is read-only"

# ---- 2. copy the real otg dir into the container ---------------------------
if [ -n "$(ls -A /host-otg 2>/dev/null)" ]; then
  cp -r /host-otg/. "$HOME/.otg/"
fi
if [ ! -f "$HOME/.otg/telegram.json" ]; then
  echo "FATAL: /host-otg/telegram.json is missing; cannot run the real-TG recipe"
  exit 1
fi
echo "ok: telegram.json copied (content not printed)"

# ---- 3. synthetic registry for the container project root -------------------
# The host registry points at host paths; the container project is /tmp/proj.
# Replacing it in the COPY (never the host) enables lifecycle notifications.
printf '{\n  "projects": [\n    {\n      "path": "%s",\n      "enabled": true,\n      "addedAt": "%s"\n    }\n  ]\n}\n' \
  "$ROOT" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" > "$HOME/.otg/projects.json"

# ---- 4. poller lock policy --------------------------------------------------
# Diag offset: every line written from here on belongs to THIS run (the copy is
# a snapshot; the host never writes into it). The send-attempt assertion is
# scoped to this offset + the plugin PID so historical send lines copied from
# the host diag can never satisfy it.
DIAG="$HOME/.otg/tgdiag.log"
DIAG_BEFORE=0
if [ -f "$DIAG" ]; then
  DIAG_BEFORE=$(wc -l < "$DIAG")
fi
echo "diag lines before this run: $DIAG_BEFORE"

SAFE=1
GUARD_PID=""
if [ "${T05_REAL_SMOKE_FULL:-0}" = "1" ]; then
  SAFE=0
  rm -f "$HOME/.otg"/*.lock
  echo "mode: FULL — the container may poll getUpdates; no other opencode must be running"
else
  printf '{"pid":1,"host":"t05-host-guard","ownerId":"t05-host-guard","createdAt":%s}' \
    "$(date +%s%3N)" > "$HOME/.otg/poller.lock"
  touch "$HOME/.otg/poller.lock"
  echo "mode: SAFE — poller lock guarded; lifecycle notifications only, no getUpdates"
  # A real host holder keeps the lock fresh. The lock TTL is 60 s, so a run
  # longer than that must keep refreshing the guard mtime — otherwise the
  # container would consider the lock stale, steal it and poll getUpdates
  # against the host bot (the exact competition safe mode exists to prevent).
  ( while [ ! -e /tmp/t05-guard-stop ]; do
      touch "$HOME/.otg/poller.lock" 2>/dev/null
      sleep 10
    done ) &
  GUARD_PID=$!
fi

# ---- 5. long-lived serve: one trivial model turn ----------------------------
PORT="${T05_PORT:?T05_PORT required}"
# Credential handling is untraced: the synthetic serve password must not end up
# in the evidence transcript.
set +x
PW="${T05_PASSWORD:?T05_PASSWORD required}"
export OPENCODE_SERVER_PASSWORD="$PW"
export OPENCODE_PASSWORD="$PW"
set -x

run_block() {
  # Diag lines written by this run only (everything past the pre-run offset).
  sed -n "$((DIAG_BEFORE + 1)),\$p" "$DIAG" 2>/dev/null
}

setsid opencode serve --hostname 127.0.0.1 --port "$PORT" --print-logs \
  > /tmp/t05-serve.log 2>&1 &
SPID=$!
API="opencode api --server http://127.0.0.1:$PORT"

# opencode serve boots plugins lazily: the first instance-level API call
# activates the plugin subsystem, and plugin.list is the call that triggers it.
for i in $(seq 1 60); do
  $API plugin.list > /dev/null 2>&1 && break
  sleep 0.5
done
for i in $(seq 1 60); do
  run_block | grep -q 'MODULE LOADED' && break
  sleep 0.5
done

RUN_PID=$(run_block | sed -n 's/^.*\[\([0-9][0-9]*\)\] MODULE LOADED.*$/\1/p' | head -1)
echo "run plugin pid: ${RUN_PID:-<none>}"

run_lines() {
  if [ -n "$RUN_PID" ]; then
    run_block | grep -F "[$RUN_PID]"
  else
    run_block
  fi
}

SID=""
if [ -n "$RUN_PID" ]; then
  SES_OUT=$($API session.create -d '{"title":"real-tg-smoke"}')
  echo "$SES_OUT" > /evidence/api-session-create.json
  SID=$(echo "$SES_OUT" | grep -o '"id":"ses_[^"]*"' | head -1 | cut -d'"' -f4)
  echo "SID=$SID"
  SHORT=$(echo "$SID" | sed 's/^ses_//' | cut -c1-8)
fi

if [ -n "$SID" ]; then
  timeout 120 $API session.prompt --param sessionID="$SID" \
    -d '{"text":"Reply with exactly: tg-smoke-ok"}' \
    > /evidence/api-session-prompt.json 2>&1
  echo "prompt_exit=$?"

  # Turn completion: the plugin logs `step ended session=<short> finish=stop`
  # when the final step ends; session.execution.succeeded follows immediately.
  TERMINAL_AT=""
  for i in $(seq 1 240); do
    if run_lines | grep -q "step ended session=$SHORT"; then
      TERMINAL_AT=$(date +%s)
      break
    fi
    sleep 1
  done
  if [ -z "$TERMINAL_AT" ]; then
    echo "WARN: no step-ended marker for $SHORT within the wait window"
    TERMINAL_AT=$(date +%s)
  fi

  # Keep the server alive >= 15 s after the turn so the 5 s idle debounce
  # finalizes and the terminal notification send is actually attempted.
  while [ $(( $(date +%s) - TERMINAL_AT )) -lt 15 ]; do
    sleep 1
  done
  echo "held server alive $(( $(date +%s) - TERMINAL_AT ))s after turn completion"

  # Give a slow proxy a bounded window to record the attempt's outcome.
  for i in $(seq 1 30); do
    if run_lines | grep -qE 'requestViaProxy\[sendRichMessage\]|Telegram message send failed'; then
      break
    fi
    sleep 1
  done
else
  echo "WARN: no session created (plugin run block or session.create failed); nothing was driven"
fi

# ---- 6. stop the server cleanly (process group; verify no leftovers) --------
if [ "$SAFE" = "1" ]; then
  touch /tmp/t05-guard-stop
  kill "$GUARD_PID" 2>/dev/null || true
fi
kill -TERM -$SPID 2>/dev/null || true
wait $SPID 2>/dev/null || true
for i in $(seq 1 20); do
  if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/"; then
    sleep 0.5
  else
    break
  fi
done
if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/"; then
  echo "WARN: serve still responding after TERM; killing process group"
  kill -KILL -$SPID 2>/dev/null || true
  sleep 1
fi

# No leftovers: scan /proc for a live (non-zombie) `opencode serve` process.
leftovers=""
for p in /proc/[0-9]*; do
  [ -r "$p/cmdline" ] || continue
  cmd=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null)
  case "$cmd" in
    *opencode\ serve*)
      state=$(sed -n 's/^State:[[:space:]]*\([A-Z]\).*/\1/p' "$p/status" 2>/dev/null)
      [ "$state" = "Z" ] || leftovers="$leftovers ${p#/proc/}"
      ;;
  esac
done
if [ -n "$leftovers" ]; then
  echo "RESULT: FAIL serve leftover process(es):$leftovers"
  SERVER_STOPPED=0
else
  echo "ok: serve stopped, port $PORT released, no leftover opencode serve process"
  SERVER_STOPPED=1
fi

# ---- 7. collect observables -------------------------------------------------
cp "$DIAG" /evidence/tgdiag-real-smoke.txt 2>/dev/null || true
cp "$HOME/.local/share/opencode/log/opencode.log" /evidence/server-log.txt 2>/dev/null || true
cp "$HOME/.otg/projects.json" /evidence/projects-after-smoke.json 2>/dev/null || true
# serve stdout can carry the generated/synthetic password line; never evidence it.
grep -v 'server password' /tmp/t05-serve.log > /evidence/serve-stdout.txt 2>/dev/null || true

echo "--- this run's diag block (pid=${RUN_PID:-unknown}) ---"
run_lines | grep -E 'MODULE LOADED|initialize\(\) called|runTelegram|poller lock|bootstrap|inbox enqueued|step ended|requestViaProxy\[sendRichMessage\]|Telegram message send failed|Telegram rejected' || true

# ---- 8. send-attempt assertion (the core of this recipe) --------------------
# FAIL unless THIS run's own diag block shows the send path firing.
if [ -z "$RUN_PID" ]; then
  RESULT_LINE="RESULT: FAIL no send attempt observed (no plugin MODULE LOADED line for this run)"
  EXIT_CODE=1
elif run_lines | grep -q 'requestViaProxy\[sendRichMessage\] http done status=200'; then
  RESULT_LINE="RESULT: ok send succeeded (sendRichMessage http 200 in this run's diag block)"
  EXIT_CODE=0
elif run_lines | grep -q 'Telegram message send failed'; then
  if run_lines | grep -qE 'TelegramApiError\(401\)|http done status=401'; then
    RESULT_LINE="RESULT: FAIL send attempt reached Telegram but was rejected (401); expected only with synthetic/invalid credentials"
  else
    RESULT_LINE="RESULT: FAIL send attempt failed before Telegram accepted it (see diag block above)"
  fi
  EXIT_CODE=1
elif run_lines | grep -q 'requestViaProxy\[sendRichMessage\] start'; then
  RESULT_LINE="RESULT: FAIL send attempt started but no completion line observed"
  EXIT_CODE=1
else
  RESULT_LINE="RESULT: FAIL no send attempt observed"
  EXIT_CODE=1
fi

if [ "$SAFE" = "1" ] && run_lines | grep -q 'getUpdates'; then
  echo "RESULT: FAIL safe mode violated: this run attempted getUpdates"
  RESULT_LINE="RESULT: FAIL safe mode violated: this run attempted getUpdates"
  EXIT_CODE=1
fi
if [ "$SERVER_STOPPED" = "0" ]; then
  RESULT_LINE="RESULT: FAIL serve did not stop cleanly (leftover process/listener)"
  EXIT_CODE=1
fi

echo "--- evidence ---"
wc -l "$DIAG" /evidence/tgdiag-real-smoke.txt /evidence/serve-stdout.txt 2>/dev/null || true
echo "$RESULT_LINE"
exit "$EXIT_CODE"
