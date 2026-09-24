set -x
export HOME=/tmp/home
mkdir -p "$HOME/.config/opencode/plugin"
cd /tmp
cp /probe/probe-plugin.ts "$HOME/.config/opencode/probe-plugin.ts"
cp -r /probe/probe-lib "$HOME/.config/opencode/probe-lib"
cp /probe/autodiscover/probe-autodiscover.ts "$HOME/.config/opencode/plugin/probe-autodiscover.ts"
# trigger a provider/model failure to capture session.execution.failed / session.step.failed
timeout 120 opencode run --standalone --print-logs --format json --model opencode/definitely-not-a-model "hello"
echo "run_exit=$?"
echo "--- evidence line count ---"
wc -l /evidence/events.jsonl
echo "--- loader lines (server log) ---"
grep -E 'loading plugin|failed to load plugin|configured plugin' "$HOME/.local/share/opencode/log/opencode.log"
cp "$HOME/.local/share/opencode/log/opencode.log" /evidence/server-log.txt
