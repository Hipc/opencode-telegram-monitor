set -x
export HOME=/tmp/home
mkdir -p "$HOME/.config/opencode/plugin"
cd /tmp
# Positive control: config array entry pointing at an absolute DIRECTORY that
# contains package.json + index.ts. Expected: plugin loads, probe.setup recorded.
timeout 180 opencode run --standalone --print-logs --format json "Reply with exactly: package-dir-control"
echo "run_exit=$?"
echo "--- evidence line count ---"
wc -l /evidence/events.jsonl
echo "--- loader lines (server log) ---"
grep -E 'loading plugin|failed to load plugin|configured plugin' "$HOME/.local/share/opencode/log/opencode.log"
cp "$HOME/.local/share/opencode/log/opencode.log" /evidence/server-log.txt
