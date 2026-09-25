#!/usr/bin/env bash
# t12 event-ownership scenario — runs INSIDE hipc/opencode2:latest.
#
# Field incident (t12): one `opencode serve` process activates the plugin once
# per location/root (field log: ~7 activations with different roots), and every
# monitor subscribes to the SAME global v2 event stream. Before the fix each
# monitor processed every session's events, so one completed session produced
# N terminal notifications with N different project labels (one correct, the
# rest from unrelated projects).
#
# This scenario reproduces the multi-root topology deterministically in ONE
# serve process:
#   - activation A: `opencode api plugin.list` with cwd /tmp/projA;
#   - activation B: `GET /api/plugin?location[directory]=/tmp/projB` in the
#     same process (probe-confirmed: two setups, one pid);
#   - a session is created and failed deterministically in A (bogus model, no
#     real model needed); its terminal notification goes to the fake Telegram
#     endpoint (harness/fake-telegram.mjs, test cert via
#     NODE_TLS_REJECT_UNAUTHORIZED=0, container-local only).
#
# Expected (post-fix): exactly ONE sendRichMessage, labelled projA; the projB
# monitor stays inert and logs `event skipped: location not owned by this
# instance` (once per foreign directory). Negative control (pre-fix bundle):
# >=2 sends, at least one carrying the projB label with the same session row.
#
# Evidence (mounted /evidence): fake-telegram.jsonl, tgdiag-final.txt,
# setup-lines.txt, projects-final.json, sse-raw.txt, server-log.txt,
# api-*.json, phase-ids.json, serve-stdout.txt.
#
# Environment: T12_PLUGIN (required), T12_PORT, T12_PASSWORD,
# T12_ROOT_A (default /tmp/projA), T12_ROOT_B (default /tmp/projB),
# T09_FAKE_TG_HOST/T09_FAKE_TG_PORT (default fake-tg:8443),
# T12_OBSERVE_SECONDS (default 12).
set -eux

export HOME=/tmp/home
ROOT_A="${T12_ROOT_A:-/tmp/projA}"
ROOT_B="${T12_ROOT_B:-/tmp/projB}"
mkdir -p "$HOME/.config/opencode/plugin" "$HOME/.otg" "$ROOT_A" "$ROOT_B"

PLUGIN_SRC="${T12_PLUGIN:?T12_PLUGIN required}"
cp "$PLUGIN_SRC" "$HOME/.config/opencode/plugin/telegram-session-monitor.ts"

# ---- synthetic config pointing at the fake Telegram endpoint ----------------
FAKE_HOST="${T09_FAKE_TG_HOST:-fake-tg}"
FAKE_PORT="${T09_FAKE_TG_PORT:-8443}"
cat > "$HOME/.otg/telegram.json" <<EOF
{
  "botToken": "123456789:AAsyntheticBotTokenForE2E000000",
  "chatId": "100200300",
  "proxy": "http://${FAKE_HOST}:${FAKE_PORT}"
}
EOF

# ---- registry: BOTH roots enabled (the field registry is shared) ------------
NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
cat > "$HOME/.otg/projects.json" <<EOF
{
  "projects": [
    { "path": "$ROOT_A", "enabled": true, "addedAt": "$NOW" },
    { "path": "$ROOT_B", "enabled": true, "addedAt": "$NOW" }
  ]
}
EOF

PORT="${T12_PORT:?T12_PORT required}"
set +x
PW="${T12_PASSWORD:?T12_PASSWORD required}"
export OPENCODE_SERVER_PASSWORD="$PW"
export OPENCODE_PASSWORD="$PW"
set -x

# Trust the fake endpoint's test certificate for this container only.
export NODE_TLS_REJECT_UNAUTHORIZED=0

DIAG="$HOME/.otg/tgdiag.log"
SERVER_LOG="$HOME/.local/share/opencode/log/opencode.log"
API="opencode api --server http://127.0.0.1:$PORT"

# ---- P0: serve + activation A (cwd ROOT_A) ----------------------------------
cd "$ROOT_A"
setsid opencode serve --hostname 127.0.0.1 --port "$PORT" --print-logs \
  > /tmp/t12-serve.log 2>&1 &
SPID=$!
for i in $(seq 1 60); do
  $API plugin.list > /dev/null 2>&1 && break
  sleep 0.5
done
for i in $(seq 1 60); do
  grep -q "setup() pid=$SPID root=$ROOT_A" "$DIAG" 2>/dev/null && break
  sleep 0.5
done
grep -q "setup() pid=$SPID root=$ROOT_A" "$DIAG" || { echo "FATAL: activation A never appeared"; exit 1; }
echo "t12: activation A root=$ROOT_A"

# ---- P0b: activation B in the SAME process (explicit location) --------------
B_ENC="$(printf '%s' "$ROOT_B" | sed 's|/|%2F|g')"
curl -s -u "opencode:$PW" \
  "http://127.0.0.1:$PORT/api/plugin?location%5Bdirectory%5D=$B_ENC" \
  > /evidence/api-plugin-b.json
