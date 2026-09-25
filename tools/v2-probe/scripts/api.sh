set -x
export HOME=/tmp/home
mkdir -p "$HOME/.config/opencode/plugin"
cd /tmp
cp /probe/probe-plugin.ts "$HOME/.config/opencode/probe-plugin.ts"
cp -r /probe/probe-lib "$HOME/.config/opencode/probe-lib"
cp /probe/autodiscover/probe-autodiscover.ts "$HOME/.config/opencode/plugin/probe-autodiscover.ts"
PORT="${PROBE_SERVE_PORT:-18131}"
OPENCODE_SERVER_PASSWORD="$PROBE_PASSWORD" setsid opencode serve --port "$PORT" --print-logs > /tmp/serve.log 2>&1 &
SPID=$!
export OPENCODE_PASSWORD="$PROBE_PASSWORD"
API="opencode api --server http://127.0.0.1:$PORT"
for i in $(seq 1 40); do
  $API plugin.list > /dev/null 2>&1 && break
  sleep 0.5
done
cat /tmp/serve.log
# raw HTTP SSE stream, to compare the plugin event stream against /api/event
curl -s -N -u "opencode:$PROBE_PASSWORD" "http://127.0.0.1:$PORT/api/event" > /evidence/sse-raw.txt &
SSEPID=$!
$API plugin.list 2>&1
SID=$($API session.create -d '{"title":"probe-api","permissions":[{"action":"shell","resource":"*","effect":"ask"}]}' | grep -o '"id":"ses_[^"]*"' | head -1 | cut -d'"' -f4)
echo "SID=$SID"
$API session.get --param sessionID=$SID
POUT=$($API session.permission.create --param sessionID=$SID -d '{"action":"shell","resources":["echo probe"]}')
echo "permission.create -> $POUT"
sleep 3
$API session.permission.list --param sessionID=$SID
FOUT=$($API session.form.create --param sessionID=$SID -d '{"title":"probe form","fields":[{"key":"choice","type":"string","title":"Pick one","options":[{"value":"a","label":"A"},{"value":"b","label":"B"}],"custom":true},{"key":"notes","type":"string","title":"Notes"}]}')
echo "form.create -> $FOUT"
FID=$(echo "$FOUT" | grep -o '"id":"frm_[^"]*"' | head -1 | cut -d'"' -f4)
sleep 2
$API session.form.reply --param sessionID=$SID --param formID=$FID -d '{"answer":{"choice":"a","notes":"hello"}}'
sleep 2
# second form, cancelled instead of replied
FOUT2=$($API session.form.create --param sessionID=$SID -d '{"title":"probe form cancel","fields":[{"key":"why","type":"string","title":"Why"}]}')
FID2=$(echo "$FOUT2" | grep -o '"id":"frm_[^"]*"' | head -1 | cut -d'"' -f4)
$API session.form.cancel --param sessionID=$SID --param formID=$FID2
# model turn: busy session, then queue two items (cancel one, re-deliver the other)
timeout 60 $API session.prompt --param sessionID=$SID -d '{"text":"Count slowly from 1 to 60, one number per line.","delivery":"steer"}'
Q1=$($API session.prompt --param sessionID=$SID -d '{"text":"queued item one","delivery":"queue"}' | grep -o '"id":"msg_[^"]*"' | head -1 | cut -d'"' -f4)
Q2=$($API session.prompt --param sessionID=$SID -d '{"text":"queued item two","delivery":"queue"}' | grep -o '"id":"msg_[^"]*"' | head -1 | cut -d'"' -f4)
echo "Q1=$Q1 Q2=$Q2"
$API session.inbox.list --param sessionID=$SID
$API session.inbox.cancel --param sessionID=$SID --param inboxID=$Q1
$API session.inbox.update --param sessionID=$SID --param inboxID=$Q2 -d '{"delivery":"steer"}'
sleep 20
# failing model: bogus model on a fresh session
BID=$($API session.create -d '{"title":"probe-bad-model","model":{"providerID":"opencode","modelID":"definitely-not-a-model"}}' | grep -o '"id":"ses_[^"]*"' | head -1 | cut -d'"' -f4)
echo "BID=$BID"
$API session.prompt --param sessionID=$BID -d '{"text":"hello"}'
sleep 10
echo "--- reload: observe plugin dispose/re-setup ---"
timeout 30 opencode reload --server http://127.0.0.1:$PORT
sleep 5
$API session.remove --param sessionID=$SID
$API session.remove --param sessionID=$BID
sleep 2
echo "--- loader lines (server log) ---"
grep -E 'loading plugin|failed to load plugin|configured plugin' "$HOME/.local/share/opencode/log/opencode.log"
cp "$HOME/.local/share/opencode/log/opencode.log" /evidence/server-log.txt
kill -TERM -$SPID
kill -TERM $SSEPID
sleep 1
echo "--- evidence line count ---"
wc -l /evidence/events.jsonl
