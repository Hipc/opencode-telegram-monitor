#!/usr/bin/env bash
# Ticket 05 — container e2e harness + §9/A probe runner.
#
# Everything runs in docker containers; nothing is installed on the host and no
# local opencode directories are touched. Containers use `--rm`, unique t05-
# names, an isolated HOME (/tmp/home) and evidence mounted from this directory.
#
# Usage:
#   tests/e2e/container/run.sh probe-a1                 # §9/A.1 + A.6 probe
#   tests/e2e/container/run.sh harness [--plugin FILE]  # e2e harness (stub or bundle)
#   tests/e2e/container/run.sh probe-lineage            # §9 subagent lineage probe
#   tests/e2e/container/run.sh build                    # bundle src/ via otg-toolchain
#   tests/e2e/container/run.sh real-tg-recipe --check   # read-only ~/.otg mechanism check
#   tests/e2e/container/run.sh real-tg-recipe --run     # full real-TG smoke (later)
#   tests/e2e/container/run.sh assert-probe-a1          # assertions over existing evidence
#   tests/e2e/container/run.sh assert-harness           # assertions over existing evidence
#   tests/e2e/container/run.sh assert-probe-lineage     # lineage evidence summary
#   tests/e2e/container/run.sh clean                    # remove leftover t05 containers
#
# Environment: T05_HARNESS_FORM_REPLY=1 adds the form closure phase,
# T05_HARNESS_RESOLVED_REPLY=1 adds the already-settled reply capture,
# T05_HARNESS_REPLY_ERROR_PROBE=1 adds the auxiliary client-error-shape double
# (run it with T05_HARNESS_OUT=<dir> to keep it separate from the canonical
# green-run evidence).
#
# Requirements: docker (images hipc/opencode2:latest, otg-toolchain:latest) and
# node on the host (assertions only). See README.md for details.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"

PROBE_A1_DIR="$CONTAINER_DIR/probe-a1"
PROBE_LINEAGE_DIR="$CONTAINER_DIR/probe-lineage"
HARNESS_DIR="$CONTAINER_DIR/harness"
ASSERT_DIR="$CONTAINER_DIR/assert"

scenario_probe_a1() {
  require_image "$OPENCODE_IMAGE"
  require_image "$TOOLCHAIN_IMAGE"
  local out="$EVIDENCE_ROOT/probe-a1"
  rm -rf "$out"; mkdir -p "$out"
  local port pw name
  port="$(free_port)"
  pw="$(synthetic_password)"
  name="t05-probe-a1-$$"
  log "probe-a1: port=$port password=<len ${#pw}> evidence=$out"
  {
    echo "=== scenario: probe-a1 (§9/A.1 form reply channel + A.6 natural question flow) ==="
    echo "=== exact command ==="
    echo "docker run --rm --name $name \\"
    echo "  -v $PROBE_A1_DIR:/probe-a1:ro \\"
    echo "  -v $out:/evidence \\"
    echo "  -e T05_PORT=$port -e T05_PASSWORD=<redacted> -e T05_PROBE_LOG=/evidence/probe-a1.jsonl -e T05_PROBE_REPLY=1 \\"
    echo "  --entrypoint sh $OPENCODE_IMAGE -c 'sh /probe-a1/scenario.sh'"
    echo "=== output follows ==="
  } > "$out/commands.txt"
  # The scenario owns its internal timeouts; the outer timeout is the last resort.
  timeout 600 docker run --rm --name "$name" \
    -v "$PROBE_A1_DIR:/probe-a1:ro" \
    -v "$out:/evidence" \
    -e T05_PORT="$port" \
    -e T05_PASSWORD="$pw" \
    -e T05_PROBE_LOG=/evidence/probe-a1.jsonl \
    -e T05_PROBE_REPLY=1 \
    --entrypoint sh "$OPENCODE_IMAGE" -c 'sh /probe-a1/scenario.sh' \
    >> "$out/commands.txt" 2>&1 || log "probe-a1 container exited non-zero (evidence preserved)"
  fix_ownership "$out"
  log "probe-a1: evidence written to $out"
}

