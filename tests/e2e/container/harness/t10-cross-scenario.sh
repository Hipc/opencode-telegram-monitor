#!/bin/sh
# Container e2e scenario t10-cross — runs INSIDE hipc/opencode2:latest.
#
# Field incident (t10): the question/form reply write-back (TG -> opencode) did
# not reach the owning session. Real setup:
#   - the owning server is the `opencode serve --service` daemon: its argv has
#     no --port and its env has no OPENCODE_SERVER_PASSWORD, so the old
#     argv+env-only discovery failed;
#   - a second, unregistered server sharing the same registry roots hosts no
#     TUI sessions, but resolved its own endpoint and POSTed the form reply to
#     itself -> 404 -> wrongly deleted the shared record (cross-process
#     terminal-kill).
#
# This scenario reproduces that topology with two real servers sharing one
# ~/.otg registry and asserts both fixes:
#   fix 1 (endpoint discovery): server A (service daemon, no --port in argv,
#         no password env) must discover itself through the state service.json
#         written by v2 (`$XDG_STATE_HOME/opencode/service.json`, pid match)
#         and apply the form reply (204 -> form.replied on A's event stream);
#   fix 2 (ownership gate): server B (argv --port + env password, same project
#         root, separate session storage -> it does NOT host the session) must
#         skip the record via `client.session.get` without applying, without a
#         terminal 404 removal and without deleting the record.
#
# A is SIGSTOPped around the injection so B's skip is observed deterministically
# before the owner resumes and applies.
#
# Evidence (mounted /evidence): phase-ids.json, projects-after-*.json,
# tgdiag-after-*.txt, a-sse.txt, b-sse.txt, a-cmdline.txt, b-cmdline.txt,
# a-env-check.txt, b-endpoint.txt, serve-a.log, serve-b.log.
#
# Environment: T10_PLUGIN (required), T10_B_PORT (optional), T10_ROOT (default
# /tmp/proj), T10_B_HOME (default /tmp/home-b).
set -eu

export HOME=/tmp/home
export XDG_STATE_HOME=/tmp/state
ROOT="${T10_ROOT:-/tmp/proj}"
B_HOME="${T10_B_HOME:-/tmp/home-b}"
mkdir -p "$HOME/.config/opencode/plugin" "$HOME/.otg" "$ROOT" "$B_HOME"

PLUGIN_SRC="${T10_PLUGIN:?T10_PLUGIN required}"
cp "$PLUGIN_SRC" "$HOME/.config/opencode/plugin/telegram-session-monitor.ts"
cp /harness/configs/telegram.synthetic.json "$HOME/.otg/telegram.json"
printf '{"projects":[]}\n' > "$HOME/.otg/projects.json"

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

