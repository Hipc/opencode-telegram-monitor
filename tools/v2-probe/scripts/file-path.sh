set -x
export HOME=/tmp/home
mkdir -p "$HOME/.config/opencode/plugin"
cd /tmp
# Negative control: config array entry pointing directly at an absolute .ts FILE.
# Expected: opencode logs 'configured plugin path must be a directory' and the
# plugin does NOT load (no probe.setup record, no events.jsonl).
timeout 180 opencode run --standalone --print-logs --format json "Reply with exactly: file-path-control"
echo "run_exit=$?"
echo "--- evidence file present? ---"
ls -la /evidence/events.jsonl 2>&1
echo "--- loader lines (server log) ---"
grep -E 'loading plugin|failed to load plugin|configured plugin' "$HOME/.local/share/opencode/log/opencode.log"
cp "$HOME/.local/share/opencode/log/opencode.log" /evidence/server-log.txt