scenario_harness() {
  require_image "$OPENCODE_IMAGE"
  require_image "$TOOLCHAIN_IMAGE"
  local plugin_file=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --plugin) plugin_file="$2"; shift 2 ;;
      *) fail "harness: unknown argument: $1" ;;
    esac
  done
  if [ -n "$plugin_file" ] && [ "${plugin_file#/}" = "$plugin_file" ]; then
    plugin_file="$PWD/$plugin_file"
  fi

  # T05_HARNESS_OUT lets the resolved-reply capture run into its own evidence
  # directory without clobbering the canonical green-run evidence.
  local out="${T05_HARNESS_OUT:-$EVIDENCE_ROOT/harness}"
  rm -rf "$out"; mkdir -p "$out"

  if [ -z "$plugin_file" ]; then
    # Default: build the worktree bundle through the toolchain image. The source
    # tree is copied inside the container so the build never writes to the host.
    plugin_file="$(build_plugin_bundle "$out")"
    log "harness: built plugin bundle at $plugin_file"
  elif [ ! -f "$plugin_file" ]; then
    fail "harness: --plugin file not found: $plugin_file"
  fi

  local port pw name
  port="$(free_port)"
  pw="$(synthetic_password)"
  name="t05-harness-$$"
  local plugin_dir
  plugin_dir="$(cd "$(dirname "$plugin_file")" && pwd)"
  local plugin_base
  plugin_base="$(basename "$plugin_file")"
  log "harness: port=$port password=<len ${#pw}> plugin=$plugin_file evidence=$out"
  log "harness: form_reply=${T05_HARNESS_FORM_REPLY:-0} model=${T05_HARNESS_MODEL:-0} resolved_reply=${T05_HARNESS_RESOLVED_REPLY:-0} reply_error_probe=${T05_HARNESS_REPLY_ERROR_PROBE:-0}"
  {
    echo "=== scenario: harness (lifecycle / waiting records / permission write-back closure) ==="
    echo "=== plugin under test ==="
    echo "$plugin_file"
    echo "=== exact command ==="
    echo "docker run --rm --name $name \\"
    echo "  -v $plugin_dir:/plugin:ro \\"
    echo "  -v $HARNESS_DIR:/harness:ro \\"
    echo "  -v $out:/evidence \\"
    echo "  -e T05_PLUGIN=/plugin/$plugin_base -e T05_PORT=$port -e T05_PASSWORD=<redacted> \\"
    echo "  -e T05_HARNESS_FORM_REPLY=${T05_HARNESS_FORM_REPLY:-0} -e T05_HARNESS_MODEL=${T05_HARNESS_MODEL:-0} \\"
    echo "  -e T05_HARNESS_RESOLVED_REPLY=${T05_HARNESS_RESOLVED_REPLY:-0} \\"
    echo "  -e T05_HARNESS_REPLY_ERROR_PROBE=${T05_HARNESS_REPLY_ERROR_PROBE:-0} \\"
    echo "  --entrypoint sh $OPENCODE_IMAGE -c 'sh /harness/scenario.sh'"
    echo "=== output follows ==="
  } > "$out/commands.txt"
  timeout 700 docker run --rm --name "$name" \
    -v "$plugin_dir:/plugin:ro" \
    -v "$HARNESS_DIR:/harness:ro" \
    -v "$out:/evidence" \
    -e T05_PLUGIN="/plugin/$plugin_base" \
    -e T05_PORT="$port" \
    -e T05_PASSWORD="$pw" \
    -e T05_HARNESS_FORM_REPLY="${T05_HARNESS_FORM_REPLY:-0}" \
    -e T05_HARNESS_MODEL="${T05_HARNESS_MODEL:-0}" \
    -e T05_HARNESS_RESOLVED_REPLY="${T05_HARNESS_RESOLVED_REPLY:-0}" \
    -e T05_HARNESS_REPLY_ERROR_PROBE="${T05_HARNESS_REPLY_ERROR_PROBE:-0}" \
    --entrypoint sh "$OPENCODE_IMAGE" -c 'sh /harness/scenario.sh' \
    >> "$out/commands.txt" 2>&1 || log "harness container exited non-zero (evidence preserved)"
  fix_ownership "$out"
  log "harness: evidence written to $out"
}

