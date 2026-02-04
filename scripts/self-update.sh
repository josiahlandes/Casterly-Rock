#!/bin/bash
# self-update.sh - Update Tyrion/Casterly to the latest version
#
# Usage: self-update.sh [options]
#   --check     Check for updates without applying
#   --force     Force update even if no changes
#   --restart   Restart service after update
#   --branch    Branch to update from (default: main)

set -e

# ═══════════════════════════════════════════════════════════════════════════════
# Configuration
# ═══════════════════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="${HOME}/.casterly/logs/update.log"
PID_FILE="${HOME}/.casterly/tyrion.pid"
SERVICE_NAME="casterly"

# Default options
CHECK_ONLY=false
FORCE_UPDATE=false
RESTART_SERVICE=false
BRANCH="main"

# ═══════════════════════════════════════════════════════════════════════════════
# Parse arguments
# ═══════════════════════════════════════════════════════════════════════════════

while [[ $# -gt 0 ]]; do
    case $1 in
        --check)
            CHECK_ONLY=true
            shift
            ;;
        --force)
            FORCE_UPDATE=true
            shift
            ;;
        --restart)
            RESTART_SERVICE=true
            shift
            ;;
        --branch)
            BRANCH="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# ═══════════════════════════════════════════════════════════════════════════════
# Helper functions
# ═══════════════════════════════════════════════════════════════════════════════

log() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
    echo "$msg"
    mkdir -p "$(dirname "$LOG_FILE")"
    echo "$msg" >> "$LOG_FILE"
}

error() {
    log "ERROR: $1"
    exit 1
}

get_current_version() {
    cd "$REPO_DIR"
    git rev-parse --short HEAD 2>/dev/null || echo "unknown"
}

get_remote_version() {
    cd "$REPO_DIR"
    git fetch origin "$BRANCH" --quiet 2>/dev/null
    git rev-parse --short "origin/$BRANCH" 2>/dev/null || echo "unknown"
}

has_local_changes() {
    cd "$REPO_DIR"
    ! git diff --quiet HEAD 2>/dev/null
}

# ═══════════════════════════════════════════════════════════════════════════════
# Check for updates
# ═══════════════════════════════════════════════════════════════════════════════

check_updates() {
    log "Checking for updates..."

    cd "$REPO_DIR"

    CURRENT=$(get_current_version)
    REMOTE=$(get_remote_version)

    echo "═══════════════════════════════════════════════════════════"
    echo "UPDATE CHECK"
    echo "═══════════════════════════════════════════════════════════"
    echo "Current version: $CURRENT"
    echo "Remote version:  $REMOTE"
    echo "Branch:          $BRANCH"

    if [[ "$CURRENT" == "$REMOTE" ]]; then
        echo "Status:          Up to date ✓"
        echo "═══════════════════════════════════════════════════════════"
        return 1  # No updates
    else
        # Get commit messages between versions
        echo "Status:          Updates available"
        echo ""
        echo "New commits:"
        git log --oneline "$CURRENT..$REMOTE" 2>/dev/null | head -10
        echo "═══════════════════════════════════════════════════════════"
        return 0  # Updates available
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# Perform update
# ═══════════════════════════════════════════════════════════════════════════════

perform_update() {
    log "Starting update..."

    cd "$REPO_DIR"

    # Check for local changes
    if has_local_changes; then
        log "Warning: Local changes detected"
        echo "You have uncommitted changes. Stashing them..."
        git stash push -m "Auto-stash before update $(date '+%Y-%m-%d %H:%M:%S')"
    fi

    # Pull latest changes
    log "Pulling latest changes from $BRANCH..."
    git pull origin "$BRANCH" --ff-only || {
        log "Fast-forward pull failed, trying rebase..."
        git pull origin "$BRANCH" --rebase || error "Failed to pull updates"
    }

    NEW_VERSION=$(get_current_version)
    log "Updated to version: $NEW_VERSION"

    # Install dependencies if package.json changed
    if git diff HEAD~1 --name-only | grep -q "package.json"; then
        log "package.json changed, installing dependencies..."
        npm install --production || log "Warning: npm install had issues"
    fi

    # Build if needed
    if [[ -f "package.json" ]] && grep -q '"build"' package.json; then
        log "Building..."
        npm run build || log "Warning: build had issues"
    fi

    echo ""
    echo "✓ Update complete! Now at version: $NEW_VERSION"

    return 0
}

# ═══════════════════════════════════════════════════════════════════════════════
# Restart service
# ═══════════════════════════════════════════════════════════════════════════════

restart_service() {
    log "Restarting service..."

    # Find the running process
    local pid=""

    # Try PID file first
    if [[ -f "$PID_FILE" ]]; then
        pid=$(cat "$PID_FILE" 2>/dev/null)
        if ! kill -0 "$pid" 2>/dev/null; then
            pid=""
        fi
    fi

    # Try finding by process name
    if [[ -z "$pid" ]]; then
        pid=$(pgrep -f "imessage-daemon" | head -1)
    fi

    if [[ -z "$pid" ]]; then
        pid=$(pgrep -f "casterly" | grep -v "self-update" | head -1)
    fi

    if [[ -n "$pid" ]]; then
        log "Found running process: $pid"

        # Create restart script that runs after we exit
        local restart_script="/tmp/casterly-restart-$$.sh"
        cat > "$restart_script" << 'RESTART_EOF'
#!/bin/bash
sleep 2
cd "$1"
if [[ -f "package.json" ]]; then
    npm run imessage 2>&1 | tee -a "$HOME/.casterly/logs/tyrion.log" &
    echo $! > "$HOME/.casterly/tyrion.pid"
fi
rm -f "$0"
RESTART_EOF
        chmod +x "$restart_script"

        # Run restart script in background (detached)
        nohup "$restart_script" "$REPO_DIR" > /dev/null 2>&1 &

        # Send graceful shutdown signal
        log "Sending shutdown signal to process $pid..."
        kill -TERM "$pid" 2>/dev/null || true

        echo "✓ Restart initiated. New process will start in ~2 seconds."
    else
        log "No running process found to restart"

        # Just start the service
        cd "$REPO_DIR"
        if [[ -f "package.json" ]]; then
            log "Starting service..."
            npm run imessage 2>&1 | tee -a "$HOME/.casterly/logs/tyrion.log" &
            echo $! > "$PID_FILE"
            echo "✓ Service started with PID: $!"
        fi
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════════════

main() {
    log "Self-update script started"

    # Ensure we're in a git repo
    if [[ ! -d "$REPO_DIR/.git" ]]; then
        error "Not a git repository: $REPO_DIR"
    fi

    # Check for updates
    if check_updates; then
        UPDATES_AVAILABLE=true
    else
        UPDATES_AVAILABLE=false
    fi

    # If check only, exit here
    if [[ "$CHECK_ONLY" == "true" ]]; then
        if [[ "$UPDATES_AVAILABLE" == "true" ]]; then
            exit 0
        else
            exit 1
        fi
    fi

    # Perform update if available (or forced)
    if [[ "$UPDATES_AVAILABLE" == "true" ]] || [[ "$FORCE_UPDATE" == "true" ]]; then
        perform_update

        # Restart if requested
        if [[ "$RESTART_SERVICE" == "true" ]]; then
            restart_service
        else
            echo ""
            echo "Run with --restart to restart the service, or manually restart."
        fi
    else
        echo "No updates available. Use --force to update anyway."
    fi

    log "Self-update script completed"
}

main
