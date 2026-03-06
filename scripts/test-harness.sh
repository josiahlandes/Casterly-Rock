#!/bin/bash
# Test harness for console mode integration tests
# Sends a message and captures the response with timeout

set -euo pipefail

CASTERLY_DIR="/Users/tyrion/Documents/GitHub/Casterly-Rock"
LOG_DIR="$CASTERLY_DIR/.test-results"
CONSOLE_PID_FILE="$LOG_DIR/console.pid"
CONSOLE_OUT="$LOG_DIR/console.out"
CONSOLE_IN="$LOG_DIR/console.in"

mkdir -p "$LOG_DIR"

start_console() {
  # Clean up any existing
  stop_console 2>/dev/null || true

  # Create named pipe for input
  rm -f "$CONSOLE_IN"
  mkfifo "$CONSOLE_IN"

  # Start console mode, reading from named pipe, output to file
  cd "$CASTERLY_DIR"
  # Keep the pipe open with a background cat that reads from a fd
  (
    exec 3<>"$CONSOLE_IN"  # keep pipe open
    node dist/src/imessage-daemon.js --console <&3 2>&1 | tee "$CONSOLE_OUT"
  ) &
  echo $! > "$CONSOLE_PID_FILE"

  # Wait for startup
  echo "Waiting for console to start..."
  for i in $(seq 1 30); do
    if grep -q "tyrion>" "$CONSOLE_OUT" 2>/dev/null; then
      echo "Console started (PID $(cat $CONSOLE_PID_FILE))"
      return 0
    fi
    sleep 1
  done
  echo "FAILED: Console did not start within 30s"
  return 1
}

send_message() {
  local msg="$1"
  local timeout="${2:-60}"

  # Record line count before sending
  local before=$(wc -l < "$CONSOLE_OUT" 2>/dev/null || echo 0)

  # Send message
  echo "$msg" > "$CONSOLE_IN"

  # Wait for response (cyan ANSI output or new tyrion> prompt after response)
  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    local after=$(wc -l < "$CONSOLE_OUT" 2>/dev/null || echo 0)
    # Check if we got a response (new content after our input)
    if [ "$after" -gt "$before" ]; then
      # Check if we see a new prompt after response content
      local new_content=$(tail -n +$((before + 1)) "$CONSOLE_OUT")
      if echo "$new_content" | grep -q "tyrion>" 2>/dev/null; then
        # Extract response (between our input and the next prompt)
        echo "$new_content" | sed 's/\x1b\[[0-9;]*m//g' | grep -v "^tyrion>" | grep -v "^$"
        return 0
      fi
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  echo "TIMEOUT after ${timeout}s"
  return 1
}

stop_console() {
  if [ -f "$CONSOLE_PID_FILE" ]; then
    local pid=$(cat "$CONSOLE_PID_FILE")
    kill -TERM "$pid" 2>/dev/null || true
    # Also kill any child processes
    pkill -P "$pid" 2>/dev/null || true
    rm -f "$CONSOLE_PID_FILE"
  fi
  rm -f "$CONSOLE_IN"
}

get_output() {
  cat "$CONSOLE_OUT" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g'
}

case "${1:-}" in
  start) start_console ;;
  send) send_message "${2:-}" "${3:-60}" ;;
  stop) stop_console ;;
  output) get_output ;;
  *) echo "Usage: $0 {start|send <msg> [timeout]|stop|output}" ;;
esac
