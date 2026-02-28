#!/bin/bash
# Test harness for DeepLoop tests — waits longer, shows more detail
# Usage: ./scripts/test-repl-deep.sh "message"

MSG="$1"

echo "━━━ DEEP TEST: $MSG ━━━"
echo ""

# Run REPL with debug — DeepLoop needs more time
OUTPUT=$(echo "$MSG" | npx tsx src/terminal-repl.ts --debug 2>&1)

# Extract key info
CLASSIFICATION=$(echo "$OUTPUT" | grep -o 'Triage result: [a-z]*' | head -1)
CONFIDENCE=$(echo "$OUTPUT" | grep 'Triage result:' | grep -oE '"confidence":[0-9.]*' | head -1)

# All responses (fast ack + deep delivery)
RESPONSES=$(echo "$OUTPUT" | grep $'\x1b\[36m' | sed 's/.*\x1b\[36m//' | sed 's/\x1b\[0m.*//')

# DeepLoop activity
DEEP_PROCESSING=$(echo "$OUTPUT" | grep '\[deep-loop\] Processing task' | head -1)
DEEP_PLANNING=$(echo "$OUTPUT" | grep -c 'status.*planning')
DEEP_IMPLEMENTING=$(echo "$OUTPUT" | grep -c 'status.*implementing\|in_progress')
DEEP_REVIEWING=$(echo "$OUTPUT" | grep -c 'status.*reviewing')
DEEP_DONE=$(echo "$OUTPUT" | grep -c 'status.*done\|approved')
TOOL_CALLS=$(echo "$OUTPUT" | grep -oE 'tool_calls|toolCalls|Tool call|calling tool' | wc -l | tr -d ' ')
ERRORS=$(echo "$OUTPUT" | grep -iE '\[ERR\]|ProviderError|FAIL' | grep -v 'parse failure\|test error\|permission denied' | head -5)

echo "Classification: $CLASSIFICATION ($CONFIDENCE)"
echo "Responses:"
echo "$RESPONSES" | while read -r line; do [ -n "$line" ] && echo "  > $line"; done
echo ""
echo "DeepLoop: planning=$DEEP_PLANNING implementing=$DEEP_IMPLEMENTING reviewing=$DEEP_REVIEWING done=$DEEP_DONE"
echo "Tool calls detected: $TOOL_CALLS"
if [ -n "$DEEP_PROCESSING" ]; then
  echo "Processing: $DEEP_PROCESSING"
fi
if [ -n "$ERRORS" ]; then
  echo "ERRORS:"
  echo "$ERRORS" | while read -r line; do echo "  $line"; done
fi
echo ""

# Show final taskboard state
echo "TaskBoard after:"
cat ~/.casterly/taskboard.json | python3 -c "
import sys, json
data = json.load(sys.stdin)
for t in data.get('tasks', []):
    print(f\"  [{t['status']}] {t['id'][:12]}... — {t.get('originalMessage','')[:60]}\")
    if t.get('planSteps'):
        for s in t['planSteps']:
            print(f\"    step: [{s.get('status','?')}] {s.get('description','')[:50]}\")
    if t.get('resolution'):
        print(f\"    resolution: {t['resolution'][:80]}\")
" 2>/dev/null
echo ""
