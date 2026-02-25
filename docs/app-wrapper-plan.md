# Casterly.app — Implementation Plan

> Prerequisite reading: [Mac Permissions Review](./mac-permissions-review.md)

This document breaks the app wrapper into concrete, sequenced work items with clear deliverables. Each phase is independently shippable — earlier phases provide value even if later phases slip.

---

## Table of Contents

1. [Phase 1: Native Launcher Shell](#phase-1-native-launcher-shell)
2. [Phase 2: Permission Health Check](#phase-2-permission-health-check)
3. [Phase 3: Menu Bar + Lifecycle](#phase-3-menu-bar--lifecycle)
4. [Phase 4: IPC Bridge (CLI ↔ App)](#phase-4-ipc-bridge-cli--app)
5. [Phase 5: Build Pipeline + Signing](#phase-5-build-pipeline--signing)
6. [Phase 6: Sparkle Auto-Update](#phase-6-sparkle-auto-update)
7. [Phase 7: DMG Packaging + Distribution](#phase-7-dmg-packaging--distribution)
8. [Installation Procedure](#installation-procedure)
9. [Update Procedure (Tyrion Self-Update)](#update-procedure-tyrion-self-update)
10. [Documentation Plan](#documentation-plan)
11. [File Map](#file-map)

---

## Phase 1: Native Launcher Shell

**Goal:** Prove that macOS attributes permissions to Casterly.app instead of Terminal.

### Tasks

| # | Task | Output |
|---|------|--------|
| 1.1 | Create `macos/` directory at repo root for all native code | `macos/` |
| 1.2 | Write Swift `Package.swift` for the launcher (SPM, no Xcode project) | `macos/Package.swift` |
| 1.3 | Implement `CasterlyLauncher/main.swift` — spawn bundled Node.js, forward stdio, handle SIGTERM | `macos/Sources/CasterlyLauncher/main.swift` |
| 1.4 | Create `Info.plist` template with bundle ID `com.casterly.app`, version from `package.json`, and usage descriptions | `macos/Info.plist` |
| 1.5 | Create `Entitlements.plist` with hardened runtime + Apple Events exceptions | `macos/Entitlements.plist` |
| 1.6 | Write `scripts/build-app.sh` — compiles Swift, assembles `.app` bundle structure, copies `dist/`, `config/`, `skills/`, downloads Node.js binary | `scripts/build-app.sh` |
| 1.7 | Add `npm run build:app` script to `package.json` | `package.json` change |
| 1.8 | Manual test: launch `Casterly.app`, trigger an osascript skill, verify macOS permission dialog says "Casterly" not "Terminal" | Pass/fail |

### Key design decisions

- **Swift Package Manager, not Xcode project.** Keeps the build reproducible from CLI. No `.xcodeproj` in the repo.
- **Node.js binary downloaded at build time**, not checked into git. `scripts/build-app.sh` fetches the correct arch (arm64/x86_64) from nodejs.org.
- **No UI yet.** The launcher is headless in Phase 1 — it's purely a process wrapper to test the permission model.

### Launcher pseudocode

```swift
// main.swift — Phase 1 (minimal)
import Foundation

let bundle = Bundle.main
let nodePath = bundle.path(forResource: "node", ofType: nil, inDirectory: "Resources")!
let appEntry = bundle.path(forResource: "app/src/imessage-daemon", ofType: "js", inDirectory: "Resources")!

let process = Process()
process.executableURL = URL(fileURLWithPath: nodePath)
process.arguments = [appEntry]
process.environment = ProcessInfo.processInfo.environment
// Merge in CASTERLY_HOME, NODE_ENV, etc.
process.environment?["CASTERLY_APP_BUNDLE"] = "1"

// Forward signals
signal(SIGTERM, SIG_IGN)
let src = DispatchSource.makeSignalSource(signal: SIGTERM)
src.setEventHandler { process.terminate() }
src.resume()

try process.run()
process.waitUntilExit()
exit(process.terminationStatus)
```

### Definition of done

- `Casterly.app` launches, starts the iMessage daemon inside the bundle.
- `osascript` calls from within the bundle trigger permission prompts attributed to "Casterly".
- No Electron, no Xcode project, no nib/storyboard files.

---

## Phase 2: Permission Health Check

**Goal:** Detect missing permissions at startup and guide the user, instead of failing silently.

### Tasks

| # | Task | Output |
|---|------|--------|
| 2.1 | Create `src/platform/permissions.ts` — platform-agnostic interface for permission checks | New file |
| 2.2 | Implement `src/platform/darwin-permissions.ts` — macOS-specific checks using `tccutil`, `sqlite3 ~/Library/Application Support/com.apple.TCC/TCC.db` (read-only), and fallback probes | New file |
| 2.3 | Implement Full Disk Access check — attempt to `stat()` `~/Library/Messages/chat.db`, catch EPERM | In `darwin-permissions.ts` |
| 2.4 | Implement Automation check — run a no-op `osascript` against Messages/Calendar, catch error 1743 (not authorized) | In `darwin-permissions.ts` |
| 2.5 | Add `--check-permissions` CLI flag to `src/index.ts` and `src/imessage-daemon.ts` | Modified files |
| 2.6 | On startup (when `CASTERLY_APP_BUNDLE=1`), run permission checks and log guidance for any missing permission | Modified daemon startup |
| 2.7 | Write tests for permission check logic (mock `execSync` responses) | `tests/permissions.test.ts` |

### Permission detection strategies

```
Full Disk Access:
  Try: fs.accessSync('~/Library/Messages/chat.db', fs.constants.R_OK)
  Fail: EPERM → "Grant Full Disk Access to Casterly in System Settings > Privacy & Security"

Automation (Messages):
  Try: execSync('osascript -e "tell application \\"Messages\\" to count of services"')
  Fail: error -1743 → "Grant Automation access for Casterly → Messages"

Automation (Calendar):
  Try: execSync('osascript -e "tell application \\"Calendar\\" to count of calendars"')
  Fail: error -1743 → "Grant Automation access for Casterly → Calendar"

Screen Recording:
  Try: execSync('screencapture -x /tmp/.casterly-screen-test.png') + check file exists
  Fail: 0-byte file → "Grant Screen Recording access to Casterly"
```

### Definition of done

- `casterly --check-permissions` prints a clear table of permission status.
- On daemon startup, missing permissions produce actionable log messages.
- No changes to `src/security/*` or `src/router/*` (not a protected-path concern).

---

## Phase 3: Menu Bar + Lifecycle

**Goal:** Casterly runs as a proper macOS menu bar app with crash recovery and login-item support.

### Tasks

| # | Task | Output |
|---|------|--------|
| 3.1 | Add AppKit import to launcher, create `NSApplication` with `NSStatusItem` | Modified `main.swift` |
| 3.2 | Menu bar icon using SF Symbol `brain.head.profile` (macOS 13+), fallback to bundled PNG | `macos/Resources/StatusIcon.png` |
| 3.3 | Status menu items: "Status: Running", separator, "Open Logs…", "Check for Updates…", "Quit Casterly" | In `main.swift` or `AppDelegate.swift` |
| 3.4 | Implement Node.js crash recovery — if child process exits unexpectedly, restart after 2s, max 5 retries in 60s | Launcher logic |
| 3.5 | Login item registration via `SMAppService.mainApp.register()` (macOS 13+) | Launcher logic |
| 3.6 | Add "Start at Login" toggle in status menu, persisted in `UserDefaults` | Menu item |
| 3.7 | Write `~/.casterly/casterly.pid` from the launcher (PID of the Node.js child), for compatibility with existing `self-update.sh` | Launcher logic |
| 3.8 | Graceful shutdown: menu "Quit" sends SIGTERM to Node child, waits 5s, then SIGKILL | Launcher logic |

### Architecture note

The Swift launcher stays thin. It does NOT:
- Render any window (headless, menu-bar-only).
- Contain any business logic — all LLM routing, security, tools stay in TypeScript.
- Talk to Ollama — that's Node.js's job.

### Definition of done

- Casterly shows a brain icon in the macOS menu bar.
- Killing the Node.js process causes the launcher to restart it.
- "Quit Casterly" cleanly stops both the launcher and Node.js.
- "Start at Login" survives a reboot.

---

## Phase 4: IPC Bridge (CLI ↔ App)

**Goal:** The `casterly` CLI command talks to the running app instead of spawning a second Node.js process.

### Tasks

| # | Task | Output |
|---|------|--------|
| 4.1 | Create `src/ipc/server.ts` — Unix domain socket server at `~/.casterly/casterly.sock` | New file |
| 4.2 | Define IPC protocol: JSON-RPC 2.0 over newline-delimited JSON | Protocol spec in code comments |
| 4.3 | Implement `query` method — accepts prompt string, returns structured response | Server handler |
| 4.4 | Implement `status` method — returns running state, uptime, active sessions, permission status | Server handler |
| 4.5 | Implement `update` method — triggers Sparkle check (Phase 6) or git-pull fallback | Server handler |
| 4.6 | Create `src/ipc/client.ts` — connects to socket, sends request, streams response | New file |
| 4.7 | Modify `src/index.ts` (CLI entry) to try IPC first, fall back to direct execution | Modified file |
| 4.8 | Start IPC server in `src/imessage-daemon.ts` (or a new unified `src/app.ts` entry) alongside the daemon | Modified file |
| 4.9 | Write tests for IPC protocol (mock socket) | `tests/ipc.test.ts` |

### IPC protocol sketch

```jsonc
// Request (CLI → App)
{"jsonrpc": "2.0", "id": 1, "method": "query", "params": {"prompt": "What's on my calendar?"}}

// Response (App → CLI)
{"jsonrpc": "2.0", "id": 1, "result": {"text": "You have 3 events today...", "route": "local"}}

// Status
{"jsonrpc": "2.0", "id": 2, "method": "status"}
{"jsonrpc": "2.0", "id": 2, "result": {"uptime": 3600, "sessions": 2, "permissions": {"fullDiskAccess": true, "automationMessages": true}}}
```

### Definition of done

- `casterly "What time is it?"` from Terminal connects to the running app via socket.
- If the app isn't running, CLI falls back to direct execution (no regression).
- Permissions used during CLI queries are attributed to Casterly.app (because execution happens in the app's Node.js process).

---

## Phase 5: Build Pipeline + Signing

**Goal:** Reproducible, signed, notarized builds that pass Gatekeeper.

### Tasks

| # | Task | Output |
|---|------|--------|
| 5.1 | Extend `scripts/build-app.sh` to download Node.js for the target arch (arm64 default, x86_64 via flag) | Modified script |
| 5.2 | Add `--universal` flag to build a universal binary (both archs, lipo merge) | Modified script |
| 5.3 | Add `codesign` step with `--deep --options runtime` using Developer ID certificate | Modified script |
| 5.4 | Add `notarytool submit` step with `--wait` for Apple notarization | Modified script |
| 5.5 | Add `stapler staple` to attach notarization ticket to the app | Modified script |
| 5.6 | Create `scripts/build-app-ci.sh` for CI use (reads signing identity from env vars) | New script |
| 5.7 | Add version stamping — read version from `package.json`, write into `Info.plist` at build time | Build script logic |
| 5.8 | Add `npm run build:app:release` script | `package.json` change |

### Prerequisites (outside this repo)

- Apple Developer account ($99/yr).
- Developer ID Application certificate in Keychain.
- App-specific password for `notarytool`.
- These are one-time setup, not per-build.

### Definition of done

- `npm run build:app:release` produces a signed, notarized `Casterly.app`.
- Double-clicking the app on a fresh Mac shows no Gatekeeper warning.
- `codesign --verify --deep --strict Casterly.app` passes.
- `spctl --assess --type exec Casterly.app` passes.

---

## Phase 6: Sparkle Auto-Update

**Goal:** Casterly.app can update itself, and Tyrion (the LLM) can trigger updates via the self-update skill.

### Tasks

| # | Task | Output |
|---|------|--------|
| 6.1 | Add Sparkle 2.x as an SPM dependency in `Package.swift` | Modified `Package.swift` |
| 6.2 | Generate EdDSA key pair for update signing (`generate_keys` tool from Sparkle) | Key stored securely, public key in `Info.plist` |
| 6.3 | Add `SUFeedURL` to `Info.plist` pointing to appcast URL | Modified `Info.plist` |
| 6.4 | Initialize `SPUStandardUpdaterController` in the launcher's `AppDelegate` | Modified Swift code |
| 6.5 | Wire "Check for Updates…" menu item to Sparkle's `checkForUpdates:` | Modified Swift code |
| 6.6 | Configure automatic background checks (every 4 hours) | `Info.plist` + `UserDefaults` |
| 6.7 | Create `scripts/generate-appcast.sh` — builds appcast XML from a release directory | New script |
| 6.8 | Adapt `skills/self-update/SKILL.md` — add app-bundle-aware update path | Modified skill (protected path) |
| 6.9 | Implement update IPC method — CLI/LLM sends `{"method": "update"}`, launcher checks Sparkle | IPC handler |
| 6.10 | Write `scripts/publish-release.sh` — builds app, signs, notarizes, generates appcast, uploads to hosting | New script |

### How Tyrion triggers an update

Today Tyrion uses the `self-update` skill which calls `scripts/self-update.sh` (git pull + npm rebuild). With the app wrapper:

```
┌──────────────────────────────────────────────────────────────┐
│ User: "Update yourself"                                      │
│                                                              │
│ Tyrion recognizes self-update skill → calls update_tyrion()  │
│                                                              │
│ ┌─ If running inside Casterly.app (CASTERLY_APP_BUNDLE=1) ──┤
│ │                                                            │
│ │  1. Node.js sends IPC message to Swift launcher:           │
│ │     {"method": "sparkle_check_for_updates"}                │
│ │                                                            │
│ │  2. Swift launcher invokes Sparkle:                        │
│ │     updaterController.checkForUpdates(nil)                 │
│ │                                                            │
│ │  3. Sparkle downloads update, prompts user via native UI,  │
│ │     replaces app bundle, relaunches.                       │
│ │                                                            │
│ │  4. Node.js reports to user:                               │
│ │     "Update found. Sparkle is showing the update dialog."  │
│ │                                                            │
│ ├─ If running as source install (git clone) ─────────────────┤
│ │                                                            │
│ │  Falls back to existing self-update.sh (git pull + build)  │
│ │  No behavior change from today.                            │
│ │                                                            │
│ └────────────────────────────────────────────────────────────┘
```

### Appcast feed example

Hosted at a static URL (GitHub Releases, S3, or similar):

```xml
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Casterly Updates</title>
    <item>
      <title>Version 1.1.0</title>
      <sparkle:version>1.1.0</sparkle:version>
      <sparkle:shortVersionString>1.1.0</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
      <pubDate>Mon, 10 Feb 2026 12:00:00 +0000</pubDate>
      <enclosure
        url="https://releases.casterly.dev/Casterly-1.1.0.zip"
        length="45000000"
        type="application/octet-stream"
        sparkle:edSignature="BASE64_EDDSA_SIGNATURE" />
      <sparkle:releaseNotesLink>
        https://releases.casterly.dev/notes/1.1.0.html
      </sparkle:releaseNotesLink>
    </item>
  </channel>
</rss>
```

### Definition of done

- "Check for Updates" in the menu bar triggers Sparkle.
- Tyrion's `update_tyrion()` skill triggers Sparkle when inside the app bundle.
- Source-install users still get `self-update.sh` — no regression.
- Appcast is generated automatically as part of the release script.

---

## Phase 7: DMG Packaging + Distribution

**Goal:** A polished installer that non-developers can use.

### Tasks

| # | Task | Output |
|---|------|--------|
| 7.1 | Create DMG background image (drag Casterly.app → Applications arrow) | `macos/Resources/dmg-background.png` |
| 7.2 | Write `scripts/create-dmg.sh` using `create-dmg` or `hdiutil` | New script |
| 7.3 | DMG includes: Casterly.app, symlink to /Applications, README.txt with first-launch instructions | DMG contents |
| 7.4 | Add `npm run package` script chaining: `build → build:app:release → create-dmg` | `package.json` change |
| 7.5 | First-launch onboarding: detect `~/.casterly/` doesn't exist, create default workspace, show instructions for Ollama setup | App logic |
| 7.6 | CLI install during first launch: create `/usr/local/bin/casterly` symlink pointing to `Casterly.app/Contents/MacOS/casterly-cli` | First-launch logic |
| 7.7 | Add Homebrew Cask formula draft | `macos/casterly.rb` |

### Definition of done

- Download DMG, drag to Applications, double-click — Casterly starts.
- No `git`, `npm`, or `node` required on user's machine.
- `casterly` command works from Terminal after first launch.
- Gatekeeper shows "Casterly is an application downloaded from the Internet" (not an unsigned warning).

---

## Installation Procedure

### For end users (app bundle)

```
1. PREREQUISITES
   - macOS 13.0 (Ventura) or later
   - Ollama installed and running (https://ollama.ai)
   - A model pulled: ollama pull qwen3.5:122b (or your preferred model)

2. INSTALL
   a. Download Casterly-X.Y.Z.dmg from releases page
   b. Open the DMG
   c. Drag Casterly.app to /Applications
   d. Eject the DMG

3. FIRST LAUNCH
   a. Open Casterly from Applications (or Spotlight)
   b. macOS may show "Casterly is from an identified developer" → click Open
   c. Casterly appears in the menu bar (brain icon)
   d. First-launch wizard:
      - Creates ~/.casterly/ directory structure
      - Scaffolds default IDENTITY.md, SOUL.md, USER.md
      - Checks Ollama connectivity
      - Prompts for config (model, session scope, etc.) or uses defaults
   e. The casterly CLI is installed to /usr/local/bin/casterly
      (may prompt for admin password)

4. GRANT PERMISSIONS (as needed, on first use)
   a. Full Disk Access (required for iMessage):
      System Settings > Privacy & Security > Full Disk Access > add Casterly
   b. Automation > Messages (prompted automatically on first iMessage send)
   c. Automation > Calendar (prompted automatically on first calendar query)
   d. Screen Recording (prompted if screenshot skill is used)

   Casterly will detect missing permissions and show guidance:
   $ casterly --check-permissions

5. VERIFY
   $ casterly "Hello, what can you do?"
   # Should route through the running app via IPC
```

### For developers (source install — unchanged)

```
1. git clone <repo> && cd casterly
2. npm install
3. npm run install:host
4. export PATH="$HOME/.local/bin:$PATH"
5. casterly "Hello"
```

The source install path is unchanged. The app wrapper is additive.

---

## Update Procedure (Tyrion Self-Update)

Tyrion needs to be able to update himself through both paths. The self-update skill detects which environment it's in and acts accordingly.

### Decision tree

```
update_tyrion() called
│
├─ Is CASTERLY_APP_BUNDLE=1? (running inside Casterly.app)
│  │
│  ├─ YES → Sparkle path
│  │   1. Node.js sends IPC to Swift launcher: {"method": "sparkle_check"}
│  │   2. Launcher queries Sparkle appcast feed
│  │   3. If update available:
│  │      a. Launcher tells Node.js: {"update_available": true, "version": "1.2.0"}
│  │      b. Tyrion tells user: "Version 1.2.0 is available. Updating now."
│  │      c. Launcher calls updaterController.checkForUpdates(nil)
│  │      d. Sparkle shows native update dialog (download progress, release notes)
│  │      e. Sparkle replaces app bundle and relaunches
│  │      f. On relaunch, Tyrion confirms: "Updated to 1.2.0 successfully."
│  │   4. If no update:
│  │      a. Tyrion tells user: "Already on the latest version."
│  │
│  └─ NO → Git path (existing behavior, unchanged)
│      1. Run scripts/self-update.sh --check
│      2. If updates available: run scripts/self-update.sh [--restart]
│      3. Stash local changes, git pull, npm install if needed, npm run build
│      4. Optionally restart via detached script
│
└─ Permission check:
   - Sparkle path: no special permissions needed (network only)
   - Git path: needs git, npm, and write access to repo directory
```

### Modified self-update skill

The existing `skills/self-update/SKILL.md` adds a detection step:

```
## Environment Detection

Before updating, check how Casterly is running:

1. Check if environment variable CASTERLY_APP_BUNDLE is set to "1"
2. If YES: use the Sparkle update path (IPC to launcher)
3. If NO: use the existing git-based update path (scripts/self-update.sh)

## Sparkle Update (App Bundle)

When running inside the app bundle:

\`\`\`bash
# Check for updates via IPC
echo '{"jsonrpc":"2.0","id":1,"method":"sparkle_check"}' | socat - UNIX:~/.casterly/casterly.sock
\`\`\`

Or from Node.js, use the IPC client:

\`\`\`typescript
import { ipcClient } from '../ipc/client.js';
const result = await ipcClient.call('sparkle_check');
// result: { updateAvailable: boolean, version?: string }
```

### Update flow from the user's perspective

```
User:   "Hey Tyrion, update yourself"
Tyrion: "Let me check for updates..."
        [IPC → Sparkle check → appcast fetch]
Tyrion: "Version 1.2.0 is available with bug fixes and calendar improvements.
         I'll update now — you'll see a system dialog with the download progress."
        [Sparkle native UI appears: progress bar, release notes, "Install & Relaunch"]
        [User clicks "Install & Relaunch" or it auto-installs]
        [App relaunches, Node.js restarts, iMessage daemon reconnects]
Tyrion: "I'm back! Updated to version 1.2.0 successfully."
```

### Rollback

- **Sparkle path:** Sparkle 2.x keeps the previous app bundle. If the new version crashes on launch, Sparkle can revert.
- **Git path:** `git stash pop` restores local changes. `git checkout HEAD~1` reverts if needed.

### Silent background updates

Sparkle can be configured for fully automatic updates (no user prompt):

```xml
<!-- Info.plist -->
<key>SUAutomaticallyUpdate</key>
<true/>
<key>SUScheduledCheckInterval</key>
<integer>14400</integer> <!-- 4 hours -->
```

This means Tyrion doesn't even need to be asked — Sparkle downloads and stages the update silently, then applies it on next relaunch. But the default should be **prompt-before-install** for user trust.

---

## Documentation Plan

### New documents to create

| Document | Location | Audience | Content |
|----------|----------|----------|---------|
| **User Install Guide** | `docs/install-app.md` | End users | DMG download, first launch, permissions setup, Ollama prerequisites |
| **Developer Build Guide** | `docs/build-app.md` | Contributors | Building the .app from source, signing, notarizing, creating DMGs |
| **Architecture: App Wrapper** | `docs/architecture-app-wrapper.md` | Contributors | How the Swift launcher, Node.js runtime, and IPC bridge fit together |
| **IPC Protocol Spec** | `docs/ipc-protocol.md` | Contributors | JSON-RPC methods, request/response schemas, error codes |
| **Release Playbook** | `docs/release-playbook.md` | Maintainers | Step-by-step release process: version bump, build, sign, notarize, publish appcast, upload DMG |

### Existing documents to update

| Document | Changes |
|----------|---------|
| `docs/install.md` | Add section pointing to `install-app.md` for non-developer install. Keep source-install instructions as-is. |
| `skills/self-update/SKILL.md` | Add Sparkle path detection and IPC-based update method alongside existing git path. **(Protected path — requires guardrails override.)** |
| `docs/mac-permissions-review.md` | Mark as superseded by `architecture-app-wrapper.md` once Phase 1 is complete. |
| `README.md` (if exists) | Add "Download" section with DMG link once Phase 7 ships. |

### Documentation per phase

Each phase should ship its own docs:

- **Phase 1:** `docs/build-app.md` (how to build the .app from source)
- **Phase 2:** `--check-permissions` help text, permission troubleshooting in `docs/install-app.md`
- **Phase 3:** Menu bar usage guide in `docs/install-app.md`
- **Phase 4:** `docs/ipc-protocol.md`
- **Phase 5:** Signing/notarization steps in `docs/build-app.md`
- **Phase 6:** Update configuration in `docs/install-app.md`, release process in `docs/release-playbook.md`
- **Phase 7:** Complete `docs/install-app.md`, Homebrew cask instructions

---

## File Map

New files and directories this plan introduces:

```
Casterly-Rock/
├── macos/                              # NEW — all native macOS code
│   ├── Package.swift                   # SPM manifest
│   ├── Sources/
│   │   └── CasterlyLauncher/
│   │       ├── main.swift              # Entry point
│   │       ├── AppDelegate.swift       # NSApplication delegate, menu bar
│   │       ├── NodeProcess.swift       # Node.js child process manager
│   │       ├── IPCBridge.swift         # Forward IPC between Node ↔ Sparkle
│   │       └── LoginItem.swift         # SMAppService wrapper
│   ├── Resources/
│   │   ├── StatusIcon.png              # Menu bar icon
│   │   └── dmg-background.png          # DMG background image
│   ├── Info.plist                      # App bundle metadata
│   ├── Entitlements.plist              # Hardened runtime entitlements
│   └── casterly.rb                     # Homebrew Cask formula draft
│
├── src/
│   ├── platform/                       # NEW — platform abstractions
│   │   ├── permissions.ts              # Permission check interface
│   │   └── darwin-permissions.ts       # macOS implementation
│   ├── ipc/                            # NEW — IPC bridge
│   │   ├── server.ts                   # Unix socket server (JSON-RPC)
│   │   └── client.ts                   # Unix socket client
│   └── (existing files modified:)
│       ├── index.ts                    # Try IPC before direct execution
│       └── imessage-daemon.ts          # Start IPC server alongside daemon
│
├── scripts/
│   ├── build-app.sh                    # NEW — build .app bundle
│   ├── create-dmg.sh                   # NEW — package as DMG
│   ├── generate-appcast.sh             # NEW — Sparkle appcast XML
│   ├── publish-release.sh              # NEW — full release pipeline
│   └── self-update.sh                  # EXISTING — kept for source installs
│
├── docs/
│   ├── install-app.md                  # NEW — end-user install guide
│   ├── build-app.md                    # NEW — developer build guide
│   ├── architecture-app-wrapper.md     # NEW — architecture doc
│   ├── ipc-protocol.md                 # NEW — IPC spec
│   ├── release-playbook.md             # NEW — release process
│   ├── mac-permissions-review.md       # EXISTING — initial analysis
│   └── app-wrapper-plan.md            # THIS FILE
│
├── tests/
│   ├── permissions.test.ts             # NEW
│   └── ipc.test.ts                     # NEW
│
└── skills/
    └── self-update/SKILL.md            # MODIFIED — add Sparkle path
```

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Apple changes TCC behavior in future macOS | Permissions model breaks | Test on macOS betas, keep launcher thin so fixes are small |
| Full Disk Access still required (no alternative API for iMessage DB) | Users must grant broad permission | Phase 2 permission check explains exactly why; Phase 4 alternate investigation |
| Node.js binary size (~40-70MB) inflates app | Large download | Universal binary optional; arm64-only by default for M-series Macs |
| Sparkle adds attack surface (update MITM) | Compromised updates | EdDSA signing, HTTPS-only feed, pinned public key in app |
| Developer ID certificate costs $99/yr | Ongoing cost | Required for any macOS distribution outside App Store |
| Swift launcher adds maintenance burden | Two languages in repo | Keep launcher under 500 lines; all logic stays in TypeScript |
| Self-update skill touches a protected path | Guardrails flag | Expected; use `ALLOW_PROTECTED_CHANGES=1` explicitly for that change |

---

## Phase Sequencing & Dependencies

```
Phase 1 (Launcher Shell)
  │
  ├──→ Phase 2 (Permission Checks) — independent, can parallel with Phase 1
  │
  └──→ Phase 3 (Menu Bar + Lifecycle)
        │
        └──→ Phase 4 (IPC Bridge)
              │
              ├──→ Phase 5 (Signing) — independent of Phase 4, can start after Phase 3
              │
              └──→ Phase 6 (Sparkle) — needs Phase 4 (IPC) + Phase 5 (signing)
                    │
                    └──→ Phase 7 (DMG + Distribution)
```

Phases 1 and 2 can run in parallel. Phase 5 can start as soon as Phase 3 is done. The critical path is 1 → 3 → 4 → 6 → 7.
