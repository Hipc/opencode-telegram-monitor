#!/usr/bin/env bash
# Ticket 05 supplementary probe — contract §9 open item: subagent lineage
# (parentID) observability in opencode v2.
#
# Runs INSIDE hipc/opencode2:latest.
#
# Phases:
#   P0  serve boots with an explicit --port and OPENCODE_SERVER_PASSWORD; the
#       lineage probe plugin is auto-discovered from
#       <configDir>/plugin/t05-probe-lineage.ts and records every event.
#   P1  root session created through `opencode api`.
#   P2  model-driven subagent attempt: the free model is prompted to call the
#       `subagent` tool; the plugin captures every session.created / execution /
#       step / tool event and probes session.get + session.context for each
#       session that appears.
#   P2b retry with a more explicit prompt when P2 produced no child session.
#   P3  deterministic control: import a child session whose Session.Info carries
#       parentID (POST /api/experimental/session/import) — proves whether the
#       field is observable in session.created / session.get when it is set.
#   P4  fork control: fork the root (it has messages after P2) and capture the
#       fork result + session.forked event.
#   P5  server-side list by parentID (HTTP) and full session list.
#
# Evidence (mounted /evidence): probe-lineage.jsonl (raw plugin stream +
# session probes), sse-raw.txt, server-log.txt, api-*.json, commands transcript.
#
# Environment: T05_PORT, T05_PASSWORD, T05_PROBE_LOG.
set -x

export HOME=/tmp/home
mkdir -p "$HOME/.config/opencode/plugin" "$HOME/.otg"
cd /tmp
cp /probe-lineage/plugin.ts "$HOME/.config/opencode/plugin/t05-probe-lineage.ts"

PORT="${T05_PORT:?T05_PORT required}"
# Credential handling is untraced: the synthetic serve password must not end up
# in the committed evidence transcript.
set +x
PW="${T05_PASSWORD:?T05_PASSWORD required}"
LOG="${T05_PROBE_LOG:-/evidence/probe-lineage.jsonl}"
export T05_PROBE_LOG="$LOG"
export OPENCODE_SERVER_PASSWORD="$PW"
export OPENCODE_PASSWORD="$PW"
set -x

setsid opencode serve --port "$PORT" --print-logs > /tmp/serve.log 2>&1 &
SPID=$!
API="opencode api --server http://127.0.0.1:$PORT"

# ---- P0: boot + plugin subscription -----------------------------------------
for i in $(seq 1 60); do
  $API plugin.list > /dev/null 2>&1 && break
  sleep 0.5
done
for i in $(seq 1 60); do
  grep -q '"type":"probe.setup"' "$LOG" 2>/dev/null && break
  sleep 0.5
done
sleep 1

# Raw server-side SSE, to compare the plugin stream with the wire stream.
set +x
curl -s -N -u "opencode:$PW" "http://127.0.0.1:$PORT/api/event" > /evidence/sse-raw.txt &
SSEPID=$!
set -x

# ---- P1: root session --------------------------------------------------------
ROOT_OUT=$($API session.create -d '{"title":"lineage-root"}')
echo "$ROOT_OUT" > /evidence/api-root-session.json
ROOT=$(echo "$ROOT_OUT" | grep -o '"id":"ses_[^"]*"' | head -1 | cut -d'"' -f4)
echo "ROOT=$ROOT"
for i in $(seq 1 40); do
  grep -q "\"sessionID\":\"$ROOT\"" "$LOG" 2>/dev/null && break
  sleep 0.5
done
sleep 1

# Child sessions = created sessions other than the root.
child_ids() {
  grep '"type":"session.created"' "$LOG" 2>/dev/null \
    | grep -o '"sessionID":"ses_[^"]*"' | cut -d'"' -f4 | sort -u \
    | grep -v "^${ROOT}$" || true
}
# First child session id in file order. NOTE: filter on the extracted id, not on
# the raw line — a child's session.created line contains the root id in parentID.
first_child_id() {
  grep '"type":"session.created"' "$LOG" 2>/dev/null \
    | grep -o '"sessionID":"ses_[^"]*"' | cut -d'"' -f4 \
    | grep -v "^${ROOT}$" | head -1
}
wait_child() { # <seconds>
  local limit="$1"
  for _ in $(seq 1 "$limit"); do
    [ -n "$(child_ids)" ] && return 0
    sleep 2
  done
  return 1
}
wait_child_terminal() { # <child> <seconds>
  local child="$1" limit="$2"
  for _ in $(seq 1 "$limit"); do
    grep -E '"type":"session\.execution\.(succeeded|failed|interrupted)"' "$LOG" 2>/dev/null \
      | grep -q "$child" && return 0
    sleep 2
  done
  return 1
}

