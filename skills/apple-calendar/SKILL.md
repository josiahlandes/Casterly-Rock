---
name: apple-calendar
description: Query Apple Calendar events via AppleScript on macOS. View today's events, upcoming schedule, or events on specific dates.
metadata:
  {
    "openclaw": {
      "emoji": "📅",
      "os": ["darwin"]
    }
  }
---

# Apple Calendar Skill

Use AppleScript to read events from Apple Calendar. This is a **read-only** skill.

## Privacy Note

Calendar data is sensitive personal information. This skill runs locally and data never leaves the device.

## View Today's Events

```bash
osascript -e 'tell application "Calendar"
  set today to current date
  set startOfDay to today - (time of today)
  set endOfDay to startOfDay + (24 * 60 * 60)
  set output to ""
  repeat with cal in calendars
    set calEvents to (every event of cal whose start date >= startOfDay and start date < endOfDay)
    repeat with evt in calEvents
      set evtStart to start date of evt
      set evtSummary to summary of evt
      set timeStr to time string of evtStart
      set output to output & timeStr & " - " & evtSummary & "\n"
    end repeat
  end repeat
  if output is "" then
    return "No events today."
  else
    return output
  end if
end tell'
```

## View Tomorrow's Events

```bash
osascript -e 'tell application "Calendar"
  set today to current date
  set startOfDay to (today - (time of today)) + (24 * 60 * 60)
  set endOfDay to startOfDay + (24 * 60 * 60)
  set output to ""
  repeat with cal in calendars
    set calEvents to (every event of cal whose start date >= startOfDay and start date < endOfDay)
    repeat with evt in calEvents
      set evtStart to start date of evt
      set evtSummary to summary of evt
      set timeStr to time string of evtStart
      set output to output & timeStr & " - " & evtSummary & "\n"
    end repeat
  end repeat
  if output is "" then
    return "No events tomorrow."
  else
    return output
  end if
end tell'
```

## View Events for Next 7 Days

```bash
osascript -e 'tell application "Calendar"
  set today to current date
  set startOfDay to today - (time of today)
  set endDate to startOfDay + (7 * 24 * 60 * 60)
  set output to ""
  repeat with cal in calendars
    set calEvents to (every event of cal whose start date >= startOfDay and start date < endDate)
    repeat with evt in calEvents
      set evtStart to start date of evt
      set evtSummary to summary of evt
      set dateStr to short date string of evtStart
      set timeStr to time string of evtStart
      set output to output & dateStr & " " & timeStr & " - " & evtSummary & "\n"
    end repeat
  end repeat
  if output is "" then
    return "No events in the next 7 days."
  else
    return output
  end if
end tell'
```

## List All Calendars

```bash
osascript -e 'tell application "Calendar" to get name of every calendar'
```

## Example Usage

When the user asks "What's on my calendar today?", run the "View Today's Events" command.

When asked "What do I have this week?", run the "View Events for Next 7 Days" command.

## Permissions

The first time Calendar is accessed via AppleScript, macOS may prompt for permission. The user must grant access in System Settings > Privacy & Security > Automation.
