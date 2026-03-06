#!/bin/bash
# Send a single test message to console mode and capture ALL cyan responses.
# For DeepLoop tasks, waits for both FastLoop ack + DeepLoop response.
# Usage: scripts/test-one.sh "message" [timeout_seconds]

set -euo pipefail

FIFO="/tmp/casterly-test-in"
OUT="/tmp/casterly-test-out"
MSG="$1"
TIMEOUT="${2:-120}"

if [ ! -p "$FIFO" ]; then
  echo "ERROR: Daemon not running."
  exit 1
fi

# Record position before sending
BEFORE=$(wc -c < "$OUT" 2>/dev/null | tr -d ' ')

# Send message
echo "$MSG" > "$FIFO"

# Wait for response(s). The daemon delivers responses as cyan ANSI blocks.
# For complex tasks: FastLoop sends ack, DeepLoop sends result.
# Strategy: wait for cyan text to appear, then wait a bit more for completion.
ELAPSED=0
LAST_CYAN_COUNT=0
STABLE_TICKS=0

while [ $ELAPSED -lt "$TIMEOUT" ]; do
  sleep 3
  ELAPSED=$((ELAPSED + 3))

  # Get new output
  NEW=$(tail -c +$((BEFORE + 1)) "$OUT" 2>/dev/null || true)
  [ -z "$NEW" ] && continue

  # Count cyan responses so far
  CYAN_COUNT=$(echo "$NEW" | perl -ne '$c++ if /\x1b\[36m/; END{print $c//0}' 2>/dev/null)

  if [ "$CYAN_COUNT" -gt 0 ]; then
    if [ "$CYAN_COUNT" -eq "$LAST_CYAN_COUNT" ]; then
      STABLE_TICKS=$((STABLE_TICKS + 1))
      # If no new cyan responses for 2 ticks (6s) after at least one response, we're done
      if [ $STABLE_TICKS -ge 2 ]; then
        echo "$NEW" | perl -0777 -ne 'while (/\x1b\[36m(.*?)\x1b\[0m/sg) { print "$1\n---\n"; }'
        exit 0
      fi
    else
      STABLE_TICKS=0
      LAST_CYAN_COUNT=$CYAN_COUNT
    fi
  fi
done

# Timeout - extract whatever we got
NEW=$(tail -c +$((BEFORE + 1)) "$OUT" 2>/dev/null || true)
CYAN=$(echo "$NEW" | perl -0777 -ne 'while (/\x1b\[36m(.*?)\x1b\[0m/sg) { print "$1\n---\n"; }' 2>/dev/null)
if [ -n "$CYAN" ]; then
  echo "(PARTIAL - timed out waiting for more)"
  echo "$CYAN"
  exit 0
fi

echo "TIMEOUT (${TIMEOUT}s) - no cyan response found"
# Show last few log lines for debugging
echo "$NEW" | sed $'s/\x1b\[[0-9;]*m//g' | grep -v "^$" | tail -10
exit 1
