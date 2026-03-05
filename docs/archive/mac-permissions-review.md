# Mac Permissions Review & App Wrapper Proposal

## Problem Statement

Casterly currently installs as a Node.js CLI via symlink (`~/.local/bin/casterly`). On macOS, this means **all system permissions are granted to the terminal emulator** (Terminal.app, iTerm2, etc.) rather than to Casterly itself. This creates several problems:

1. **Over-broad permissions** — Granting Full Disk Access to your terminal gives _every_ command-line program the same access, not just Casterly.
2. **Confusing permission prompts** — AppleScript automation dialogs reference the terminal app, not Casterly. Users don't understand why "iTerm2 wants to control Messages."
3. **Fragile across terminal changes** — Switching from iTerm to Warp or Ghostty means re-granting all permissions.
4. **No way to revoke Casterly-specific access** — Because permissions are tied to the terminal, removing Casterly's access means removing it for everything.
5. **No auto-update UX** — The current Git-pull update path (`scripts/self-update.sh`) has no user-facing update prompt, no rollback, and no code signing.
6. **iMessage daemon runs as a bare process** — No launchd integration, no crash recovery, no visibility in Activity Monitor under a recognizable name.

---

## Current Permission Surface

Every macOS permission Casterly touches, and the mechanism that triggers it:

| Permission | Trigger | File(s) | Notes |
|---|---|---|---|
| **Full Disk Access** | Reading `~/Library/Messages/chat.db` via sqlite3 | `src/imessage/reader.ts:30` | Required for iMessage daemon |
| **Automation → Messages** | `osascript` controlling Messages.app to send iMessages | `src/imessage/sender.ts:37,64` | Prompted per-app on first use |
| **Automation → Calendar** | `osascript` querying Calendar.app events | `skills/apple-calendar/SKILL.md` | Prompted per-app on first use |
| **Automation → System Events** | Listing running processes via System Events | `skills/system-control/SKILL.md:124` | Required for process management |
| **Screen Recording** | `screencapture` command | `skills/system-control/SKILL.md:166` | Prompted on first use |
| **Accessibility** | Potential future use for window management, key simulation | Not yet used | Would be needed for deeper system control |
| **Network (outbound)** | Ollama HTTP on localhost; cloud provider API calls | `src/providers/ollama.ts` | No firewall prompt for localhost |
| **Notifications** | `display notification` via osascript | `skills/system-control/SKILL.md:144` | Tied to Script Editor or terminal |

### How permissions are currently granted

All of the above are granted to whichever app invokes the subprocess:

- **CLI mode**: Permissions go to Terminal.app / iTerm2 / etc.
- **iMessage daemon via `npm run imessage`**: Still Terminal, since it's launched from a shell.
- **No launchd plist**: The daemon isn't registered as a system service.

---

## Proposed Architecture: macOS App Wrapper

Wrap Casterly's Node.js runtime and all native integrations (except Ollama) into a signed macOS `.app` bundle. Ollama stays separate because it's already a standalone app with its own permission grants.

### What goes inside the wrapper

```
Casterly.app/
├── Contents/
│   ├── Info.plist              # Bundle ID, permissions declarations
│   ├── MacOS/
│   │   └── casterly-launcher   # Thin native binary (Swift/ObjC) that:
│   │                           #   1. Starts embedded Node.js
│   │                           #   2. Manages lifecycle (launchd, login item)
│   │                           #   3. Shows menu bar status icon
│   ├── Resources/
│   │   ├── node                # Bundled Node.js runtime
│   │   ├── app/                # Built JS (contents of dist/)
│   │   ├── config/             # Default config
│   │   ├── skills/             # Bundled skills
│   │   └── icon.icns           # App icon
│   ├── Frameworks/             # Sparkle.framework (auto-update)
│   └── Entitlements.plist      # Hardened runtime entitlements
```

### What stays outside

| Component | Reason |
|---|---|
| **Ollama** | Separate app, own permissions, own update cycle. Casterly talks to it over HTTP localhost — no permission coupling. |
| **User workspace** (`~/.casterly/`) | User data stays in the home directory, survives app updates. |
| **Config overrides** (`~/.casterly/config/`) | User customizations shouldn't live inside the app bundle. |

### Launcher responsibilities

The native launcher (`casterly-launcher`) would be a thin Swift binary handling:

1. **Embedded Node.js lifecycle** — Spawn `node app/index.js` with the correct environment, restart on crash.
2. **Menu bar presence** — Status item showing Casterly is running, with quick actions (pause, open logs, check for updates, quit).
3. **Login item registration** — `SMAppService` (macOS 13+) to start at login without a LaunchAgent plist.
4. **Permission brokering** — All `osascript` and `sqlite3` calls originate from the `.app` bundle, so macOS ties permissions to "Casterly" specifically.
5. **IPC with CLI** — A Unix domain socket at `~/.casterly/casterly.sock` so the `casterly` CLI command can talk to the running app instance rather than spawning its own Node process.

### Permission declarations

`Info.plist` entries that tell macOS what Casterly needs:

```xml
<key>NSAppleEventsUsageDescription</key>
<string>Casterly uses AppleScript to interact with Messages, Calendar, and other apps on your behalf.</string>

<key>NSCalendarsUsageDescription</key>
<string>Casterly reads your calendar to help manage your schedule.</string>

<key>NSScreenCaptureUsageDescription</key>
<string>Casterly can take screenshots when you ask.</string>
```

