#!/usr/bin/env bash
# Real-TG smoke recipe — full run (executed by the orchestrator with the
# adapted plugin; NOT run automatically in ticket 05).
#
# Sends exactly one real Telegram lifecycle notification for a trivial model
# turn. The host ~/.otg is mounted read-only and copied to /tmp/home/.otg; all
# writes (registry, lock, diag) land in the copy only. Credentials are never
# printed.
#
# Environment:
#   T05_PLUGIN          path to the adapted single-file bundle (inside /plugin)
#   T05_REAL_SMOKE_FULL 0 (default, safe: poller lock guarded, no getUpdates)
#                       or 1 (container takes the lock; requires no other
#                       opencode instance running against the same bot token)
#
# Expected observations (see README runbook):
#   - the real Telegram chat receives one ✅ lifecycle notification for the
#     container project ("proj");
#   - ~/.otg/tgdiag.log (copy) shows MODULE LOADED / initialize() called /
#     runTelegram() started, and NO "Telegram message send failed" line;
#   - in safe mode the diag shows "poller lock held elsewhere" (no getUpdates
#     competition with the host bot);
#   - the host ~/.otg is byte-identical (read-only mount + verified isolation).
set -x

export HOME=/tmp/home
ROOT=/tmp/proj
mkdir -p "$HOME/.config/opencode/plugin" "$HOME/.otg" "$ROOT"
cd "$ROOT"

PLUGIN_SRC="${T05_PLUGIN:?T05_PLUGIN required}"
cp "$PLUGIN_SRC" "$HOME/.config/opencode/plugin/telegram-session-monitor.ts"

# ---- 1. read-only host mount guard -----------------------------------------
if touch /host-otg/t05-must-not-write 2>/dev/null; then
  rm -f /host-otg/t05-must-not-write
  echo "FATAL: /host-otg is writable; refusing to run the real-TG recipe"
  exit 1
fi
echo "ok: /host-otg is read-only"

# ---- 2. copy the real otg dir into the container ---------------------------
if [ -n "$(ls -A /host-otg 2>/dev/null)" ]; then
  cp -r /host-otg/. "$HOME/.otg/"
fi
if [ ! -f "$HOME/.otg/telegram.json" ]; then
  echo "FATAL: /host-otg/telegram.json is missing; cannot run the real-TG recipe"
  exit 1
fi
echo "ok: telegram.json copied (content not printed)"

# ---- 3. synthetic registry for the container project root -------------------
# The host registry points at host paths; the container project is /tmp/proj.
# Replacing it in the COPY (never the host) enables lifecycle notifications.
printf '{\n  "projects": [\n    {\n      "path": "%s",\n      "enabled": true,\n      "addedAt": "%s"\n    }\n  ]\n}\n' \
  "$ROOT" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" > "$HOME/.otg/projects.json"

# ---- 4. poller lock policy --------------------------------------------------
if [ "${T05_REAL_SMOKE_FULL:-0}" = "1" ]; then
  rm -f "$HOME/.otg"/*.lock
  echo "mode: FULL — the container may poll getUpdates; no other opencode must be running"
else
  printf '{"pid":1,"host":"t05-host-guard","ownerId":"t05-host-guard","createdAt":%s}' \
    "$(date +%s%3N)" > "$HOME/.otg/poller.lock"
  touch "$HOME/.otg/poller.lock"
  echo "mode: SAFE — poller lock guarded; lifecycle notifications only, no getUpdates"
fi

# ---- 5. brief run: one trivial model turn -----------------------------------
timeout 180 opencode run --standalone --print-logs --format json \
  "Reply with exactly: tg-smoke-ok" > /evidence/opencode-run.txt 2>&1
echo "run_exit=$?"

# ---- 6. collect observables -------------------------------------------------
sleep 3
cp "$HOME/.otg/tgdiag.log" /evidence/tgdiag-real-smoke.txt 2>/dev/null || true
cp "$HOME/.local/share/opencode/log/opencode.log" /evidence/server-log.txt 2>/dev/null || true
cp "$HOME/.otg/projects.json" /evidence/projects-after-smoke.json 2>/dev/null || true

echo "--- diag highlights ---"
grep -E "MODULE LOADED|initialize\(\) called|runTelegram|poller lock|sendMessage|Telegram message send failed|Telegram rejected" \
  "$HOME/.otg/tgdiag.log" 2>/dev/null || true
echo "--- send failure check ---"
if grep -q "Telegram message send failed\|Telegram rejected the configured bot token" "$HOME/.otg/tgdiag.log" 2>/dev/null; then
  echo "RESULT: FAIL the notification send did not succeed (see diag above)"
else
  echo "RESULT: ok no send-failure line; verify the ✅ message in the real Telegram chat"
fi
echo "--- evidence ---"
wc -l "$HOME/.otg/tgdiag.log" /evidence/opencode-run.txt 2>/dev/null || true