for i in $(seq 1 60); do
  grep -q "setup() pid=$SPID root=$ROOT_B" "$DIAG" 2>/dev/null && break
  sleep 0.5
done
grep -q "setup() pid=$SPID root=$ROOT_B" "$DIAG" || { echo "FATAL: activation B never appeared"; exit 1; }
echo "t12: activation B root=$ROOT_B (same pid $SPID)"
grep "setup() pid=$SPID" "$DIAG" > /evidence/setup-lines.txt || true
curl -s -u "opencode:$PW" "http://127.0.0.1:$PORT/api/debug/location" > /evidence/debug-locations.json

# ---- raw SSE evidence (server-side view of the global stream) ---------------
set +x
curl -s -N -u "opencode:$PW" "http://127.0.0.1:$PORT/api/event" > /evidence/sse-raw.txt &
SSEPID=$!
set -x
sleep 1

# ---- P1: session in A -------------------------------------------------------
SESSION_OUT="$($API session.create -d '{"title":"t12-ownership"}')"
echo "$SESSION_OUT" > /evidence/api-session-create.json
SID="$(printf '%s' "$SESSION_OUT" | sed -n 's/.*"id":"\(ses_[^"]*\)".*/\1/p' | head -1)"
[ -n "$SID" ] || { echo "FATAL: session.create failed"; exit 1; }
echo "t12: session $SID created in A"
for i in $(seq 1 40); do
  grep -q "$SID" /evidence/sse-raw.txt 2>/dev/null && break
  sleep 0.5
done

# ---- P2: deterministic failing execution (no model) -------------------------
$API session.switchModel --param sessionID="$SID" \
  -d '{"model":{"id":"definitely-not-a-model","providerID":"opencode"}}' \
  > /evidence/api-switch-model.json 2>&1 || true
timeout 90 $API session.prompt --param sessionID="$SID" -d '{"text":"hello"}' \
  > /evidence/api-prompt.json 2>&1 || true

# ---- P3: terminal notification -> fake TG (5s idle debounce + send) ---------
for i in $(seq 1 90); do
  grep -q '"method":"sendRichMessage"' /evidence/fake-telegram.jsonl 2>/dev/null && break
  sleep 1
done
# Observation window: duplicates (pre-fix) keep arriving here.
sleep "${T12_OBSERVE_SECONDS:-12}"

# ---- collect evidence -------------------------------------------------------
cp "$DIAG" /evidence/tgdiag-final.txt 2>/dev/null || true
cp "$HOME/.otg/projects.json" /evidence/projects-final.json 2>/dev/null || true
cp "$SERVER_LOG" /evidence/server-log.txt 2>/dev/null || true
grep -v 'server password' /tmp/t12-serve.log > /evidence/serve-stdout.txt 2>/dev/null || true
printf '{"pid":%s,"sessionID":"%s","rootA":"%s","rootB":"%s"}\n' \
  "$SPID" "$SID" "$ROOT_A" "$ROOT_B" > /evidence/phase-ids.json
echo "--- setup / skip / send lines ---"
grep -E "setup\(\)|event skipped|terminal notification" "$DIAG" || true

# ---- stop cleanly (process group; verify no leftovers) ----------------------
kill -TERM "$SSEPID" 2>/dev/null || true
kill -TERM -"$SPID" 2>/dev/null || true
# Bounded wait for the serve process tree to actually exit (the listener can
# close before the process finishes its shutdown).
for i in $(seq 1 60); do
  alive=""
  for p in /proc/[0-9]*; do
    [ -r "$p/cmdline" ] || continue
    cmd=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null)
    case "$cmd" in
      *opencode\ serve*)
        state=$(sed -n 's/^State:[[:space:]]*\([A-Z]\).*/\1/p' "$p/status" 2>/dev/null)
        [ "$state" = "Z" ] || alive="$alive ${p#/proc/}"
        ;;
    esac
  done
  [ -z "$alive" ] && break
  sleep 0.5
done
wait "$SPID" 2>/dev/null || true
if [ -n "$alive" ]; then
  echo "WARN: serve still alive after TERM; killing process group"
  kill -KILL -"$SPID" 2>/dev/null || true
  sleep 1
  alive=""
  for p in /proc/[0-9]*; do
    [ -r "$p/cmdline" ] || continue
    cmd=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null)
    case "$cmd" in
      *opencode\ serve*)
        state=$(sed -n 's/^State:[[:space:]]*\([A-Z]\).*/\1/p' "$p/status" 2>/dev/null)
        [ "$state" = "Z" ] || alive="$alive ${p#/proc/}"
        ;;
    esac
  done
fi
if [ -n "$alive" ]; then
  echo "RESULT: FAIL serve leftover process(es):$alive"
else
  echo "ok: serve stopped, port $PORT released, no leftover opencode serve process"
  echo "RESULT: ok t12-ownership scenario completed"
fi