Hardened runtime entitlements (`Entitlements.plist`):

```xml
<key>com.apple.security.automation.apple-events</key>
<true/>
<key>com.apple.security.temporary-exception.apple-events</key>
<array>
    <string>com.apple.iChat</string>        <!-- Messages -->
    <string>com.apple.iCal</string>         <!-- Calendar -->
    <string>com.apple.systemevents</string> <!-- System Events -->
</array>
```

---

## Installation & Update Flow

### Installation (new)

```
Current:  git clone → npm install → npm run install:host → grant perms to Terminal
Proposed: Download Casterly.dmg → drag to /Applications → launch → grant perms to Casterly.app
```

A DMG with a drag-to-Applications layout. On first launch:

1. App registers as a login item.
2. macOS prompts for each permission as needed (Full Disk Access, Automation).
3. App checks that Ollama is reachable at localhost:11434, shows setup guidance if not.
4. CLI tool (`casterly`) installed to `/usr/local/bin/` via a privileged helper or symlink into the app bundle's `MacOS/` directory.

### Updates (new)

Replace `scripts/self-update.sh` (git pull) with **Sparkle** for the app bundle:

| Aspect | Current (git pull) | Proposed (Sparkle) |
|---|---|---|
| Trigger | Manual or LLM-initiated | Background check + user prompt |
| Mechanism | `git fetch && git pull --ff-only` | Download signed `.zip`, replace app bundle |
| Code signing | None | Developer ID + notarization |
| Rollback | `git stash` | Sparkle keeps previous version |
| User visibility | Terminal output | Native macOS update dialog |
| Delta updates | Full git pull | Sparkle supports binary diffs |

Sparkle appcast feed hosted at a static URL. Updates are signed with EdDSA (Sparkle 2.x).

### CLI still works

The `casterly` CLI command becomes a thin client that:

1. Checks if the app is running (via `~/.casterly/casterly.sock`).
2. If yes, forwards the request over IPC — permissions are handled by the app.
3. If no, falls back to direct execution (same as today, permissions tied to terminal).

This preserves the CLI workflow for power users while giving the app wrapper path for permission management.

---

## Migration Path

### Phase 1: Launcher prototype

- Create a minimal Swift launcher that embeds Node.js and runs `dist/index.js`.
- Bundle into a `.app` with correct `Info.plist`.
- Test that macOS permission prompts reference "Casterly" instead of Terminal.
- No Sparkle yet — just validate the permission model.

### Phase 2: Menu bar + lifecycle

- Add menu bar status icon (SF Symbols, no Electron).
- Implement login item registration.
- Add crash recovery (restart Node.js on unexpected exit).
- IPC socket for CLI-to-app communication.

### Phase 3: Distribution + updates

- Code signing with Developer ID.
- Notarization via `notarytool`.
- Sparkle integration for auto-updates.
- DMG packaging with `create-dmg` or similar.
- Retire `scripts/self-update.sh` for app-based installs (keep it for dev/source installs).

### Phase 4: Full Disk Access alternative

- Instead of requiring Full Disk Access for `chat.db`, investigate using the Messages framework or a privileged helper tool to read iMessage data with narrower permissions.
- This is the hardest part — Apple doesn't expose a public API for reading iMessage history. Full Disk Access may remain necessary.

---

## What This Does NOT Change

- **Ollama** — Stays as a separate process. No reason to bundle it; it has its own app, permissions, and update cycle.
- **Privacy architecture** — The local-first routing, sensitive data detection, and redaction logic are unchanged.
- **Provider interface** — `src/providers/base.ts` stays the same. The app wrapper is a deployment concern, not an architecture change.
- **Source installs** — Developers can still `git clone && npm install && npm run dev`. The app wrapper is a distribution option, not a replacement.
- **Config format** — `config/default.yaml` and `~/.casterly/` structure unchanged.

---

## Open Questions

1. **Bundled Node.js vs. system Node.js?** Bundling adds ~40-70MB but eliminates "install Node first" as a prerequisite for non-developer users. Recommendation: bundle it.
2. **Swift vs. Objective-C for the launcher?** Swift is the pragmatic choice for new macOS code. The launcher is small (~200-400 lines).
3. **Homebrew cask as alternative distribution?** Could offer `brew install --cask casterly` alongside the DMG. Worth pursuing after the DMG works.
4. **Should the CLI be a universal binary?** If we're bundling Node.js, we should include both arm64 and x86_64 Node binaries for full compatibility.
5. **TCC (Transparency, Consent, and Control) pre-prompting?** We can't programmatically grant permissions, but we can detect missing permissions at startup and show guidance before the user hits a confusing error.

---

## Summary

The core issue is that macOS ties permissions to the _application bundle_, and right now Casterly doesn't have one. Wrapping the Node.js runtime + Casterly code into a signed `.app` bundle solves:

- Permission prompts that make sense to users
- Per-app permission revocation
- Native update UX via Sparkle
- Login-item and menu-bar presence
- Process visibility in Activity Monitor

Ollama is correctly excluded — it's already a proper macOS app with its own identity.
