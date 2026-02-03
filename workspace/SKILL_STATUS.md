# Skill Status Report

Generated: 2026-01-31 (Final - after cleanup and adaptation)

## Summary

- **Total Skills:** 24
- **Ready (CLI installed):** 20
- **Needs Setup:** 4 (permissions, config, or API keys required)

## Legend

- ✅ Ready (CLI installed)
- ⚙️ Needs Setup (permissions, config, or API keys)

---

## Ready Skills (CLI Installed)

| Skill | CLI | Description |
|-------|-----|-------------|
| **apple-calendar** | `osascript` | ✅ Read/create calendar events via AppleScript |
| **apple-notes** | `memo` | ✅ Access Apple Notes (needs Automation permission) |
| **apple-reminders** | `remindctl` | ✅ Manage Reminders (needs authorization) |
| **bear-notes** | `grizzly` | ✅ Access Bear notes (needs Bear app + token) |
| **bird** | `bird` | ✅ Post to X/Twitter (needs cookies setup) |
| **blogwatcher** | `blogwatcher` | ✅ Monitor RSS feeds and blogs |
| **camsnap** | `camsnap` + `ffmpeg` | ✅ Capture webcam frames |
| **clawhub** | `clawhub` | ✅ OpenClaw skill management |
| **coding-agent** | `claude` | ✅ Launch Claude Code subagents |
| **gifgrep** | `gifgrep` | ✅ Search and manage GIFs |
| **github** | `gh` | ✅ GitHub CLI (authenticated) |
| **gog** | `gog` | ✅ Google services CLI (needs OAuth) |
| **goplaces** | `goplaces` | ✅ Google Places search (needs API key) |
| **himalaya** | `himalaya` | ✅ Email client (needs config) |
| **imessage-send** | `osascript` | ✅ Send iMessages via AppleScript |
| **imsg** | `imsg` | ✅ Read iMessage history (needs Full Disk Access) |
| **mcporter** | `mcporter` | ✅ MCP server management |
| **nano-pdf** | `nano-pdf` | ✅ Edit PDFs with natural language |
| **session-logs** | `jq` + `rg` | ✅ Search Casterly conversation history |
| **spotify-player** | `spotify_player` | ✅ Control Spotify playback |
| **system-control** | `osascript` | ✅ macOS system control (volume, apps, etc.) |
| **tmux** | `tmux` | ✅ Manage tmux sessions for interactive CLIs |
| **video-frames** | `ffmpeg` | ✅ Extract frames from videos |
| **weather** | `curl` | ✅ Weather forecasts (no API key needed) |

## Skills Needing Additional Setup

| Skill | What's Needed |
|-------|---------------|
| **apple-notes** | Grant Automation permission for Notes.app |
| **apple-reminders** | Run `remindctl authorize` + grant permission |
| **gog** | Google OAuth setup: `gog auth add you@gmail.com` |
| **goplaces** | Set `GOOGLE_PLACES_API_KEY` env var |

---

## Installed Tools Summary

All required CLIs are installed on tyrion.local:

```
✅ memo        ✅ remindctl   ✅ grizzly     ✅ bird
✅ blogwatcher ✅ camsnap     ✅ clawhub     ✅ claude
✅ gifgrep     ✅ gh          ✅ gog         ✅ goplaces
✅ himalaya    ✅ imsg        ✅ mcporter    ✅ tmux
✅ uv          ✅ ffmpeg      ✅ curl        ✅ jq
✅ osascript   ✅ go          ✅ node/npm    ✅ rg
✅ nano-pdf    ✅ spotify_player
```

---

## Session Logs Skill

The session-logs skill has been adapted for Casterly's session format:

- **Location:** `~/.casterly/sessions/`
- **Format:** JSONL with metadata on line 1, messages on subsequent lines
- **Message structure:** `{role, content, timestamp, sender?}`

Use `jq` and `rg` to search conversation history. See `skills/session-logs/SKILL.md` for query examples.

---

## Quick Permission Setup

Run these on tyrion to complete setup:

```bash
# Reminders
remindctl authorize

# Google (for gog/goplaces)
gog auth add your@email.com --services gmail,calendar,drive
export GOOGLE_PLACES_API_KEY="your-key"
```

For Calendar, Notes, Messages - open System Settings → Privacy & Security → Automation and grant access when prompted.