# ---- P2: model-driven subagent attempt ---------------------------------------
SUBAGENT_PROMPT='Use the subagent tool to launch a general subagent. Pass agent general and prompt: Reply with exactly lineage-child-ok. Do not use any other tool. When the subagent finishes, reply with exactly lineage-parent-done.'
timeout 300 $API session.prompt --param sessionID="$ROOT" \
  -d "{\"text\":\"$SUBAGENT_PROMPT\",\"delivery\":\"queue\"}" \
  > /evidence/api-subagent-prompt.json 2>&1 || true
echo "P2 prompt_exit=$?"

CHILD=""
if wait_child 60; then
  CHILD=$(first_child_id)
  echo "P2 child=$CHILD"
  wait_child_terminal "$CHILD" 45 || echo "P2 WARN: no child terminal event"
else
  echo "P2: no child session observed after prompt #1"
fi

# ---- P2b: explicit retry (only when P2 produced no child) --------------------
if [ -z "$CHILD" ]; then
  RETRY_PROMPT='Call the subagent tool now. Required arguments: agent general, description lineage probe, prompt Reply with exactly lineage-child-ok-2. Do not ask questions. Do not use any other tool.'
  timeout 300 $API session.prompt --param sessionID="$ROOT" \
    -d "{\"text\":\"$RETRY_PROMPT\",\"delivery\":\"queue\"}" \
    > /evidence/api-subagent-prompt2.json 2>&1 || true
  echo "P2b prompt_exit=$?"
  if wait_child 60; then
    CHILD=$(first_child_id)
    echo "P2b child=$CHILD"
    wait_child_terminal "$CHILD" 45 || echo "P2b WARN: no child terminal event"
  else
    echo "P2b: no child session observed after prompt #2"
  fi
fi

# Record the child session.created line (parentID source) for the record.
if [ -n "$CHILD" ]; then
  grep '"type":"session.created"' "$LOG" | grep "\"sessionID\":\"$CHILD\"" | head -1 \
    > /evidence/child-session-created.json
fi

# ---- P3: deterministic import control (parentID set explicitly) --------------
set +x
curl -s -u "opencode:$PW" "http://127.0.0.1:$PORT/api/session/$ROOT" > /tmp/root-info.json
set -x
PROJ=$(grep -o '"projectID":"[^"]*"' /tmp/root-info.json | head -1 | cut -d'"' -f4)
DIR=$(grep -o '"directory":"[^"]*"' /tmp/root-info.json | head -1 | cut -d'"' -f4)
NOW=$(date +%s)000
IMPORT_ID="ses_t05lineageimportchild000001"
IMPORT_MSG_ID="msg_t05lineageimportseed0000001"
printf '{"info":{"id":"%s","parentID":"%s","projectID":"%s","cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":%s,"updated":%s},"title":"t05 lineage import child","location":{"directory":"%s"}},"messages":[{"id":"%s","time":{"created":%s},"text":"lineage import seed","type":"user"}]}' \
  "$IMPORT_ID" "$ROOT" "$PROJ" "$NOW" "$NOW" "${DIR:-/tmp}" "$IMPORT_MSG_ID" "$NOW" \
  > /tmp/import-child.json
set +x
curl -s -o /evidence/api-import-child.json -w '%{http_code}' -u "opencode:$PW" \
  -H 'content-type: application/json' -X POST --data-binary @/tmp/import-child.json \
  "http://127.0.0.1:$PORT/api/experimental/session/import" \
  > /evidence/api-import-child.status 2>&1 || true
set -x
echo "P3 import status=$(cat /evidence/api-import-child.status 2>/dev/null)"
sleep 5

# ---- P4: fork control (root now has messages) --------------------------------
FLINE=$(grep -c '"type":"session.forked"' "$LOG" 2>/dev/null || true)
timeout 60 $API session.fork --param sessionID="$ROOT" -d '{}' \
  > /evidence/api-fork-root.json 2>&1 || true
for _ in $(seq 1 10); do
  grep -q '"type":"session.forked"' "$LOG" 2>/dev/null && break
  sleep 1
done
sleep 2

# ---- P5: server-side linkage views -------------------------------------------
set +x
curl -s -u "opencode:$PW" "http://127.0.0.1:$PORT/api/session?parentID=$ROOT" \
  > /evidence/api-list-children.json
curl -s -u "opencode:$PW" "http://127.0.0.1:$PORT/api/session" \
  > /evidence/api-session-list.json
set -x

# ---- wrap up -----------------------------------------------------------------
sleep 5
echo "--- plugin loader lines ---"
grep -E 'loading plugin|failed to load plugin|configured plugin' "$HOME/.local/share/opencode/log/opencode.log" || true
cp "$HOME/.local/share/opencode/log/opencode.log" /evidence/server-log.txt 2>/dev/null || true
kill -TERM $SSEPID 2>/dev/null || true
kill -TERM -$SPID 2>/dev/null || true
sleep 1
echo "--- evidence line count ---"
wc -l "$LOG" /evidence/sse-raw.txt 2>/dev/null || true
echo "CHILD=${CHILD:-none}"
