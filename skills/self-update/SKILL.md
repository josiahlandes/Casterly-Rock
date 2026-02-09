---
name: self-update
description: Check for updates and update Tyrion to the latest version
metadata:
  openclaw:
    emoji: "🔄"
    os: ["darwin", "linux"]
    requires:
      bins: ["git", "npm"]
tools:
  - name: check_for_updates
    description: Check if there are updates available for Tyrion without applying them
    inputSchema:
      type: object
      properties:
        branch:
          type: string
          description: Git branch to check (default: main)
      required: []

  - name: update_tyrion
    description: Update Tyrion to the latest version from the git repository
    inputSchema:
      type: object
      properties:
        branch:
          type: string
          description: Git branch to update from (default: main)
        restart:
          type: boolean
          description: Restart the service after updating (default: false)
        force:
          type: boolean
          description: Force update even if already up to date
      required: []

  - name: restart_tyrion
    description: Restart the Tyrion service without updating
    inputSchema:
      type: object
      properties:
        confirm:
          type: boolean
          description: Must be true to confirm restart
      required:
        - confirm
---

# Self-Update Skill

Update Tyrion to the latest version from the git repository.

## Commands

### Check for Updates

Check if updates are available without applying them:

```bash
./scripts/self-update.sh --check
```

Returns:
- Current version (git commit)
- Remote version
- List of new commits if updates available

### Update

Pull the latest changes and rebuild:

```bash
./scripts/self-update.sh
```

This will:
1. Stash any local changes
2. Pull latest from the configured branch
3. Install new dependencies if package.json changed
4. Rebuild the project

### Update and Restart

Update and automatically restart the service:

```bash
./scripts/self-update.sh --restart
```

The restart is handled gracefully:
1. Spawns a background process
2. Waits for the current process to exit
3. Starts the new version

### Force Update

Force a pull even if already up to date:

```bash
./scripts/self-update.sh --force
```

### Specify Branch

Update from a specific branch:

```bash
./scripts/self-update.sh --branch develop
```

## Safety Notes

1. **Local changes are preserved** - automatically stashed before update
2. **Graceful restart** - current request completes before restart
3. **Rollback** - if update fails, stashed changes can be restored with `git stash pop`

## Logs

Update logs are written to:
```
~/.casterly/logs/update.log
```

## When to Update

Update when:
- User asks to update or check for updates
- User reports a bug that might be fixed
- User asks about new features

**Always ask before restarting** - the user might be in the middle of something.

## Example Interactions

User: "Are there any updates available?"
→ Run `check_for_updates()`

User: "Update yourself"
→ Run `update_tyrion(restart=false)`, then ask if they want to restart

User: "Update and restart"
→ Run `update_tyrion(restart=true)`

User: "Something's broken, can you restart?"
→ Run `restart_tyrion(confirm=true)`
