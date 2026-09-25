#!/usr/bin/env bash
# Ticket 05 §9/A.1 + A.6 probe — runs INSIDE hipc/opencode2:latest.
#
# Phases:
#   P1  serve boots with an explicit --port and OPENCODE_SERVER_PASSWORD; the
#       probe plugin is auto-discovered from <configDir>/plugin/t05-probe-a1.ts.
#   P2  deterministic control form created through `opencode api` (no model) —
#       the probe plugin replies to it over the candidate channel.
#   P3  natural question flow (A.6): the model is prompted to call the
#       `question` tool; the resulting form.created is answered by the probe
#       plugin, and the question tool outcome is observed.
#
# Evidence (mounted /evidence):
#   probe-a1.jsonl      raw plugin JSONL (surface dump, every event, reply matrix)
#   sse-raw.txt         raw GET /api/event SSE stream (server-side view)
#   server-log.txt      opencode server log (plugin loader lines)
#   api-*.json/txt      command outputs
#
# Environment: T05_PORT, T05_PASSWORD, T05_PROBE_LOG, T05_PROBE_REPLY=1.
set -x

export HOME=/tmp/home
mkdir -p "$HOME/.config/opencode/plugin" "$HOME/.otg"
cd /tmp
cp /probe-a1/plugin.ts "$HOME/.config/opencode/plugin/t05-probe-a1.ts"

PORT="${T05_PORT:?T05_PORT required}"
# Credential handling is untraced: the synthetic serve password must not end up
# in the committed evidence transcript.
set +x
PW="${T05_PASSWORD:?T05_PASSWORD required}"
LOG="${T05_PROBE_LOG:-/evidence/probe-a1.jsonl}"
export T05_PROBE_LOG="$LOG"
export OPENCODE_SERVER_PASSWORD="$PW"
export OPENCODE_PASSWORD="$PW"
set -x

setsid opencode serve --port "$PORT" --print-logs > /tmp/serve.log 2>&1 &
SPID=$!
API="opencode api --server http://127.0.0.1:$PORT"

# opencode serve boots the instance (and therefore plugins) lazily: the first
# instance-level API call triggers activation, and `plugin.list` is the call
# that actually boots the plugin subsystem (`session.list` does not). Wait for
# the plugin's setup record, then give the event subscription a beat to attach.
for i in $(seq 1 60); do
  $API plugin.list > /dev/null 2>&1 && break
  sleep 0.5
done
for i in $(seq 1 60); do
  grep -q '"type":"probe.setup"' "$LOG" 2>/dev/null && break
  sleep 0.5
done
sleep 1

# Raw server-side SSE, to compare plugin stream vs wire stream.
set +x
curl -s -N -u "opencode:$PW" "http://127.0.0.1:$PORT/api/event" > /evidence/sse-raw.txt &
SSEPID=$!
set -x

# ---- P2: deterministic control form (no model) ----------------------------
CONTROL_OUT=$($API session.create -d '{"title":"t05-a1-control"}')
echo "$CONTROL_OUT" > /evidence/api-session-create.json
SID=$(echo "$CONTROL_OUT" | grep -o '"id":"ses_[^"]*"' | head -1 | cut -d'"' -f4)
echo "SID=$SID"
# Prove the session.created event reached the plugin before creating the form.
for i in $(seq 1 40); do
  grep -q "$SID" "$LOG" 2>/dev/null && break
  sleep 0.5
done

$API session.form.create --param sessionID="$SID" \
  -d '{"title":"a1 control form","fields":[{"key":"choice","type":"string","title":"Pick","options":[{"value":"a","label":"A"},{"value":"b","label":"B"}],"custom":true},{"key":"notes","type":"string","title":"Notes"}]}' \
  > /evidence/api-form-create.json
CFID=$(grep -o '"id":"frm_[^"]*"' /evidence/api-form-create.json | head -1 | cut -d'"' -f4)
echo "CFID=$CFID"
# Wait for the probe plugin to answer the control form (deterministic, no model).
for i in $(seq 1 40); do
  grep -qE "\"type\":\"probe.reply.done\",\"payload\":\{\"formID\":\"$CFID\"" "$LOG" 2>/dev/null && break
  sleep 0.5
done
sleep 2

# ---- P3: natural question flow (A.6) ---------------------------------------
timeout 240 $API session.prompt --param sessionID="$SID" \
  -d '{"text":"Use the question tool to ask me which option I prefer: option A or option B. Do not use any other tool. After asking, stop.","delivery":"queue"}' \
  > /evidence/api-natural-prompt.json 2>&1
echo "prompt_exit=$?"

# Wait for a terminal execution event (the plugin answers the form mid-turn).
for i in $(seq 1 180); do
  grep -qE '"type":"session\.execution\.(succeeded|failed|interrupted)"' "$LOG" 2>/dev/null && break
  sleep 1
done
sleep 5

# ---- wrap up ----------------------------------------------------------------
echo "--- plugin loader lines ---"
grep -E 'loading plugin|failed to load plugin|configured plugin' "$HOME/.local/share/opencode/log/opencode.log" || true
cp "$HOME/.local/share/opencode/log/opencode.log" /evidence/server-log.txt 2>/dev/null || true
kill -TERM $SSEPID 2>/dev/null || true
kill -TERM -$SPID 2>/dev/null || true
sleep 1
echo "--- evidence line count ---"
wc -l "$LOG" /evidence/sse-raw.txt 2>/dev/null || true
