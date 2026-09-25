set -x
export HOME=/tmp/home
mkdir -p "$HOME/.config/opencode/plugin"
cd /tmp
cp /probe/probe-plugin.ts "$HOME/.config/opencode/probe-plugin.ts"
cp -r /probe/probe-lib "$HOME/.config/opencode/probe-lib"
cp /probe/autodiscover/probe-autodiscover.ts "$HOME/.config/opencode/plugin/probe-autodiscover.ts"
timeout 180 opencode run --standalone --auto --print-logs --format json "Use the shell tool to run exactly this command: echo auto-approve-ok. Then report the output."
echo "run_exit=$?"
echo "--- evidence line count ---"
wc -l /evidence/events.jsonl
echo "--- loader lines (server log) ---"
grep -E 'loading plugin|failed to load plugin|configured plugin' "$HOME/.local/share/opencode/log/opencode.log"
cp "$HOME/.local/share/opencode/log/opencode.log" /evidence/server-log.txt
