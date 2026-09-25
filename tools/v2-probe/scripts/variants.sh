set -x
# Three isolated arms (one plugin dir layout each), all via <configDir>/plugin/ discovery.
# Each arm boots a serve instance with one API request (required to activate plugins),
# captures its own JSONL evidence file and the loader lines from the server log.
run_arm() {
  arm=$1
  port=$2
  export HOME="/tmp/home-$arm"
  rm -rf "$HOME"
  mkdir -p "$HOME/.config/opencode/plugin"
  cp -r /probe/probe-lib "$HOME/.config/opencode/probe-lib"
  case "$arm" in
    setup)
      cp /probe/probe-plugin.ts "$HOME/.config/opencode/probe-plugin.ts"
      cp /probe/autodiscover/probe-autodiscover.ts "$HOME/.config/opencode/plugin/probe-autodiscover.ts"
      ;;
    effect)
      cp /probe/variants/probe-effect.ts "$HOME/.config/opencode/plugin/probe-effect.ts"
      ;;
    extless)
      cp /probe/variants/extless-helper.ts "$HOME/.config/opencode/extless-helper.ts"
      cp /probe/variants/probe-extless.ts "$HOME/.config/opencode/plugin/probe-extless.ts"
      ;;
    helper-in-plugin)
      # negative control: a helper .ts placed inside plugin/ is discovered and
      # loaded as a plugin, then rejected for missing a default export
      cp /probe/variants/extless-helper.ts "$HOME/.config/opencode/plugin/extless-helper.ts"
      ;;
  esac
  export PROBE_LOG_FILE="/evidence/arm-$arm.jsonl"
  rm -f "$PROBE_LOG_FILE"
  cd /tmp
  OPENCODE_SERVER_PASSWORD="$PROBE_PASSWORD" setsid opencode serve --port "$port" --print-logs > "/tmp/serve-$arm.log" 2>&1 &
  SPID=$!
  export OPENCODE_PASSWORD="$PROBE_PASSWORD"
  for i in $(seq 1 40); do
    opencode api --server "http://127.0.0.1:$port" plugin.list > /dev/null 2>&1 && break
    sleep 0.5
  done
  opencode api --server "http://127.0.0.1:$port" plugin.list
  sleep 6
  kill -TERM -$SPID
  sleep 1
  echo "=== $arm loader lines ==="
  grep -E 'loading plugin|failed to load plugin|configured plugin' "$HOME/.local/share/opencode/log/opencode.log"
  cp "$HOME/.local/share/opencode/log/opencode.log" "/evidence/arm-$arm-server.txt"
}
run_arm setup "$((PROBE_SERVE_PORT + 0))"
run_arm effect "$((PROBE_SERVE_PORT + 1))"
run_arm extless "$((PROBE_SERVE_PORT + 2))"
run_arm helper-in-plugin "$((PROBE_SERVE_PORT + 3))"
echo "--- evidence line counts ---"
wc -l /evidence/arm-*.jsonl
