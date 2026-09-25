#!/bin/sh
# Container e2e scenario t13-shared-cross — runs INSIDE hipc/opencode2:latest.
#
# Field incident (t13): TWO opencode servers sharing ONE HOME/XDG storage
# (shared ~/.otg registry AND shared ~/.local/share/opencode):
#   - A = `opencode serve --service` hosts the user's sessions (pid 12851 in
#     the field log);
#   - B = plain `opencode serve --hostname 127.0.0.1 --port <n>` (pid 14431)
#     shares the storage, activates the same root and runs its own reply scan.
# The t10 ownership gate used `client.session.get`, which succeeds on B too in
# this topology (shared DB — probe t13-probe P4: identical payloads), so B
# applied the TG-written terminal fields to its own endpoint, got HTTP 404,
# classified it as terminal and DELETED the shared record; the real host never
# applied (field log: "[info] Form cancel is terminal (HTTP 404); removing
# session record" from pid 14431, no form.cancelled anywhere).
#
# This scenario creates a pending permission + two forms (string + multiselect)
# on A, SIGSTOPs A, injects the TG-side terminal fields (reply:"once" /
# q_answers / q_reject) into the shared registry, and observes B's scan:
#   - positive (fixed plugin): B logs `apply skipped: waiting record owned by
#     another instance` for every request and deletes nothing; after A resumes,
#     A applies exactly once (form.replied / form.cancelled / permission.replied
#     on A's event stream) and the records are removed;
#   - negative control (pre-fix bundle, --plugin): B classifies its self-POST
#     404 as terminal and deletes all three records while A is frozen; A never
#     emits the settle events (the exact field signature).
#
# Evidence (mounted /evidence): phase-ids.json, projects-before-inject.json,
# projects-after-b-window.json, projects-final.json, tgdiag-after-b-window.txt,
# tgdiag-final.txt, a-sse.txt, b-sse.txt, a-cmdline.txt, b-cmdline.txt,
# a-env-check.txt, b-endpoint.txt, serve-a.log, serve-b.log.
#
# Environment: T13_PLUGIN (required), T13_ROOT (default /tmp/home — the service
# daemon's location, see t13-probe/serve-a.log "location services booted
# directory=/tmp/home").
set -eu

export HOME=/tmp/home
export XDG_STATE_HOME=/tmp/state
ROOT="${T13_ROOT:-/tmp/home}"
mkdir -p "$HOME/.config/opencode/plugin" "$HOME/.otg" "$ROOT" /tmp/state

PLUGIN_SRC="${T13_PLUGIN:?T13_PLUGIN required}"
cp "$PLUGIN_SRC" "$HOME/.config/opencode/plugin/telegram-session-monitor.ts"
cp /harness/configs/telegram.synthetic.json "$HOME/.otg/telegram.json"
printf '{"projects":[{"path":"%s","enabled":true,"addedAt":"2026-01-01T00:00:00.000Z"}]}\n' "$ROOT" > "$HOME/.otg/projects.json"

PROJECTS="$HOME/.otg/projects.json"
DIAG="$HOME/.otg/tgdiag.log"

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

