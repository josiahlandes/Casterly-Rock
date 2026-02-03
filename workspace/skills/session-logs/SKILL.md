---
name: session-logs
description: Search and analyze your own session logs (older/parent conversations) using jq.
metadata: { "openclaw": { "emoji": "📜", "requires": { "bins": ["jq", "rg"] } } }
---

# session-logs

Search your complete conversation history stored in session JSONL files. Use this when a user references older/parent conversations or asks what was said before.

## Trigger

Use this skill when the user asks about prior chats, parent conversations, or historical context that isn't in memory files.

## Location

Session logs live at: `~/.casterly/sessions/`

- **`<session-key>.jsonl`** - Full conversation transcript per session
- Session keys follow pattern: `<channel>:main`, `<channel>:peer:<id>`, or `<channel>:channel:<id>`

## Structure

Each `.jsonl` file contains:

**Line 1 (metadata):**
- `key`: Session identifier
- `channel`: Channel type (imessage, cli, etc.)
- `createdAt`: When session started
- `lastActiveAt`: Last activity timestamp
- `totalMessages`: Total message count

**Subsequent lines (messages):**
- `role`: "user", "assistant", or "system"
- `content`: Message text (string)
- `timestamp`: ISO timestamp
- `sender`: For user messages, the sender identifier (optional)

## Common Queries

### List all sessions by date and size

```bash
for f in ~/.casterly/sessions/*.jsonl; do
  date=$(head -1 "$f" | jq -r '.createdAt' | cut -dT -f1)
  size=$(ls -lh "$f" | awk '{print $5}')
  echo "$date $size $(basename $f)"
done | sort -r
```

### Find sessions from a specific day

```bash
for f in ~/.casterly/sessions/*.jsonl; do
  head -1 "$f" | jq -r '.createdAt' | grep -q "2026-01-31" && echo "$f"
done
```

### Extract user messages from a session

```bash
jq -r 'select(.role == "user") | .content' <session>.jsonl
```

### Extract assistant messages from a session

```bash
jq -r 'select(.role == "assistant") | .content' <session>.jsonl
```

### Search for keyword in assistant responses

```bash
jq -r 'select(.role == "assistant") | .content' <session>.jsonl | rg -i "keyword"
```

### Search for keyword in user messages

```bash
jq -r 'select(.role == "user") | .content' <session>.jsonl | rg -i "keyword"
```

### Get session metadata

```bash
head -1 <session>.jsonl | jq '.'
```

### Count messages in a session

```bash
jq -s '{
  total: (length - 1),
  user: [.[] | select(.role == "user")] | length,
  assistant: [.[] | select(.role == "assistant")] | length,
  system: [.[] | select(.role == "system")] | length,
  first: .[1].timestamp,
  last: .[-1].timestamp
}' <session>.jsonl
```

### Get messages from a specific sender

```bash
jq -r 'select(.sender == "+1234567890") | .content' <session>.jsonl
```

### List all unique senders in a session

```bash
jq -r 'select(.sender) | .sender' <session>.jsonl | sort -u
```

### Get conversation timeline

```bash
jq -r 'select(.role) | "\(.timestamp | split("T")[1] | split(".")[0]) [\(.role)]: \(.content | .[0:80])"' <session>.jsonl
```

### Search across ALL sessions for a phrase

```bash
rg -l "phrase" ~/.casterly/sessions/*.jsonl
```

### Search with context

```bash
rg -C 2 "phrase" ~/.casterly/sessions/*.jsonl
```

### Find sessions by channel type

```bash
for f in ~/.casterly/sessions/*.jsonl; do
  channel=$(head -1 "$f" | jq -r '.channel')
  [[ "$channel" == "imessage" ]] && echo "$f"
done
```

### Get session activity summary

```bash
for f in ~/.casterly/sessions/*.jsonl; do
  meta=$(head -1 "$f")
  key=$(echo "$meta" | jq -r '.key')
  total=$(echo "$meta" | jq -r '.totalMessages')
  last=$(echo "$meta" | jq -r '.lastActiveAt' | cut -dT -f1)
  echo "$last $total messages - $key"
done | sort -r
```

## Tips

- Sessions are append-only JSONL (one JSON object per line)
- First line is always metadata, skip it for message queries using `tail -n +2`
- Large sessions can be several MB - use `head`/`tail` for sampling
- Session keys are sanitized for filesystem (special chars become `_`)
- Daily reset at 4 AM by default - older sessions may be archived

## Fast text-only hint (skip metadata line)

```bash
tail -n +2 ~/.casterly/sessions/<key>.jsonl | jq -r 'select(.role) | .content' | rg 'keyword'
```

## Example: Full conversation export

```bash
tail -n +2 <session>.jsonl | jq -r '"\(.role | ascii_upcase): \(.content)\n"'
```
