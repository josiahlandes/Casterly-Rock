---
name: system-control
description: Control macOS system functions - launch apps, adjust volume, manage windows, run AppleScript, and execute shell commands.
metadata:
  {
    "openclaw": {
      "emoji": "🖥️",
      "os": ["darwin"]
    }
  }
---

# System Control Skill

Control macOS system functions through shell commands and AppleScript.

## Launching Applications

Open any application by name:

```bash
open -a "Safari"
open -a "Messages"
open -a "Finder"
open -a "System Preferences"
```

Open a URL in the default browser:

```bash
open "https://example.com"
```

Open a file with its default application:

```bash
open ~/Documents/file.pdf
```

## Volume Control

Get current volume (0-100):

```bash
osascript -e 'output volume of (get volume settings)'
```

Set volume (0-100):

```bash
osascript -e 'set volume output volume 50'
```

Mute/unmute:

```bash
osascript -e 'set volume output muted true'
osascript -e 'set volume output muted false'
```

## Display Control

Get screen brightness (requires brightness CLI):

```bash
brightness -l
```

Set brightness (0.0 to 1.0):

```bash
brightness 0.7
```

## System Information

Get system info:

```bash
uname -a
```

Get macOS version:

```bash
sw_vers
```

Get current date/time:

```bash
date
```

Get disk usage:

```bash
df -h
```

Get memory usage:

```bash
vm_stat | head -10
```

Get CPU usage:

```bash
top -l 1 -n 0 | head -10
```

Get battery status:

```bash
pmset -g batt
```

## Process Management

List running applications:

```bash
osascript -e 'tell application "System Events" to get name of every process whose background only is false'
```

Quit an application gracefully:

```bash
osascript -e 'tell application "Safari" to quit'
```

Force quit an application:

```bash
pkill -9 Safari
```

## Notifications

Display a notification:

```bash
osascript -e 'display notification "Message here" with title "Title"'
```

## Clipboard

Get clipboard contents:

```bash
pbpaste
```

Set clipboard contents:

```bash
echo "text to copy" | pbcopy
```

## Screenshots

Take a screenshot of entire screen:

```bash
screencapture ~/Desktop/screenshot.png
```

Take a screenshot of a selected area (interactive):

```bash
screencapture -i ~/Desktop/screenshot.png
```

## Wi-Fi Control

Get current Wi-Fi network:

```bash
networksetup -getairportnetwork en0
```

Turn Wi-Fi on/off (requires sudo or approval):

```bash
networksetup -setairportpower en0 on
networksetup -setairportpower en0 off
```

## Do Not Disturb

Note: DND control via CLI is limited in recent macOS. Use Focus modes through System Settings.

## Sleep/Wake

Put display to sleep:

```bash
pmset displaysleepnow
```

Prevent sleep while a command runs:

```bash
caffeinate -i command-here
```

## Example Usage

When user says "Open Safari", run:
```bash
open -a "Safari"
```

When user says "What's my battery at?", run:
```bash
pmset -g batt
```

When user says "Turn the volume to 30%", run:
```bash
osascript -e 'set volume output volume 30'
```
