#!/usr/bin/env bash
# Shared helpers for the ticket 05 container harness.
#
# Every helper is deliberately small and explicit: docker runs are always
# `--rm`, containers are named with the t05- prefix, ports are checked against
# the host listener table before use, and files written by root inside a
# container are chowned back with the otg-toolchain image.
#
# Sourced by tests/e2e/container/run.sh only.

set -euo pipefail

CONTAINER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$CONTAINER_DIR/../../.." && pwd)"
EVIDENCE_ROOT="${T05_EVIDENCE_DIR:-$CONTAINER_DIR/evidence}"
OPENCODE_IMAGE="${T05_OPENCODE_IMAGE:-hipc/opencode2:latest}"
TOOLCHAIN_IMAGE="${T05_TOOLCHAIN_IMAGE:-otg-toolchain:latest}"
HOST_UID_GID="$(id -u):$(id -g)"

log() { printf '[t05] %s\n' "$*" >&2; }
fail() { printf '[t05] ERROR: %s\n' "$*" >&2; exit 1; }

# Pick a free host port (checked against `ss -tln`) for use INSIDE the container
# network namespace. Containers publish no ports; the check keeps parallel runs
# on other worktrees from colliding on documented defaults and honours the
# project rule to avoid a busy port (e.g. 18004). T05_PORT overrides.
free_port() {
  local candidate
  for _ in $(seq 1 40); do
    candidate=$((20000 + RANDOM % 20000))
    [ "$candidate" -eq 18004 ] && continue
    if command -v ss >/dev/null 2>&1; then
      ss -tln 2>/dev/null | awk '{print $4}' | grep -q ":${candidate}\$" && continue
    fi
    echo "$candidate"
    return 0
  done
  fail "could not find a free port"
}

# Random base64url password for the synthetic serve instance (never printed in
# full; only its length is logged).
synthetic_password() {
  head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '='
}

# Run a container scenario. Usage:
#   run_scenario <name> <image> <workdir-on-host> <args...> --entrypoint sh <image> -c <cmd>
# The caller passes the full docker argument list after <name>.
docker_run_named() {
  local name="$1"; shift
  docker run --rm --name "$name" "$@"
}

# Fix ownership of root-written evidence with the toolchain image.
fix_ownership() {
  local target="$1"
  [ -e "$target" ] || return 0
  docker run --rm --name "t05-chown-$$" -v "$target:/w" "$TOOLCHAIN_IMAGE" \
    chown -R "$HOST_UID_GID" /w >/dev/null
}

# Kill leftover containers from an interrupted run (only our own t05*/t05b* prefix).
cleanup_containers() {
  local names
  names=$(docker ps -a --filter "name=^/t05" --format '{{.Names}}' 2>/dev/null || true)
  if [ -n "$names" ]; then
    log "removing leftover t05* containers: $(echo "$names" | tr '\n' ' ')"
    # shellcheck disable=SC2086
    docker rm -f $names >/dev/null 2>&1 || true
  fi
}

# Require a docker image up front with an actionable message.
require_image() {
  docker image inspect "$1" >/dev/null 2>&1 || fail "docker image not found: $1"
}