# --- server A: service daemon (argv has no --port) ---------------------------
echo "t10-cross: starting server A (opencode serve --service)"
cd "$ROOT"
setsid opencode serve --service --print-logs > /tmp/serve-a.log 2>&1 &
APID=$!
echo "t10-cross: A pid=$APID"
for _ in $(seq 1 80); do [ -f /tmp/state/opencode/service.json ] && break; sleep 0.5; done
[ -f /tmp/state/opencode/service.json ] || { echo "FATAL: state service.json not written"; exit 1; }
AURL="$(sed -n 's/.*"url":"\([^"]*\)".*/\1/p' /tmp/state/opencode/service.json)"
APW="$(sed -n 's/.*"password":"\([^"]*\)".*/\1/p' /tmp/state/opencode/service.json)"
[ -n "$AURL" ] && [ -n "$APW" ] || { echo "FATAL: service.json url/password missing"; exit 1; }
echo "t10-cross: A endpoint discovered from service.json (url host/port not printed, password never printed)"

# API helper: password passed inline only (never exported into A's environment,
# never printed by the transcript).
api_a() {
  OPENCODE_SERVER_PASSWORD="$APW" OPENCODE_PASSWORD="$APW" opencode api --server "$AURL" "$@"
}

for _ in $(seq 1 80); do api_a plugin.list > /dev/null 2>&1 && break; sleep 0.5; done
# Plugin activation root (the daemon's own project directory).
A_ROOT=""
for _ in $(seq 1 80); do
  A_ROOT="$(grep -F "setup() pid=$APID root=" "$DIAG" 2>/dev/null | sed -n 's/.*root=\(.*\)$/\1/p' | head -1)"
  [ -n "$A_ROOT" ] && break
  sleep 0.5
done
[ -n "$A_ROOT" ] || { echo "FATAL: plugin setup line for A never appeared"; exit 1; }
echo "t10-cross: A plugin active root=$A_ROOT"
cd "$A_ROOT"

# A's event stream (needed for the form.replied assertion). Password inline.
curl -s -N -u "opencode:$APW" "$AURL/api/event" > /evidence/a-sse.txt &
ASSEPID=$!

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

# --- P1: session + form on A (the owning server) -----------------------------
for _ in $(seq 1 30); do
  SESSION_OUT="$(api_a session.create -d '{"title":"t10-cross"}' 2>/dev/null)" && [ -n "$SESSION_OUT" ] && break
  sleep 1
done
SID="$(printf '%s' "$SESSION_OUT" | sed -n 's/.*"id":"\(ses_[^"]*\)".*/\1/p' | head -1)"
[ -n "$SID" ] || { echo "FATAL: session.create failed"; exit 1; }
echo "t10-cross: session $SID created on A"

FORM_OUT="$(api_a session.form.create --param sessionID="$SID" \
  -d '{"title":"t10-cross question","fields":[{"key":"choice","type":"string","title":"Pick","options":[{"value":"a","label":"A"},{"value":"b","label":"B"}],"custom":true}]}')"
FRM="$(printf '%s' "$FORM_OUT" | sed -n 's/.*"id":"\(frm_[^"]*\)".*/\1/p' | head -1)"
[ -n "$FRM" ] || { echo "FATAL: session.form.create failed"; exit 1; }
echo "t10-cross: form $FRM created on A"
wait_for_record "$FRM" 40 || { echo "FATAL: form record never persisted for $FRM"; exit 1; }
cp "$PROJECTS" /evidence/projects-before-inject.json

# --- server B: plain serve, argv --port + env password, same root, no storage -
B_PORT="${T10_B_PORT:-$(free_port)}"
[ -n "$B_PORT" ] || { echo "FATAL: no free port for B"; exit 1; }
B_PW="$(head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')"
ln -sfn "$HOME/.otg" "$B_HOME/.otg"
ln -sfn "$HOME/.config" "$B_HOME/.config"
mkdir -p "$B_HOME/.local/share"
echo "t10-cross: starting server B (plain serve --port <dynamic>, separate HOME storage, shared otg/config)"
cd "$A_ROOT"
OPENCODE_SERVER_PASSWORD="$B_PW" OPENCODE_PASSWORD="$B_PW" HOME="$B_HOME" \
  setsid opencode serve --port "$B_PORT" --print-logs > /tmp/serve-b.log 2>&1 &
BPID=$!
echo "t10-cross: B pid=$BPID"
BAPI="http://127.0.0.1:$B_PORT"
for _ in $(seq 1 80); do
  OPENCODE_SERVER_PASSWORD="$B_PW" OPENCODE_PASSWORD="$B_PW" HOME="$B_HOME" \
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
echo "t10-cross: B plugin active root=$B_ROOT"
if [ "$B_ROOT" != "$A_ROOT" ]; then
  echo "FATAL: A root ($A_ROOT) != B root ($B_ROOT); the gate would not be exercised"
  exit 1
fi
curl -s -N -u "opencode:$B_PW" "$BAPI/api/event" > /evidence/b-sse.txt &
BSSEPID=$!
sleep 3

# --- P2: freeze A, inject q_answers, require B to skip -----------------------
echo "t10-cross: SIGSTOP A (owner frozen) and inject q_answers"
kill -STOP "$APID"
inject_json_field "$FRM" q_answers '[["A"]]' || { echo "FATAL: q_answers injection failed"; exit 1; }

B_SKIPPED=0
for _ in $(seq 1 20); do
  if grep -qF "apply skipped: session not hosted by this instance request=$FRM" "$DIAG" 2>/dev/null; then
    B_SKIPPED=1
    break
  fi
  sleep 0.5
done
echo "t10-cross: B skip observed=$B_SKIPPED"
sleep 3
cp "$PROJECTS" /evidence/projects-after-b-skip.json
cp "$DIAG" /evidence/tgdiag-after-b-skip.txt

# --- P3: resume A, owner must apply exactly once and remove the record -------
echo "t10-cross: SIGCONT A (owner resumes)"
kill -CONT "$APID"
wait_for_record_gone "$FRM" 30 || echo "t10-cross: WARN form record still present after owner resume"
for _ in $(seq 1 20); do
  grep -q "\"type\":\"form.replied\"" /evidence/a-sse.txt 2>/dev/null && break
  sleep 0.5
done
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
printf '{"aPid":%s,"bPid":%s,"sessionID":"%s","formID":"%s","aRoot":"%s","bRoot":"%s"}\n' \
  "$APID" "$BPID" "$SID" "$FRM" "$A_ROOT" "$B_ROOT" > /evidence/phase-ids.json
cp /tmp/serve-a.log /evidence/serve-a.log 2>/dev/null || true
cp /tmp/serve-b.log /evidence/serve-b.log 2>/dev/null || true
kill -TERM "$ASSEPID" 2>/dev/null || true
kill -TERM "$BSSEPID" 2>/dev/null || true
kill -TERM -"$APID" 2>/dev/null || kill -TERM "$APID" 2>/dev/null || true
kill -TERM -"$BPID" 2>/dev/null || kill -TERM "$BPID" 2>/dev/null || true
sleep 1
echo "t10-cross: done (record_gone=$([ -z "$(grep "\"request_id\": \"$FRM\"" "$PROJECTS" 2>/dev/null)" ] && echo yes || echo no) b_skipped=$B_SKIPPED)"
