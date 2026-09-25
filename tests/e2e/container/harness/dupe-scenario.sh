#!/usr/bin/env bash
# t09-dupe-fix container scenario — runs INSIDE hipc/opencode2:latest.
#
# Regression scenario for the field incident "trigger one question → continuous
# repeated Telegram messages": multiple plugin monitors sharing one registry
# append duplicate SessionRecords for the same request_id (all send=false).
# Before the fix the poller sent the first unsent copy, marked only the first
# match, and every scan re-sent the remaining copies.
#
# This scenario seeds TWO permission copies with the same request_id (plus one
# question record) directly in ~/.otg/projects.json and points the plugin at
# the fake Telegram endpoint (harness/fake-telegram.mjs) so sends SUCCEED:
#   - exactly one sendRichMessage per request_id over many scan rounds;
#   - every duplicate copy ends send=true (single-round self-heal);
#   - the wizard send's message_id is persisted as q_msg_id (unwrapped-response
#     parse fix) and the shape diagnostic records typeof=object keys=message_id.
#
# Transport trust: the fake endpoint terminates TLS with a test cert for
# api.telegram.org; NODE_TLS_REJECT_UNAUTHORIZED=0 is set for THIS container
# only (test infrastructure — no product code path is relaxed).
#
# Environment: T05_PLUGIN, T05_PORT, T05_PASSWORD, T09_FAKE_TG_HOST,
# T09_FAKE_TG_PORT, T09_DUPE_OBSERVE_SECONDS (default 15).
set -x

export HOME=/tmp/home
ROOT=/tmp/proj
mkdir -p "$HOME/.config/opencode/plugin" "$HOME/.otg" "$ROOT"
cd "$ROOT"

PLUGIN_SRC="${T05_PLUGIN:?T05_PLUGIN required}"
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

# ---- duplicate seed (two same-request_id copies + one question) --------------
NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
sed "s/__NOW__/$NOW/g" /harness/configs/projects.dupe-seed.json > "$HOME/.otg/projects.json"

PORT="${T05_PORT:?T05_PORT required}"
set +x
PW="${T05_PASSWORD:?T05_PASSWORD required}"
export OPENCODE_SERVER_PASSWORD="$PW"
export OPENCODE_PASSWORD="$PW"
set -x

# Trust the fake endpoint's test certificate for this container only.
export NODE_TLS_REJECT_UNAUTHORIZED=0

DIAG="$HOME/.otg/tgdiag.log"
SERVER_LOG="$HOME/.local/share/opencode/log/opencode.log"

setsid opencode serve --hostname 127.0.0.1 --port "$PORT" --print-logs \
  > /tmp/t09-dupe-serve.log 2>&1 &
SPID=$!
API="opencode api --server http://127.0.0.1:$PORT"

# Boot the plugin subsystem (plugin.list triggers lazy plugin loading).
for i in $(seq 1 60); do
  $API plugin.list > /dev/null 2>&1 && break
  sleep 0.5
done
for i in $(seq 1 60); do
  grep -q 'loading plugin.*telegram-session-monitor.ts' "$SERVER_LOG" 2>/dev/null && break
  sleep 0.5
done
for i in $(seq 1 60); do
  grep -q 'MODULE LOADED' "$DIAG" 2>/dev/null && break
  sleep 0.5
done
# Wait until the sessions scan ticker is up (poller lock acquired in-container).
for i in $(seq 1 60); do
  grep -q 'sessions scan: starting 1s ticker' "$DIAG" 2>/dev/null && break
  sleep 0.5
done

# Observation window: many 1s scan rounds. Before the fix this window contains
# 2+ sends for the duplicated request_id (one per scan round); after the fix
# exactly one.
sleep "${T09_DUPE_OBSERVE_SECONDS:-15}"

# ---- collect evidence --------------------------------------------------------
cp "$HOME/.otg/projects.json" /evidence/projects-after-dupe.json
cp "$DIAG" /evidence/tgdiag-dupe.txt 2>/dev/null || true
cp "$SERVER_LOG" /evidence/server-log.txt 2>/dev/null || true
grep -v 'server password' /tmp/t09-dupe-serve.log > /evidence/serve-stdout.txt 2>/dev/null || true

# ---- stop cleanly (process group; verify no leftovers) -----------------------
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
else
  echo "ok: serve stopped, port $PORT released, no leftover opencode serve process"
  echo "RESULT: ok dupe scenario completed"
fi
echo "--- this run's scan/send lines ---"
grep -E 'MODULE LOADED|setup\(\)|sessions scan|Session record send failed|Question wizard send returned no message_id|sendMessageWithKeyboard response' "$DIAG" || true
