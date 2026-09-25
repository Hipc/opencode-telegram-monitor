#!/bin/sh
# Container probe t13-probe — runs INSIDE hipc/opencode2:latest.
#
# Reproduces the FIELD topology of the t13 incident: TWO opencode server
# processes sharing the SAME HOME/XDG storage (the user's log shows pid 12851 =
# `serve --service` hosting the sessions and pid 14431 = plain `serve --port`
# with the same storage). The t10-cross scenario used separate session storage,
# which is why the session.get ownership gate worked there; here the storage is
# shared, so `session.get` succeeds on the non-host and cannot discriminate.
#
# Both servers load the t13 probe plugin (same config dir). The probe records
# every event per pid. The scenario then drives the v2 HTTP API directly to
# answer the probe questions P1-P5:
#   P1  event delivery: does server B's plugin receive the session's events
#       (session.created / form.created / permission.asked) for a session
#       hosted by A?
#   P2  form route semantics from A (owner) vs B (non-owner): session.form.get /
#       .list / .reply / .cancel in pending and settled states.
#   P3  permission route semantics from A vs B: session.permission.get / .list /
#       .reply.
#   P4  session.get payload diff A vs B.
#   P5  multiselect field type round-trip in form.get / form.created.
#
# Evidence (mounted /evidence): t13-probe.jsonl (both pids), p2-*.json/status,
# p3-*.json/status, p4-*.json, p5-*.json, openapi-form-permission-paths.txt,
# serve-a.log, serve-b.log, scenario.txt.
#
# Environment: T13_PLUGIN (required), T13_ROOT (default /tmp/proj).
set -eu

export HOME=/tmp/home
export XDG_STATE_HOME=/tmp/state
ROOT="${T13_ROOT:-/tmp/proj}"
mkdir -p "$HOME/.config/opencode/plugin" "$ROOT" /tmp/state

PLUGIN_SRC="${T13_PLUGIN:?T13_PLUGIN required}"
cp "$PLUGIN_SRC" "$HOME/.config/opencode/plugin/t13-probe.ts"

LOG=/evidence/t13-probe.jsonl
: > "$LOG"
export T13_PROBE_LOG="$LOG"

