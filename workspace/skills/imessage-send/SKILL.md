---
name: imessage-send
description: Send iMessages to contacts via AppleScript. Can send to phone numbers or Apple IDs.
metadata:
  {
    "openclaw": {
      "emoji": "💬",
      "os": ["darwin"]
    }
  }
---

# iMessage Send Skill

Send iMessages using AppleScript. Requires Messages.app to be signed into an iMessage account.

## Privacy Note

This skill can send messages on behalf of the user. Use with care and always confirm the recipient before sending.

## Send a Message

To send a message to a phone number:

```bash
osascript -e 'tell application "Messages"
  set targetService to 1st service whose service type = iMessage
  set targetBuddy to buddy "+15551234567" of targetService
  send "Your message here" to targetBuddy
end tell'
```

To send to an email address (Apple ID):

```bash
osascript -e 'tell application "Messages"
  set targetService to 1st service whose service type = iMessage
  set targetBuddy to buddy "person@example.com" of targetService
  send "Your message here" to targetBuddy
end tell'
```

## Important Notes

1. **Phone numbers must include country code** (e.g., +1 for US)
2. **Messages app must be open** (it will launch automatically)
3. **Recipient must be reachable via iMessage** - won't work for SMS-only contacts
4. **Escape quotes** in the message text using backslash

## Handling Special Characters

If the message contains quotes or special characters:

```bash
osascript -e 'tell application "Messages"
  set targetService to 1st service whose service type = iMessage
  set targetBuddy to buddy "+15551234567" of targetService
  set theMessage to "Hello! How'\''s it going?"
  send theMessage to targetBuddy
end tell'
```

## Example Usage

When user says "Text John that I'm running late":
1. First confirm John's phone number with the user
2. Then send the message:

```bash
osascript -e 'tell application "Messages"
  set targetService to 1st service whose service type = iMessage
  set targetBuddy to buddy "+1JOHNSPHONE" of targetService
  send "I'\''m running late" to targetBuddy
end tell'
```

## Limitations

- Cannot read messages (use the iMessage reader module for that)
- Cannot send to group chats via this method
- Cannot send attachments via CLI
- Requires iMessage, not SMS
