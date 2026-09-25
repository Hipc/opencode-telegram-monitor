#!/usr/bin/env bash
# Container e2e harness — runs INSIDE hipc/opencode2:latest.
#
# Drives a real opencode v2 server with the plugin under test auto-discovered
# from <configDir>/plugin/telegram-session-monitor.ts and an isolated synthetic
# ~/.otg (telegram.json + pre-seeded projects.json with the project enabled).
#
# Phases (observables in parentheses):
#   P1  waiting records: API-created permission request + form
#       (projects.json SessionRecord type=permission / type=question)
#   P2  permission write-back closure: inject `reply:"once"` exactly like the
#       TG poller does, expect the plugin to apply it via client.permission.reply
#       and delete the record (projects.json + GET /api/event permission.replied)
#   P2b optional form closure (T05_HARNESS_FORM_REPLY=1): inject `q_answers`
#       like the TG wizard submit, expect the plugin to settle the form through
#       the §9/A.1 channel (form.replied + record deletion)
#   P3  lifecycle: deterministic failing execution (bogus model) → terminal
#       notification attempt recorded in ~/.otg/tgdiag.log
#   P2c optional already-resolved reply capture (T05_HARNESS_RESOLVED_REPLY=1):
#       restore the pending permission snapshot, re-inject reply:"once" after the
#       request was settled, and capture the plugin's client.permission.reply
#       error shape / 404 classification in tgdiag-resolved-reply.txt (ticket 04
#       open item: isNotFoundError)
#
# Evidence (mounted /evidence): phase-ids.json, projects-after-*.json,
# tgdiag-after-*.txt, sse-raw.txt, server-log.txt, commands transcript.
#
# Environment: T05_PLUGIN, T05_PORT, T05_PASSWORD, T05_ROOT,
# T05_HARNESS_FORM_REPLY (0/1), T05_HARNESS_MODEL (0/1 optional success path),
# T05_HARNESS_RESOLVED_REPLY (0/1 optional settled-request capture),
# T05_HARNESS_REPLY_ERROR_PROBE (0/1 auxiliary client-error-shape double).
set -x

export HOME=/tmp/home
ROOT="${T05_ROOT:-/tmp/proj}"
mkdir -p "$HOME/.config/opencode/plugin" "$HOME/.otg" "$ROOT"
cd "$ROOT"

PLUGIN_SRC="${T05_PLUGIN:?T05_PLUGIN required}"
cp "$PLUGIN_SRC" "$HOME/.config/opencode/plugin/telegram-session-monitor.ts"
# Auxiliary diagnostic double (off by default): captures the client-side error
# shape of permission.reply on an already-settled request (ticket 04 open item).
if [ "${T05_HARNESS_REPLY_ERROR_PROBE:-0}" = "1" ]; then
  cp /harness/plugins/reply-error-probe.ts "$HOME/.config/opencode/plugin/t05-reply-error-probe.ts"
fi
cp /harness/configs/telegram.synthetic.json "$HOME/.otg/telegram.json"
cp /harness/configs/projects.seed.json "$HOME/.otg/projects.json"

PORT="${T05_PORT:?T05_PORT required}"
set +x
PW="${T05_PASSWORD:?T05_PASSWORD required}"
export OPENCODE_SERVER_PASSWORD="$PW"
export OPENCODE_PASSWORD="$PW"
set -x

PROJECTS="$HOME/.otg/projects.json"
DIAG="$HOME/.otg/tgdiag.log"
SERVER_LOG="$HOME/.local/share/opencode/log/opencode.log"

setsid opencode serve --port "$PORT" --print-logs > /tmp/serve.log 2>&1 &
SPID=$!
API="opencode api --server http://127.0.0.1:$PORT"

# ---- P0: boot (plugin subsystem boots on the first plugin.list call) -------
for i in $(seq 1 60); do
  $API plugin.list > /dev/null 2>&1 && break
  sleep 0.5
done
for i in $(seq 1 60); do
  grep -q 'loading plugin.*telegram-session-monitor.ts' "$SERVER_LOG" 2>/dev/null && break
  sleep 0.5
done
# Wait for the plugin's initialize marker (both the adapted plugin and the
# harness stub emit it); do not hang forever if it never appears.
for i in $(seq 1 40); do
  grep -qE 'MODULE LOADED|initialize\(\) called' "$DIAG" 2>/dev/null && break
  sleep 0.5