# Build the plugin bundle from this worktree inside otg-toolchain. The source is
# copied to /build inside the container; the artifact lands in the evidence dir.
# Prints the host path of the built artifact on stdout.
build_plugin_bundle() {
  local out="$1"
  local rel_src="${T05_PLUGIN_SRC:-$REPO_ROOT}"
  log "build: bundling $rel_src via $TOOLCHAIN_IMAGE"
  local status=0
  docker run --rm --name "t05-build-$$" \
    -v "$rel_src:/src:ro" \
    -v "$out:/out" \
    --entrypoint sh "$TOOLCHAIN_IMAGE" -c '
      set -e
      cp -r /src /build
      cd /build
      node scripts/build.mjs
      cp monitor.ts /out/plugin-under-test.ts
      echo "build ok: $(wc -c < /out/plugin-under-test.ts) bytes"
    ' 2>&1 | tee -a "$out/build.txt" >&2 || status=$?
  [ "$status" -eq 0 ] || fail "build: toolchain build failed (exit $status)"
  [ -s "$out/plugin-under-test.ts" ] || fail "build: artifact missing after build"
  fix_ownership "$out"
  echo "$out/plugin-under-test.ts"
}

assert_probe_a1() {
  local out="$EVIDENCE_ROOT/probe-a1"
  [ -d "$out" ] || fail "no probe-a1 evidence; run: run.sh probe-a1"
  node "$ASSERT_DIR/probe-a1.mjs" "$out"
}

assert_harness() {
  local out="${T05_HARNESS_OUT:-$EVIDENCE_ROOT/harness}"
  [ -d "$out" ] || fail "no harness evidence at $out; run: run.sh harness"
  local args=()
  if [ "${T05_HARNESS_FORM_REPLY:-0}" = "1" ]; then
    args+=(--form-reply)
  fi
  if [ "${T05_HARNESS_RESOLVED_REPLY:-0}" = "1" ]; then
    args+=(--resolved-reply)
  fi
  if [ "${T05_HARNESS_REPLY_ERROR_PROBE:-0}" = "1" ]; then
    args+=(--reply-error-probe)
  fi
  node "$ASSERT_DIR/harness.mjs" "$out" "${args[@]}"
}

# ---- subagent lineage probe (contract §9 open item) --------------------------
scenario_lineage() {
  require_image "$OPENCODE_IMAGE"
  local out="$EVIDENCE_ROOT/probe-lineage"
  rm -rf "$out"; mkdir -p "$out"
  local port pw name
  port="$(free_port)"
  pw="$(synthetic_password)"
  name="t05b-lineage-$$"
  log "probe-lineage: port=$port password=<len ${#pw}> evidence=$out"
  {
    echo "=== scenario: probe-lineage (subagent lineage / parentID observability) ==="
    echo "=== exact command ==="
    echo "docker run --rm --name $name \\"
    echo "  -v $PROBE_LINEAGE_DIR:/probe-lineage:ro \\"
    echo "  -v $out:/evidence \\"
    echo "  -e T05_PORT=$port -e T05_PASSWORD=<redacted> -e T05_PROBE_LOG=/evidence/probe-lineage.jsonl \\"
    echo "  --entrypoint sh $OPENCODE_IMAGE -c 'sh /probe-lineage/scenario.sh'"
    echo "=== output follows ==="
  } > "$out/commands.txt"
  timeout 900 docker run --rm --name "$name" \
    -v "$PROBE_LINEAGE_DIR:/probe-lineage:ro" \
    -v "$out:/evidence" \
    -e T05_PORT="$port" \
    -e T05_PASSWORD="$pw" \
    -e T05_PROBE_LOG=/evidence/probe-lineage.jsonl \
    --entrypoint sh "$OPENCODE_IMAGE" -c 'sh /probe-lineage/scenario.sh' \
    >> "$out/commands.txt" 2>&1 || log "probe-lineage container exited non-zero (evidence preserved)"
  fix_ownership "$out"
  log "probe-lineage: evidence written to $out"
}

