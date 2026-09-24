#!/usr/bin/env bash
# Real-TG smoke recipe — read-only host ~/.otg mount mechanism check.
# Runs INSIDE hipc/opencode2:latest with the host ~/.otg mounted at /host-otg:ro.
#
# Proves, without contacting Telegram and without printing any credential:
#   1. /host-otg is mounted read-only;
#   2. a write attempt into /host-otg fails;
#   3. the config can be copied to a writable location inside the container;
#   4. writes into the copy never reach the host directory.
set -x

echo "--- mount entry for /host-otg ---"
grep host-otg /proc/mounts || echo "(no /host-otg mount found)"

echo "--- host files visible (names/sizes only) ---"
ls -la /host-otg 2>&1 | awk '{print $5, $9}'

echo "--- write attempt into /host-otg (must fail) ---"
if touch /host-otg/t05-must-not-write 2>/tmp/t05-ro-error.txt; then
  echo "RESULT: FAIL host mount is writable"
  rm -f /host-otg/t05-must-not-write
else
  echo "RESULT: ok host mount rejected write: $(cat /tmp/t05-ro-error.txt)"
fi

echo "--- copy to writable location ---"
mkdir -p /tmp/home/.otg
if [ -n "$(ls -A /host-otg 2>/dev/null)" ]; then
  cp -r /host-otg/. /tmp/home/.otg/
  echo "RESULT: copied $(ls -A /tmp/home/.otg | wc -l) entries"
else
  echo "RESULT: ok host ~/.otg is empty (copy is a no-op)"
fi

echo "--- copy isolation check ---"
echo "t05-marker" > /tmp/home/.otg/t05-copy-marker
if [ -e /host-otg/t05-copy-marker ]; then
  echo "RESULT: FAIL copy write leaked to the host mount"
else
  echo "RESULT: ok copy write stayed inside the container"
fi
rm -f /tmp/home/.otg/t05-copy-marker

echo "--- copy contents (names/sizes only) ---"
ls -la /tmp/home/.otg 2>&1 | awk '{print $5, $9}'
