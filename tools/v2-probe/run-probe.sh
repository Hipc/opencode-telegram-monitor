#!/usr/bin/env bash
# Reproducible container recipes for the opencode v2 plugin integration probe.
#
# All opencode runs happen inside the `hipc/opencode2:latest` container
# (opencode v2.0.15). The probe plugin is mounted read-only at /probe and writes
# raw JSONL evidence to the per-scenario /evidence mount inside this directory.
#
# Usage:
#   ./run-probe.sh load             # plugin load + client surface + real session events
#   ./run-probe.sh tool-permission  # real shell tool call -> permission.asked -> probe replies
#   ./run-probe.sh auto-approve     # shell tool call with --auto (asked + replied)
#   ./run-probe.sh api              # serve + API triggers (permission/form/storage/session) + reload
#   ./run-probe.sh variants         # effect-form + extensionless-import variants
#   ./run-probe.sh session-error    # failing model turn -> execution/step failure events
#   ./run-probe.sh file-path        # negative control: config entry pointing at an absolute .ts file
#   ./run-probe.sh package-dir      # positive control: config entry pointing at a directory package
#   ./run-probe.sh all              # all of the above
#   ./run-probe.sh chown            # fix root-owned evidence files (uses otg-toolchain image)
#
# Notes:
#  - The serve scenario binds a port INSIDE the container network namespace and
#    publishes nothing to the host. PROBE_SERVE_PORT (default 18131) is checked
#    against host listeners before running anyway.
#  - Containers run with --rm; no ports are published; nothing is installed on the host.
set -euo pipefail

PROBE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${PROBE_IMAGE:-hipc/opencode2:latest}"
TOOLCHAIN_IMAGE="${PROBE_TOOLCHAIN_IMAGE:-otg-toolchain:latest}"
EVIDENCE_DIR="$PROBE_DIR/evidence"
HOST_UID_GID="$(id -u):$(id -g)"
SERVE_PORT="${PROBE_SERVE_PORT:-18131}"
PROBE_PASSWORD="${PROBE_PASSWORD:-probe-pass-123}"

check_port_free() {
  if command -v ss >/dev/null 2>&1; then
    for p in "$SERVE_PORT" "$((SERVE_PORT + 1))" "$((SERVE_PORT + 2))" "$((SERVE_PORT + 3))"; do
      if ss -tln 2>/dev/null | awk '{print $4}' | grep -q ":${p}\$"; then
        echo "ERROR: host port ${p} is in use; set PROBE_SERVE_PORT to a free base port" >&2
        exit 1
      fi
    done
  fi
}

run_container() {
  local name="$1" config="$2"
  shift 2
  local out="$EVIDENCE_DIR/$name"
  mkdir -p "$out"
  : > "$out/commands.txt"
  : > "$out/events.jsonl"
  rm -rf "$out/server-logs"
  {
    echo "=== scenario: $name ==="
    echo "=== exact docker invocation (from worktree root) ==="
    echo "docker run --rm \\"
    echo "  -v $PROBE_DIR:/probe:ro \\"
    echo "  -v $out:/evidence \\"
    echo "  -v $PROBE_DIR/configs/$config:/tmp/home/.config/opencode/opencode.json:ro \\"
    echo "  -e PROBE_LOG_FILE=/evidence/events.jsonl -e PROBE_SERVE_PORT=$SERVE_PORT -e PROBE_PASSWORD=$PROBE_PASSWORD $* \\"
    echo "  --entrypoint sh $IMAGE -c 'sh /probe/scripts/$name.sh'"
    echo "=== container output follows ==="
  } | tee -a "$out/commands.txt"
  docker run --rm \
    -v "$PROBE_DIR:/probe:ro" \
    -v "$out:/evidence" \
    -v "$PROBE_DIR/configs/$config:/tmp/home/.config/opencode/opencode.json:ro" \
    -e PROBE_LOG_FILE=/evidence/events.jsonl \
    -e PROBE_SERVE_PORT="$SERVE_PORT" \
    -e PROBE_PASSWORD="$PROBE_PASSWORD" \
    "$@" \
    --entrypoint sh "$IMAGE" -c "sh /probe/scripts/$name.sh" 2>&1 | tee -a "$out/commands.txt"
}

fix_ownership() {
  local name="$1"
  docker run --rm -v "$PROBE_DIR:/w" "$TOOLCHAIN_IMAGE" chown -R "$HOST_UID_GID" "/w/evidence/$name"
}

scenario_load() {
  run_container load load.json
  fix_ownership load
}

scenario_tool_permission() {
  run_container tool-permission permission-ask.json -e PROBE_PERMISSION_REPLY=once
  fix_ownership tool-permission
}

scenario_auto_approve() {
  run_container auto-approve permission-ask.json
  fix_ownership auto-approve
}

scenario_api() {
  run_container api api.json -e PROBE_API_PROBE=1 -e PROBE_PERMISSION_REPLY=once
  fix_ownership api
}

scenario_variants() {
  run_container variants variants.json
  fix_ownership variants
}

scenario_session_error() {
  run_container session-error permission-ask.json
  fix_ownership session-error
}

scenario_file_path() {
  run_container file-path file-path.json
  fix_ownership file-path
}

scenario_package_dir() {
  run_container package-dir package-dir.json
  fix_ownership package-dir
}

chown_all() {
  docker run --rm -v "$PROBE_DIR:/w" "$TOOLCHAIN_IMAGE" chown -R "$HOST_UID_GID" /w/evidence
}

case "${1:-}" in
  load) check_port_free; scenario_load ;;
  tool-permission) check_port_free; scenario_tool_permission ;;
  auto-approve) check_port_free; scenario_auto_approve ;;
  api) check_port_free; scenario_api ;;
  variants) check_port_free; scenario_variants ;;
  session-error) check_port_free; scenario_session_error ;;
  file-path) check_port_free; scenario_file_path ;;
  package-dir) check_port_free; scenario_package_dir ;;
  all)
    check_port_free
    scenario_load
    scenario_tool_permission
    scenario_auto_approve
    scenario_api
    scenario_variants
    scenario_session_error
    scenario_file_path
    scenario_package_dir
    ;;
  chown) chown_all ;;
  *)
    sed -n '2,20p' "${BASH_SOURCE[0]}"
    exit 1
    ;;
esac