done
sleep 3
cp "$DIAG" /evidence/tgdiag-after-boot.txt 2>/dev/null || true

set +x
curl -s -N -u "opencode:$PW" "http://127.0.0.1:$PORT/api/event" > /evidence/sse-raw.txt &
SSEPID=$!
set -x

wait_for_record() { # <request_id> <seconds>
  local rid="$1" limit="$2"
  for _ in $(seq 1 "$limit"); do
    grep -q "\"request_id\": \"$rid\"" "$PROJECTS" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

wait_for_record_gone() { # <request_id> <seconds>
  local rid="$1" limit="$2"
  for _ in $(seq 1 "$limit"); do
    grep -q "\"request_id\": \"$rid\"" "$PROJECTS" 2>/dev/null || return 0
    sleep 1
  done
  return 1
}

inject_json_field() { # <request_id> <field> <json-value> — mimics an external writer
  local rid="$1" field="$2" value="$3"
  for _ in $(seq 1 10); do
    if grep -q "\"request_id\": \"$rid\"" "$PROJECTS" 2>/dev/null; then
      # JSON.stringify(..., null, 2): capture the record field indentation and
      # reuse it for the injected field, so the file stays valid pretty JSON.
      sed -i "s|^\([[:space:]]*\)\"request_id\": \"$rid\",\$|\1\"request_id\": \"$rid\",\n\1\"$field\": $value,|" "$PROJECTS"
      grep -qF "\"$field\": $value" "$PROJECTS" && return 0
    fi
    sleep 1
  done
  return 1
}

# ---- P1: waiting records ----------------------------------------------------
SESSION_OUT=$($API session.create -d '{"title":"e2e-waiting","permissions":[{"action":"shell","resource":"*","effect":"ask"}]}')
echo "$SESSION_OUT" > /evidence/api-session-create.json
SID=$(echo "$SESSION_OUT" | grep -o '"id":"ses_[^"]*"' | head -1 | cut -d'"' -f4)
echo "SID=$SID"
# Ensure the session.created event reached the plugin before further triggers.
for i in $(seq 1 20); do
  grep -q '"type":"session.created"' /evidence/sse-raw.txt 2>/dev/null && break
  sleep 0.5
done
sleep 1

PERM_OUT=$($API session.permission.create --param sessionID="$SID" -d '{"action":"shell","resources":["echo e2e-waiting"]}')
echo "$PERM_OUT" > /evidence/api-permission-create.json
PERID=$(echo "$PERM_OUT" | grep -o '"id":"per_[^"]*"' | head -1 | cut -d'"' -f4)
echo "PERID=$PERID"
wait_for_record "$PERID" 40 || echo "WARN: permission record not observed"
cp "$PROJECTS" /evidence/projects-after-permission.json

FORM_OUT=$($API session.form.create --param sessionID="$SID" \
  -d '{"title":"e2e question","fields":[{"key":"choice","type":"string","title":"Pick","options":[{"value":"a","label":"A"},{"value":"b","label":"B"}],"custom":true}]}')
echo "$FORM_OUT" > /evidence/api-form-create.json
FRMID=$(echo "$FORM_OUT" | grep -o '"id":"frm_[^"]*"' | head -1 | cut -d'"' -f4)
echo "FRMID=$FRMID"
wait_for_record "$FRMID" 40 || echo "WARN: question record not observed"
cp "$PROJECTS" /evidence/projects-after-form.json

printf '{"sessionID":"%s","permissionID":"%s","formID":"%s"}\n' "$SID" "$PERID" "$FRMID" > /evidence/phase-ids.json

# ---- P2: permission write-back closure -------------------------------------
if inject_json_field "$PERID" reply '"once"'; then
  echo "injected reply for $PERID"
else
  echo "WARN: could not inject reply for $PERID"
fi
wait_for_record_gone "$PERID" 30 || echo "WARN: permission record still present"
cp "$PROJECTS" /evidence/projects-after-reply.json

# ---- P2b: optional form write-back closure ---------------------------------
if [ "${T05_HARNESS_FORM_REPLY:-0}" = "1" ]; then
  if inject_json_field "$FRMID" q_answers '[["A"]]'; then
    echo "injected q_answers for $FRMID"
  else
    echo "WARN: could not inject q_answers for $FRMID"
  fi
  wait_for_record_gone "$FRMID" 30 || echo "WARN: question record still present"
  cp "$PROJECTS" /evidence/projects-after-form-reply.json
fi

# ---- P3: lifecycle (deterministic failing execution) ------------------------
LIFE_OUT=$($API session.create -d '{"title":"e2e-lifecycle"}')
echo "$LIFE_OUT" > /evidence/api-lifecycle-session-create.json
BID=$(echo "$LIFE_OUT" | grep -o '"id":"ses_[^"]*"' | head -1 | cut -d'"' -f4)
echo "BID=$BID"
$API session.switchModel --param sessionID="$BID" -d '{"model":{"id":"definitely-not-a-model","providerID":"opencode"}}' \
  > /evidence/api-switch-model.json 2>&1 || true
timeout 90 $API session.prompt --param sessionID="$BID" -d '{"text":"hello"}' \
  > /evidence/api-lifecycle-prompt.json 2>&1 || true
# terminal event → 5s idle debounce → notification attempt (send retries bounded)
for i in $(seq 1 120); do
  grep -qE 'terminal notification attempt failed|Telegram message send failed' "$DIAG" 2>/dev/null && break
  sleep 1
done
cp "$DIAG" /evidence/tgdiag-final.txt

# Optional model-backed success path (kept separate so the default run stays
# deterministic; enabled by the orchestrator for the real TG smoke recipe).
if [ "${T05_HARNESS_MODEL:-0}" = "1" ]; then
  MODEL_OUT=$($API session.create -d '{"title":"e2e-model"}')
  MSID=$(echo "$MODEL_OUT" | grep -o '"id":"ses_[^"]*"' | head -1 | cut -d'"' -f4)
  echo "MSID=$MSID" > /evidence/api-model-session.txt
  timeout 240 $API session.prompt --param sessionID="$MSID" -d '{"text":"Reply with exactly: e2e-model-ok"}' \
    > /evidence/api-model-prompt.json 2>&1 || true
  for i in $(seq 1 180); do
    grep -q '"type":"session.execution.succeeded"' /evidence/sse-raw.txt 2>/dev/null && break
    sleep 1
  done
  cp "$DIAG" /evidence/tgdiag-model.txt
fi

# ---- P2c: optional already-resolved reply capture ---------------------------
# Runs last so its deliberate retry loop cannot pollute the earlier phases.
if [ "${T05_HARNESS_RESOLVED_REPLY:-0}" = "1" ]; then
  # Restore the registry snapshot taken while the permission record was pending
  # and re-inject the reply, mimicking a stale TG button press on a settled
  # request. The plugin's 1s reply scan must attempt client.permission.reply;
  # the outcome (404 terminal classification or raw apply failure) lands in diag.
  cp /evidence/projects-after-permission.json "$PROJECTS"
  if inject_json_field "$PERID" reply '"once"'; then
    echo "P2c: re-injected reply for already-settled $PERID"
  else
    echo "P2c: WARN could not re-inject reply for $PERID"
  fi
  for i in $(seq 1 15); do
    grep -qE 'Permission request no longer exists|Permission reply apply failed' "$DIAG" 2>/dev/null && break
    sleep 1
  done
  sleep 2
  cp "$DIAG" /evidence/tgdiag-resolved-reply.txt
  cp "$PROJECTS" /evidence/projects-after-resolved-reply.json
  # Raw HTTP cross-check of the same settled request (server-side shape).
  set +x
  curl -s -o /evidence/api-resolved-reply-http.json -w '%{http_code}' \
    -u "opencode:$PW" -H 'content-type: application/json' \
    -X POST "http://127.0.0.1:$PORT/api/session/$SID/permission/$PERID/reply" \
    -d '{"decision":"once"}' > /evidence/api-resolved-reply-http.status 2>&1 || true
  set -x
  echo "P2c: raw HTTP status $(cat /evidence/api-resolved-reply-http.status 2>/dev/null)"
fi

# ---- wrap up ----------------------------------------------------------------
echo "--- plugin loader lines ---"
grep -E 'loading plugin|failed to load plugin|configured plugin' "$SERVER_LOG" || true
cp "$SERVER_LOG" /evidence/server-log.txt 2>/dev/null || true
cp "$PROJECTS" /evidence/projects-final.json
kill -TERM $SSEPID 2>/dev/null || true
kill -TERM -$SPID 2>/dev/null || true
sleep 1
echo "--- evidence ---"
wc -l "$DIAG" /evidence/sse-raw.txt 2>/dev/null || true