# --- server A: service daemon (field host shape) -----------------------------
echo "t13-shared-cross: starting server A (opencode serve --service, shared HOME/XDG)"
cd "$ROOT"
setsid opencode serve --service --print-logs > /tmp/serve-a.log 2>&1 &
APID=$!
echo "t13-shared-cross: A pid=$APID"
for _ in $(seq 1 80); do [ -f /tmp/state/opencode/service.json ] && break; sleep 0.5; done
[ -f /tmp/state/opencode/service.json ] || { echo "FATAL: state service.json not written"; exit 1; }
AURL="$(sed -n 's/.*"url":"\([^"]*\)".*/\1/p' /tmp/state/opencode/service.json)"
APW="$(sed -n 's/.*"password":"\([^"]*\)".*/\1/p' /tmp/state/opencode/service.json)"
[ -n "$AURL" ] && [ -n "$APW" ] || { echo "FATAL: service.json url/password missing"; exit 1; }
echo "t13-shared-cross: A endpoint discovered from service.json (password never printed)"

api_a() {
  OPENCODE_SERVER_PASSWORD="$APW" OPENCODE_PASSWORD="$APW" opencode api --server "$AURL" "$@"
}

for _ in $(seq 1 80); do api_a plugin.list > /dev/null 2>&1 && break; sleep 0.5; done
A_ROOT=""
for _ in $(seq 1 80); do
  A_ROOT="$(grep -F "setup() pid=$APID root=" "$DIAG" 2>/dev/null | sed -n 's/.*root=\(.*\)$/\1/p' | head -1)"
  [ -n "$A_ROOT" ] && break
  sleep 0.5
done
[ -n "$A_ROOT" ] || { echo "FATAL: plugin setup line for A never appeared"; exit 1; }
echo "t13-shared-cross: A plugin active root=$A_ROOT"

# A's event stream (form.replied / form.cancelled / permission.replied proof).
set +x
curl -s -N -u "opencode:$APW" "$AURL/api/event" > /evidence/a-sse.txt &
ASSEPID=$!
set -x

wait_for_record() { # <request_id> <seconds>
  local rid="$1" limit="$2"
  for _ in $(seq 1 "$limit"); do
    grep -q "\"request_id\": \"$rid\"" "$PROJECTS" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}
wait_for_record_gone() {
  local rid="$1" limit="$2"
  for _ in $(seq 1 "$limit"); do
    grep -q "\"request_id\": \"$rid\"" "$PROJECTS" 2>/dev/null || return 0
    sleep 1
  done
  return 1
}
inject_json_field() { # <request_id> <field> <json-value>
  local rid="$1" field="$2" value="$3"
  for _ in $(seq 1 10); do
    if grep -q "\"request_id\": \"$rid\"" "$PROJECTS" 2>/dev/null; then
      sed -i "s|^\([[:space:]]*\)\"request_id\": \"$rid\",\$|\1\"request_id\": \"$rid\",\n\1\"$field\": $value,|" "$PROJECTS"
      grep -qF "\"$field\": $value" "$PROJECTS" && return 0
    fi
    sleep 1
  done
  return 1
}

# --- fixtures on A: session + pending permission + two pending forms ---------
SESSION_OUT="$(api_a session.create -d '{"title":"t13-shared-cross","permissions":[{"action":"shell","resource":"*","effect":"ask"}]}')"
SID="$(printf '%s' "$SESSION_OUT" | sed -n 's/.*"id":"\(ses_[^"]*\)".*/\1/p' | head -1)"
[ -n "$SID" ] || { echo "FATAL: session.create failed"; exit 1; }
echo "t13-shared-cross: session $SID created on A"

PERM_OUT="$(api_a session.permission.create --param sessionID="$SID" -d '{"action":"shell","resources":["echo t13"]}')"
PERID="$(printf '%s' "$PERM_OUT" | sed -n 's/.*"id":"\(per_[^"]*\)".*/\1/p' | head -1)"
[ -n "$PERID" ] || { echo "FATAL: session.permission.create failed"; exit 1; }
echo "t13-shared-cross: permission $PERID created on A"

FORM1_OUT="$(api_a session.form.create --param sessionID="$SID" \
  -d '{"title":"t13 string form","fields":[{"key":"choice","type":"string","title":"Pick","options":[{"value":"a","label":"A"},{"value":"b","label":"B"}],"custom":true}]}')"
F1="$(printf '%s' "$FORM1_OUT" | sed -n 's/.*"id":"\(frm_[^"]*\)".*/\1/p' | head -1)"
[ -n "$F1" ] || { echo "FATAL: form create (string) failed"; exit 1; }
echo "t13-shared-cross: form1 $F1 created on A"

FORM2_OUT="$(api_a session.form.create --param sessionID="$SID" \
  -d '{"title":"t13 multiselect form","fields":[{"key":"tags","type":"multiselect","title":"Tags","options":[{"value":"x","label":"X"},{"value":"y","label":"Y"}],"custom":false}]}')"
F2="$(printf '%s' "$FORM2_OUT" | sed -n 's/.*"id":"\(frm_[^"]*\)".*/\1/p' | head -1)"
[ -n "$F2" ] || { echo "FATAL: form create (multiselect) failed"; exit 1; }
echo "t13-shared-cross: form2 $F2 created on A"

wait_for_record "$PERID" 40 || { echo "FATAL: permission record never persisted"; exit 1; }
wait_for_record "$F1" 40 || { echo "FATAL: form1 record never persisted"; exit 1; }
wait_for_record "$F2" 40 || { echo "FATAL: form2 record never persisted"; exit 1; }
cp "$PROJECTS" /evidence/projects-before-inject.json

# --- server B: plain serve, SAME HOME/XDG, same root -------------------------
B_PORT="${T13_B_PORT:-$(free_port)}"
[ -n "$B_PORT" ] || { echo "FATAL: no free port for B"; exit 1; }
B_PW="$(head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')"
echo "t13-shared-cross: starting server B (plain serve --port <dynamic>, shared HOME/XDG)"
cd "$ROOT"
OPENCODE_SERVER_PASSWORD="$B_PW" OPENCODE_PASSWORD="$B_PW" \
  setsid opencode serve --hostname 127.0.0.1 --port "$B_PORT" --print-logs > /tmp/serve-b.log 2>&1 &
BPID=$!
echo "t13-shared-cross: B pid=$BPID"
BAPI="http://127.0.0.1:$B_PORT"
for _ in $(seq 1 80); do
  OPENCODE_SERVER_PASSWORD="$B_PW" OPENCODE_PASSWORD="$B_PW" \
    opencode api --server "$BAPI" plugin.list > /dev/null 2>&1 && break
  sleep 0.5
done
B_ROOT=""
for _ in $(seq 1 80); do
  B_ROOT="$(grep -F "setup() pid=$BPID root=" "$DIAG" 2>/dev/null | sed -n 's/.*root=\(.*\)$/\1/p' | head -1)"
  [ -n "$B_ROOT" ] && break
  sleep 0.5
done
[ -n "$B_ROOT" ] || { echo "FATAL: plugin setup line for B never appeared"; exit 1; }
echo "t13-shared-cross: B plugin active root=$B_ROOT"
if [ "$B_ROOT" != "$A_ROOT" ]; then
  echo "FATAL: A root ($A_ROOT) != B root ($B_ROOT); the shared-registry scan would not be exercised"
  exit 1
fi
set +x
curl -s -N -u "opencode:$B_PW" "$BAPI/api/event" > /evidence/b-sse.txt &
BSSEPID=$!
set -x
sleep 3

# --- freeze A, inject the TG terminal fields ---------------------------------
echo "t13-shared-cross: SIGSTOP A (owner frozen); inject reply/q_answers/q_reject"
kill -STOP "$APID"
inject_json_field "$PERID" reply '"once"' || { echo "FATAL: reply injection failed"; exit 1; }
inject_json_field "$F1" q_answers '[["A"]]' || { echo "FATAL: q_answers injection failed"; exit 1; }
inject_json_field "$F2" q_reject 'true' || { echo "FATAL: q_reject injection failed"; exit 1; }

# B window: either B skips every record (fixed) or B deletes them (pre-fix).
B_SKIPPED=0
B_DELETED=0
for _ in $(seq 1 30); do
  skips="$(grep -cF "apply skipped: waiting record owned by another instance" "$DIAG" 2>/dev/null || true)"
  gone=0
  for rid in "$PERID" "$F1" "$F2"; do
    grep -q "\"request_id\": \"$rid\"" "$PROJECTS" 2>/dev/null || gone=$((gone + 1))
  done
  if [ "$skips" -ge 3 ]; then B_SKIPPED=1; break; fi
  if [ "$gone" -ge 3 ]; then B_DELETED=1; break; fi
  sleep 1
done
echo "t13-shared-cross: B window skips=$B_SKIPPED deleted_all=$B_DELETED"
sleep 5
cp "$PROJECTS" /evidence/projects-after-b-window.json
cp "$DIAG" /evidence/tgdiag-after-b-window.txt

# --- resume A; owner applies exactly once and removes the records ------------
echo "t13-shared-cross: SIGCONT A (owner resumes)"
kill -CONT "$APID"
for rid in "$PERID" "$F1" "$F2"; do
  wait_for_record_gone "$rid" 30 || echo "t13-shared-cross: WARN record $rid still present after owner resume"
done
for _ in $(seq 1 30); do
  if grep -q '"type":"form.replied"' /evidence/a-sse.txt 2>/dev/null && \
     grep -q '"type":"form.cancelled"' /evidence/a-sse.txt 2>/dev/null && \
     grep -q '"type":"permission.replied"' /evidence/a-sse.txt 2>/dev/null; then
    break
  fi
  sleep 1
done
sleep 5
cp "$PROJECTS" /evidence/projects-final.json
cp "$DIAG" /evidence/tgdiag-final.txt

# --- wrap up: endpoint evidence, ids, stop everything ------------------------
tr '\0' ' ' < "/proc/$APID/cmdline" > /evidence/a-cmdline.txt
tr '\0' ' ' < "/proc/$BPID/cmdline" > /evidence/b-cmdline.txt
{
  if tr '\0' '\n' < "/proc/$APID/environ" | grep -q '^OPENCODE_SERVER_PASSWORD='; then
    echo "server_password_env=present"
  else
    echo "server_password_env=absent"
  fi
} > /evidence/a-env-check.txt
{
  if grep -q -- '--port' /evidence/b-cmdline.txt; then echo "b_port_in_argv=yes"; else echo "b_port_in_argv=no"; fi
  if tr '\0' '\n' < "/proc/$BPID/environ" | grep -q '^OPENCODE_SERVER_PASSWORD='; then
    echo "b_server_password_env=present"
  else
    echo "b_server_password_env=absent"
  fi
} > /evidence/b-endpoint.txt
printf '{"aPid":%s,"bPid":%s,"sessionID":"%s","permissionID":"%s","form1":"%s","form2":"%s","aRoot":"%s","bRoot":"%s","bSkips":%s,"bDeletedAll":%s}\n' \
  "$APID" "$BPID" "$SID" "$PERID" "$F1" "$F2" "$A_ROOT" "$B_ROOT" "$B_SKIPPED" "$B_DELETED" > /evidence/phase-ids.json
cp /tmp/serve-a.log /evidence/serve-a.log 2>/dev/null || true
cp /tmp/serve-b.log /evidence/serve-b.log 2>/dev/null || true
kill -TERM "$ASSEPID" 2>/dev/null || true
kill -TERM "$BSSEPID" 2>/dev/null || true
kill -TERM -"$APID" 2>/dev/null || kill -TERM "$APID" 2>/dev/null || true
kill -TERM -"$BPID" 2>/dev/null || kill -TERM "$BPID" 2>/dev/null || true
sleep 1
echo "t13-shared-cross: done (b_skipped=$B_SKIPPED b_deleted_all=$B_DELETED)"
