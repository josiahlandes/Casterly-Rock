#!/bin/bash
# Test harness for dual-loop REPL testing
# Usage: ./scripts/test-repl.sh "message"

MSG="$1"

echo "━━━ TEST: $MSG ━━━"
echo ""

# Run REPL with debug, capture full output (no timeout command on macOS)
OUTPUT=$(echo "$MSG" | npx tsx src/terminal-repl.ts --debug 2>&1)

# Extract key info
CLASSIFICATION=$(echo "$OUTPUT" | grep -o 'Triage result: [a-z]*' | head -1)
CONFIDENCE=$(echo "$OUTPUT" | grep 'Triage result:' | grep -o '"confidence":[0-9.]*' | head -1)
VOICE_RESULT=$(echo "$OUTPUT" | grep 'Voice filter' | grep -oE '(applied|failed)[^"]*' | head -1)
FINAL=$(echo "$OUTPUT" | grep $'\x1b\[36m' | sed 's/.*\x1b\[36m//' | sed 's/\x1b\[0m.*//')
TASK_STATUS=$(echo "$OUTPUT" | grep 'Task created' | grep -oE '"status":"[^"]*"' | head -1)
DEEP_ACTIVITY=$(echo "$OUTPUT" | grep '\[deep-loop\]' | grep -v 'started\|stopped' | head -3)
ERRORS=$(echo "$OUTPUT" | grep -iE '\[ERR\]|error.*failed' | grep -v 'parse failure' | head -3)

echo "Classification: $CLASSIFICATION ($CONFIDENCE)"
echo "Voice filter:   $VOICE_RESULT"
echo "Task status:    $TASK_STATUS"
echo "Response:       $FINAL"
if [ -n "$DEEP_ACTIVITY" ]; then
  echo "DeepLoop:"
  echo "$DEEP_ACTIVITY" | while read line; do echo "  $line"; done
fi
if [ -n "$ERRORS" ]; then
  echo "ERRORS:"
  echo "$ERRORS" | while read line; do echo "  $line"; done
fi
echo ""
