#!/bin/bash
# Start the test daemon in background with FIFO input
# Usage: scripts/start-test-daemon.sh

set -euo pipefail

FIFO="/tmp/casterly-test-in"
OUT="/tmp/casterly-test-out"
PID_FILE="/tmp/casterly-test.pid"

cd /Users/tyrion/Documents/GitHub/Casterly-Rock

# Clean up any existing
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  kill "$OLD_PID" 2>/dev/null || true
  sleep 1
fi
rm -f "$FIFO" "$OUT"

# Create FIFO and output file
mkfifo "$FIFO"
: > "$OUT"

# Start daemon reading from FIFO, writing to output file
# The exec 3<> keeps the FIFO open after first write
(
  exec 3<>"$FIFO"
  node dist/src/imessage-daemon.js --console <&3 >> "$OUT" 2>&1
) &
DAEMON_PID=$!
echo "$DAEMON_PID" > "$PID_FILE"

echo "Daemon starting (PID $DAEMON_PID)..."
echo "Output: $OUT"
echo "Input FIFO: $FIFO"

# Wait for startup
for i in $(seq 1 60); do
  if grep -q "tyrion>" "$OUT" 2>/dev/null; then
    echo "Daemon ready! (took ${i}s)"
    exit 0
  fi
  sleep 1
done

echo "FAILED: Daemon did not start within 60s"
echo "Last output:"
tail -20 "$OUT"
exit 1