assert_lineage() {
  local out="$EVIDENCE_ROOT/probe-lineage"
  [ -d "$out" ] || fail "no probe-lineage evidence; run: run.sh probe-lineage"
  node "$ASSERT_DIR/probe-lineage.mjs" "$out"
}

scenario_build() {
  require_image "$TOOLCHAIN_IMAGE"
  local out="$EVIDENCE_ROOT/build"
  rm -rf "$out"; mkdir -p "$out"
  {
    echo "=== scenario: build (scripts/build.mjs via otg-toolchain) ==="
    echo "=== exact command ==="
    echo "docker run --rm --name t05-build-<pid> -v <repo>:/src:ro -v $out:/out --entrypoint sh $TOOLCHAIN_IMAGE -c 'cp -r /src /build && cd /build && node scripts/build.mjs && cp monitor.ts /out/plugin-under-test.ts'"
    echo "=== output follows ==="
  } > "$out/commands.txt"
  local artifact
  artifact="$(build_plugin_bundle "$out")"
  log "build: artifact at $artifact ($(wc -c < "$artifact") bytes)"
  echo "built: $artifact ($(wc -c < "$artifact") bytes)" >> "$out/commands.txt"
}

scenario_real_tg_recipe() {
  require_image "$OPENCODE_IMAGE"
  local mode="check" plugin_file=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --check) mode="check"; shift ;;
      --run) mode="run"; shift ;;
      --plugin) plugin_file="$2"; shift 2 ;;
      *) fail "real-tg-recipe: unknown argument: $1" ;;
    esac
  done
  [ -d "$HOME/.otg" ] || fail "real-tg-recipe: $HOME/.otg not found (docker would create it on the host)"
  if [ "$mode" = "run" ]; then
    [ -f "$HOME/.otg/telegram.json" ] || fail "real-tg-recipe: $HOME/.otg/telegram.json not found"
  fi
  local out="$EVIDENCE_ROOT/real-tg-recipe"
  rm -rf "$out"; mkdir -p "$out"

  if [ "$mode" = "check" ]; then
    local name="t05-real-tg-check-$$"
    log "real-tg-recipe: read-only mount mechanism check"
    {
      echo "=== scenario: real-tg-recipe --check (read-only mount mechanism) ==="
      echo "=== exact command ==="
      echo "docker run --rm --name $name -v \$HOME/.otg:/host-otg:ro -v $HARNESS_DIR:/harness:ro -v $out:/evidence --entrypoint sh $OPENCODE_IMAGE -c 'sh /harness/real-tg-check.sh'"
      echo "=== output follows ==="
    } > "$out/commands.txt"
    docker run --rm --name "$name" \
      -v "$HOME/.otg:/host-otg:ro" \
      -v "$HARNESS_DIR:/harness:ro" \
      -v "$out:/evidence" \
      --entrypoint sh "$OPENCODE_IMAGE" -c 'sh /harness/real-tg-check.sh' \
      >> "$out/commands.txt" 2>&1 || log "real-tg check exited non-zero (see evidence)"
    fix_ownership "$out"
    log "real-tg-recipe: evidence written to $out"
    return 0
  fi

  # ---- full run (orchestrator-scheduled, with the adapted plugin) ----------
  if [ -z "$plugin_file" ]; then
    plugin_file="$(build_plugin_bundle "$out")"
  elif [ "${plugin_file#/}" = "$plugin_file" ]; then
    plugin_file="$PWD/$plugin_file"
  fi
  [ -f "$plugin_file" ] || fail "real-tg-recipe: plugin not found: $plugin_file"
  local plugin_dir plugin_base name
  plugin_dir="$(cd "$(dirname "$plugin_file")" && pwd)"
  plugin_base="$(basename "$plugin_file")"
  name="t05-real-tg-$$"
  # Host-side fingerprint (information only): the container must not change it.
  {
    echo "=== host ~/.otg fingerprint BEFORE (name size mtime) ==="
    ( cd "$HOME/.otg" && find . -maxdepth 1 -type f -printf '%P\t%s\t%T@\n' | sort )
  } > "$out/host-otg-before.txt"
  {
    echo "=== scenario: real-tg-recipe --run (one real Telegram notification) ==="
    echo "=== exact command ==="
    echo "docker run --rm --name $name \\"
    echo "  -v \$HOME/.otg:/host-otg:ro \\"
    echo "  -v $plugin_dir:/plugin:ro \\"
    echo "  -v $HARNESS_DIR:/harness:ro \\"
    echo "  -v $out:/evidence \\"
    echo "  -e T05_PLUGIN=/plugin/$plugin_base -e T05_REAL_SMOKE_FULL=${T05_REAL_SMOKE_FULL:-0} \\"
    echo "  --entrypoint sh $OPENCODE_IMAGE -c 'sh /harness/real-tg-recipe.sh'"
    echo "=== output follows ==="
  } > "$out/commands.txt"
  timeout 300 docker run --rm --name "$name" \
    -v "$HOME/.otg:/host-otg:ro" \
    -v "$plugin_dir:/plugin:ro" \
    -v "$HARNESS_DIR:/harness:ro" \
    -v "$out:/evidence" \
    -e T05_PLUGIN="/plugin/$plugin_base" \
    -e T05_REAL_SMOKE_FULL="${T05_REAL_SMOKE_FULL:-0}" \
    --entrypoint sh "$OPENCODE_IMAGE" -c 'sh /harness/real-tg-recipe.sh' \
    >> "$out/commands.txt" 2>&1 || log "real-tg recipe exited non-zero (see evidence)"
  fix_ownership "$out"
  {
    echo "=== host ~/.otg fingerprint AFTER (name size mtime) ==="
    ( cd "$HOME/.otg" && find . -maxdepth 1 -type f -printf '%P\t%s\t%T@\n' | sort )
  } > "$out/host-otg-after.txt"
  if diff -u "$out/host-otg-before.txt" "$out/host-otg-after.txt" > "$out/host-otg-diff.txt"; then
    log "real-tg-recipe: host ~/.otg unchanged"
  else
    log "real-tg-recipe: host ~/.otg fingerprint changed (see host-otg-diff.txt; the host's own processes may be responsible)"
  fi
  log "real-tg-recipe: evidence written to $out"
}

case "${1:-}" in
  probe-a1) shift; scenario_probe_a1 "$@" ;;
  harness) shift; scenario_harness "$@" ;;
  probe-lineage) shift; scenario_lineage "$@" ;;
  build) shift; scenario_build "$@" ;;
  assert-probe-a1) shift; assert_probe_a1 "$@" ;;
  assert-harness) shift; assert_harness "$@" ;;
  assert-probe-lineage) shift; assert_lineage "$@" ;;
  real-tg-recipe) shift; scenario_real_tg_recipe "$@" ;;
  clean) cleanup_containers ;;
  *)
    sed -n '2,26p' "${BASH_SOURCE[0]}"
    exit 1
    ;;
esac