free_port() {
  local p hex
  for _ in $(seq 1 60); do
    p=$((20000 + RANDOM % 20000))
    hex="$(printf '%04X' "$p")"
    if ! awk '{print $2}' /proc/net/tcp /proc/net/tcp6 2>/dev/null | grep -qi ":$hex\$"; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

# --- server A: service daemon (the field host shape) -------------------------
echo "t13-probe: starting server A (opencode serve --service, shared HOME/XDG)"
cd "$ROOT"
setsid opencode serve --service --print-logs > /tmp/serve-a.log 2>&1 &
APID=$!
echo "t13-probe: A pid=$APID"
for _ in $(seq 1 80); do [ -f /tmp/state/opencode/service.json ] && break; sleep 0.5; done
[ -f /tmp/state/opencode/service.json ] || { echo "FATAL: state service.json not written"; exit 1; }
AURL="$(sed -n 's/.*"url":"\([^"]*\)".*/\1/p' /tmp/state/opencode/service.json)"
APW="$(sed -n 's/.*"password":"\([^"]*\)".*/\1/p' /tmp/state/opencode/service.json)"
[ -n "$AURL" ] && [ -n "$APW" ] || { echo "FATAL: service.json url/password missing"; exit 1; }
echo "t13-probe: A endpoint discovered from service.json (password never printed)"

api_a() {
  OPENCODE_SERVER_PASSWORD="$APW" OPENCODE_PASSWORD="$APW" opencode api --server "$AURL" "$@"
}

for _ in $(seq 1 80); do api_a plugin.list > /dev/null 2>&1 && break; sleep 0.5; done
for _ in $(seq 1 80); do
  grep -q "\"pid\":$APID.*probe.setup" "$LOG" 2>/dev/null && break
  sleep 0.5
done
grep -q "\"pid\":$APID.*probe.setup" "$LOG" || { echo "FATAL: probe setup for A never appeared"; exit 1; }
echo "t13-probe: probe plugin active on A"

# --- server B: plain serve, same HOME/XDG (shared storage) -------------------
B_PORT="$(free_port)"
B_PW="$(head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')"
echo "t13-probe: starting server B (plain serve --port <dynamic>, SAME HOME/XDG)"
OPENCODE_SERVER_PASSWORD="$B_PW" OPENCODE_PASSWORD="$B_PW" \
  setsid opencode serve --hostname 127.0.0.1 --port "$B_PORT" --print-logs > /tmp/serve-b.log 2>&1 &
BPID=$!
echo "t13-probe: B pid=$BPID"
BAPI="http://127.0.0.1:$B_PORT"
for _ in $(seq 1 80); do
  OPENCODE_SERVER_PASSWORD="$B_PW" OPENCODE_PASSWORD="$B_PW" \
    opencode api --server "$BAPI" plugin.list > /dev/null 2>&1 && break
  sleep 0.5
done
for _ in $(seq 1 80); do
  grep -q "\"pid\":$BPID.*probe.setup" "$LOG" 2>/dev/null && break
  sleep 0.5
done
grep -q "\"pid\":$BPID.*probe.setup" "$LOG" || { echo "FATAL: probe setup for B never appeared"; exit 1; }
echo "t13-probe: probe plugin active on B"

# HTTP helper: capture status and body separately (password never echoed).
http() { # <label> <base> <pw> <method> <path> [data]
  local label="$1" base="$2" pw="$3" method="$4" path="$5" data="${6:-}"
  local args=""
  if [ -n "$data" ]; then args="-H content-type:application/json -d $data"; fi
  # shellcheck disable=SC2086
  curl -s -o "/evidence/$label.json" -w '%{http_code}' \
    -u "opencode:$pw" -X "$method" $args "$base$path" > "/evidence/$label.status" 2>&1 || true
  echo "t13-probe: $label status=$(cat "/evidence/$label.status" 2>/dev/null)"
}

sleep 2

# --- fixtures on A -----------------------------------------------------------
SESSION_OUT="$(api_a session.create -d '{"title":"t13-probe","permissions":[{"action":"shell","resource":"*","effect":"ask"}]}')"
SID="$(printf '%s' "$SESSION_OUT" | sed -n 's/.*"id":"\(ses_[^"]*\)".*/\1/p' | head -1)"
[ -n "$SID" ] || { echo "FATAL: session.create failed"; exit 1; }
echo "t13-probe: session $SID created on A"
for _ in $(seq 1 40); do grep -q "\"$SID\"" "$LOG" 2>/dev/null && break; sleep 0.5; done

PERM_OUT="$(api_a session.permission.create --param sessionID="$SID" -d '{"action":"shell","resources":["echo t13"]}')"
PERID="$(printf '%s' "$PERM_OUT" | sed -n 's/.*"id":"\(per_[^"]*\)".*/\1/p' | head -1)"
[ -n "$PERID" ] || { echo "FATAL: session.permission.create failed"; exit 1; }
echo "t13-probe: permission $PERID created on A"

FORM1_OUT="$(api_a session.form.create --param sessionID="$SID" \
  -d '{"title":"t13 string form","fields":[{"key":"choice","type":"string","title":"Pick","options":[{"value":"a","label":"A"},{"value":"b","label":"B"}],"custom":true}]}')"
F1="$(printf '%s' "$FORM1_OUT" | sed -n 's/.*"id":"\(frm_[^"]*\)".*/\1/p' | head -1)"
[ -n "$F1" ] || { echo "FATAL: session.form.create (string) failed"; exit 1; }
echo "t13-probe: form1 $F1 (string+options) created on A"

FORM2_OUT="$(api_a session.form.create --param sessionID="$SID" \
  -d '{"title":"t13 multiselect form","fields":[{"key":"tags","type":"multiselect","title":"Tags","options":[{"value":"x","label":"X"},{"value":"y","label":"Y"}],"custom":false}]}')"
F2="$(printf '%s' "$FORM2_OUT" | sed -n 's/.*"id":"\(frm_[^"]*\)".*/\1/p' | head -1)"
[ -n "$F2" ] || { echo "FATAL: session.form.create (multiselect) failed"; exit 1; }
echo "t13-probe: form2 $F2 (multiselect) created on A"

for _ in $(seq 1 60); do
  grep -q "$PERID" "$LOG" 2>/dev/null && grep -q "$F1" "$LOG" 2>/dev/null && grep -q "$F2" "$LOG" 2>/dev/null && break
  sleep 0.5
done
sleep 3
cp "$LOG" /evidence/t13-probe-after-fixtures.jsonl

# --- P1 summary: which pid saw which fixture ---------------------------------
{
  echo "aPid=$APID bPid=$BPID"
  echo "sessionID=$SID permissionID=$PERID form1=$F1 form2=$F2"
  echo "--- A lines mentioning session/form/permission ids ---"
  grep -E "$SID|$PERID|$F1|$F2" "$LOG" | grep "\"pid\":$APID" | sed 's/,"payload".*//' || true
  echo "--- B lines mentioning session/form/permission ids ---"
  grep -E "$SID|$PERID|$F1|$F2" "$LOG" | grep "\"pid\":$BPID" | sed 's/,"payload".*//' || true
  echo "--- distinct event types per pid ---"
  for pid in "$APID" "$BPID"; do
    echo "pid=$pid"
    grep "\"pid\":$pid" "$LOG" | grep '"type":"probe.event' | sed -n 's/.*"type":"probe.event[^"]*","payload":{"type":"\([^"]*\)".*/\1/p' | sort | uniq -c || true
  done
} > /evidence/p1-event-delivery.txt

# --- P2: form route matrix (A = owner, B = non-owner) ------------------------
http p2-get-a-pending "$AURL" "$APW" GET "/api/session/$SID/form/$F1"
http p2-get-b-pending "$BAPI" "$B_PW" GET "/api/session/$SID/form/$F1"
http p2-list-a-pending "$AURL" "$APW" GET "/api/session/$SID/form"
http p2-list-b-pending "$BAPI" "$B_PW" GET "/api/session/$SID/form"
http p2-reply-b-pending "$BAPI" "$B_PW" POST "/api/session/$SID/form/$F1/reply" '{"answer":{"choice":"a"}}'
http p2-get-a-after-breply "$AURL" "$APW" GET "/api/session/$SID/form/$F1"
http p2-reply-a "$AURL" "$APW" POST "/api/session/$SID/form/$F1/reply" '{"answer":{"choice":"a"}}'
http p2-get-a-settled "$AURL" "$APW" GET "/api/session/$SID/form/$F1"
http p2-get-b-settled "$BAPI" "$B_PW" GET "/api/session/$SID/form/$F1"
http p2-reply-a-again "$AURL" "$APW" POST "/api/session/$SID/form/$F1/reply" '{"answer":{"choice":"a"}}'
http p2-reply-b-again "$BAPI" "$B_PW" POST "/api/session/$SID/form/$F1/reply" '{"answer":{"choice":"a"}}'

# --- P5 + cancel matrix on the multiselect form ------------------------------
http p5-get-a-multiselect "$AURL" "$APW" GET "/api/session/$SID/form/$F2"
http p2-get-b-multiselect "$BAPI" "$B_PW" GET "/api/session/$SID/form/$F2"
http p2-cancel-b-pending "$BAPI" "$B_PW" DELETE "/api/session/$SID/form/$F2"
http p2-get-a-after-bcancel "$AURL" "$APW" GET "/api/session/$SID/form/$F2"
http p2-cancel-a "$AURL" "$APW" DELETE "/api/session/$SID/form/$F2"
http p2-cancel-a-again "$AURL" "$APW" DELETE "/api/session/$SID/form/$F2"
http p2-get-b-multiselect-settled "$BAPI" "$B_PW" GET "/api/session/$SID/form/$F2"

# --- P3: permission route matrix ---------------------------------------------
http p3-perm-get-a-pending "$AURL" "$APW" GET "/api/session/$SID/permission/$PERID"
http p3-perm-get-b-pending "$BAPI" "$B_PW" GET "/api/session/$SID/permission/$PERID"
http p3-perm-list-a-pending "$AURL" "$APW" GET "/api/session/$SID/permission"
http p3-perm-list-b-pending "$BAPI" "$B_PW" GET "/api/session/$SID/permission"
http p3-perm-reply-b-pending "$BAPI" "$B_PW" POST "/api/session/$SID/permission/$PERID/reply" '{"decision":"once"}'
http p3-perm-get-a-after-breply "$AURL" "$APW" GET "/api/session/$SID/permission/$PERID"
http p3-perm-reply-a "$AURL" "$APW" POST "/api/session/$SID/permission/$PERID/reply" '{"decision":"once"}'
http p3-perm-reply-b-settled "$BAPI" "$B_PW" POST "/api/session/$SID/permission/$PERID/reply" '{"decision":"once"}'

# --- P4: session.get payload diff --------------------------------------------
api_a session.get --param sessionID="$SID" > /evidence/p4-session-get-a.json 2>&1 || true
OPENCODE_SERVER_PASSWORD="$B_PW" OPENCODE_PASSWORD="$B_PW" \
  opencode api --server "$BAPI" session.get --param sessionID="$SID" > /evidence/p4-session-get-b.json 2>&1 || true
http p4-http-session-a "$AURL" "$APW" GET "/api/session/$SID"
http p4-http-session-b "$BAPI" "$B_PW" GET "/api/session/$SID"
http p4-http-session-list-a "$AURL" "$APW" GET "/api/session"
http p4-http-session-list-b "$BAPI" "$B_PW" GET "/api/session"

# OpenAPI route inventory for form/permission (route names evidence).
curl -s -u "opencode:$APW" "$AURL/openapi.json" > /tmp/openapi.json 2>/dev/null || true
grep -o '"/api/session/{sessionID}/[a-zA-Z/{}\-]*"' /tmp/openapi.json 2>/dev/null | sort -u | grep -E "form|permission" > /evidence/openapi-form-permission-paths.txt || true

# --- wrap up -----------------------------------------------------------------
{
  echo "scenario=t13-probe"
  echo "aPid=$APID bPid=$BPID"
  echo "sessionID=$SID permissionID=$PERID form1=$F1 form2=$F2"
  echo "aRoot=$(grep "\"pid\":$APID" "$LOG" | sed -n 's/.*"location":{"directory":"\([^"]*\)".*/\1/p' | head -1)"
  echo "bRoot=$(grep "\"pid\":$BPID" "$LOG" | sed -n 's/.*"location":{"directory":"\([^"]*\)".*/\1/p' | head -1)"
} > /evidence/scenario.txt

cp /tmp/serve-a.log /evidence/serve-a.log 2>/dev/null || true
cp /tmp/serve-b.log /evidence/serve-b.log 2>/dev/null || true
cp "$LOG" /evidence/t13-probe-final.jsonl
kill -TERM -"$APID" 2>/dev/null || kill -TERM "$APID" 2>/dev/null || true
kill -TERM -"$BPID" 2>/dev/null || kill -TERM "$BPID" 2>/dev/null || true
sleep 1
echo "t13-probe: done"
