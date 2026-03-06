#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# tyrion.sh — Tyrion Lifecycle Manager
#
# Unified CLI for starting, stopping, updating, and resetting the Tyrion
# iMessage daemon (dual-loop controller).
#
# Usage:
#   ./scripts/tyrion.sh <command>
#
# Commands:
#   start          Build and start the iMessage daemon (background)
#   stop           Gracefully stop the running daemon
#   restart        Stop + start
#   update         Pull from main, install deps if needed, build, restart
#   reset          Stop, clear all data except contacts, start fresh
#   status         Show whether the daemon is running, PID, uptime
#   logs           Tail the daemon log
#   help           Show this help message
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DATA_DIR="${HOME}/.casterly"
PID_FILE="${DATA_DIR}/tyrion.pid"
LOG_DIR="${DATA_DIR}/logs"
LOG_FILE="${LOG_DIR}/tyrion.log"
UPDATE_LOG="${LOG_DIR}/update.log"
BRANCH="main"

# ─── Colors ───────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

# ─── Helpers ──────────────────────────────────────────────────────────────────

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
  echo -e "$msg"
  mkdir -p "$LOG_DIR"
  echo "$msg" >> "$UPDATE_LOG"
}

die() {
  echo -e "${RED}Error: $1${NC}" >&2
  exit 1
}

ensure_dirs() {
  mkdir -p "$LOG_DIR"
}

# Return the PID if the daemon is running, empty string otherwise.
running_pid() {
  # Check PID file first
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null)
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return
    fi
    # Stale PID file
    rm -f "$PID_FILE"
  fi

  # Fallback: search for imessage-daemon process
  local pid
  pid=$(pgrep -f "imessage-daemon" 2>/dev/null | head -1) || true
  if [[ -n "$pid" ]]; then
    echo "$pid"
  fi
}

# ─── Commands ─────────────────────────────────────────────────────────────────

cmd_start() {
  ensure_dirs
  local pid
  pid=$(running_pid)

  if [[ -n "$pid" ]]; then
    echo -e "${YELLOW}Tyrion is already running (PID: $pid)${NC}"
    exit 1
  fi

  echo -e "${BLUE}Building...${NC}"
  cd "$PROJECT_ROOT"
  npm run build --silent || die "Build failed"

  echo -e "${BLUE}Starting Tyrion iMessage daemon...${NC}"
  nohup node dist/src/imessage-daemon.js >> "$LOG_FILE" 2>&1 &
  local new_pid=$!
  echo "$new_pid" > "$PID_FILE"

  # Give it a moment to crash or succeed
  sleep 2

  if kill -0 "$new_pid" 2>/dev/null; then
    echo -e "${GREEN}Tyrion started (PID: $new_pid)${NC}"
    echo -e "Logs: $LOG_FILE"
  else
    echo -e "${RED}Tyrion failed to start. Check logs:${NC}"
    tail -20 "$LOG_FILE" 2>/dev/null || echo "No logs available"
    rm -f "$PID_FILE"
    exit 1
  fi
}

cmd_stop() {
  local pid
  pid=$(running_pid)

  if [[ -z "$pid" ]]; then
    echo -e "${YELLOW}Tyrion is not running${NC}"
    return 0
  fi

  echo -e "${BLUE}Stopping Tyrion (PID: $pid)...${NC}"
  kill -TERM "$pid" 2>/dev/null || true

  # Wait for graceful shutdown (up to 30s, matching daemon's internal timeout)
  local waited=0
  while kill -0 "$pid" 2>/dev/null && (( waited < 30 )); do
    sleep 1
    (( waited++ ))
  done

  if kill -0 "$pid" 2>/dev/null; then
    echo -e "${YELLOW}Graceful shutdown timed out, force killing...${NC}"
    kill -9 "$pid" 2>/dev/null || true
  fi

  rm -f "$PID_FILE"
  echo -e "${GREEN}Tyrion stopped${NC}"
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

cmd_update() {
  log "Update started"
  cd "$PROJECT_ROOT"

  # Ensure we're in a git repo
  [[ -d .git ]] || die "Not a git repository: $PROJECT_ROOT"

  # Check for local changes
  if ! git diff --quiet HEAD 2>/dev/null; then
    log "Stashing local changes..."
    git stash push -m "Auto-stash before update $(date '+%Y-%m-%d %H:%M:%S')"
  fi

  # Fetch and check for updates
  local current remote
  current=$(git rev-parse --short HEAD)

  echo -e "${BLUE}Fetching from origin/${BRANCH}...${NC}"
  git fetch origin "$BRANCH" --quiet 2>/dev/null || die "Failed to fetch from origin"

  remote=$(git rev-parse --short "origin/$BRANCH" 2>/dev/null)

  if [[ "$current" == "$remote" ]]; then
    echo -e "${GREEN}Already up to date ($current)${NC}"
    log "No updates available"
    return 0
  fi

  echo -e "${BLUE}Updating: $current -> $remote${NC}"
  git log --oneline "$current..$remote" 2>/dev/null | head -10

  # Pull
  git pull origin "$BRANCH" --ff-only || {
    log "Fast-forward failed, trying rebase..."
    git pull origin "$BRANCH" --rebase || die "Failed to pull updates"
  }

  log "Updated to $(git rev-parse --short HEAD)"

  # Reinstall deps if package.json changed
  if git diff HEAD~1 --name-only 2>/dev/null | grep -q "package.json"; then
    echo -e "${BLUE}package.json changed, installing dependencies...${NC}"
    npm install || log "Warning: npm install had issues"
  fi

  # Restart the daemon with the new code
  echo -e "${BLUE}Restarting with updated code...${NC}"
  cmd_restart

  log "Update complete"
  echo -e "${GREEN}Update complete!${NC}"
}

cmd_reset() {
  echo -e "${YELLOW}${BOLD}This will delete all Tyrion data except contacts.${NC}"
  echo -e "${YELLOW}Memory, goals, issues, tasks, journal, reflections — all gone.${NC}"
  echo ""

  # If stdin is a terminal, ask for confirmation
  if [[ -t 0 ]]; then
    read -rp "Are you sure? (y/N) " confirm
    if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
      echo "Aborted."
      exit 0
    fi
  fi

  # Stop the daemon first
  cmd_stop

  echo -e "${BLUE}Preserving contacts...${NC}"
  local contacts_backup=""
  if [[ -f "$DATA_DIR/contacts.json" ]]; then
    contacts_backup=$(mktemp)
    cp "$DATA_DIR/contacts.json" "$contacts_backup"
  fi

  echo -e "${BLUE}Clearing data...${NC}"
  if [[ -d "$DATA_DIR" ]]; then
    rm -rf "$DATA_DIR"
  fi

  # Restore contacts
  mkdir -p "$DATA_DIR"
  if [[ -n "$contacts_backup" && -f "$contacts_backup" ]]; then
    cp "$contacts_backup" "$DATA_DIR/contacts.json"
    rm -f "$contacts_backup"
    echo -e "${GREEN}Contacts restored${NC}"
  fi

  echo -e "${GREEN}Data cleared. Starting fresh...${NC}"
  cmd_start
}

cmd_status() {
  local pid
  pid=$(running_pid)

  if [[ -z "$pid" ]]; then
    echo -e "${YELLOW}Tyrion is not running${NC}"
    return 0
  fi

  echo -e "${GREEN}Tyrion is running (PID: $pid)${NC}"

  # Show uptime (macOS and Linux compatible)
  local started
  if [[ "$(uname)" == "Darwin" ]]; then
    started=$(ps -p "$pid" -o lstart= 2>/dev/null) || true
  else
    started=$(ps -p "$pid" -o lstart= 2>/dev/null) || true
  fi
  if [[ -n "$started" ]]; then
    echo -e "  Started: $started"
  fi

  # Show memory usage
  local rss
  rss=$(ps -p "$pid" -o rss= 2>/dev/null) || true
  if [[ -n "$rss" ]]; then
    local mb=$(( rss / 1024 ))
    echo -e "  Memory:  ${mb} MB"
  fi

  # Git version
  cd "$PROJECT_ROOT"
  local version
  version=$(git rev-parse --short HEAD 2>/dev/null) || version="unknown"
  echo -e "  Version: $version"

  # Log file info
  if [[ -f "$LOG_FILE" ]]; then
    local log_size
    log_size=$(du -h "$LOG_FILE" 2>/dev/null | cut -f1)
    echo -e "  Log:     $LOG_FILE ($log_size)"
  fi
}

cmd_logs() {
  if [[ -f "$LOG_FILE" ]]; then
    tail -f "$LOG_FILE"
  else
    echo -e "${YELLOW}No log file found at $LOG_FILE${NC}"
    exit 1
  fi
}

cmd_help() {
  cat <<'EOF'
Tyrion Lifecycle Manager

Usage: tyrion.sh <command>

Commands:
  start       Build and start the iMessage daemon in the background.
              Runs the dual-loop controller (FastLoop + DeepLoop).

  stop        Gracefully stop the running daemon (SIGTERM + wait).

  restart     Stop, then start.

  update      Pull latest code from main, install deps if changed,
              build, and restart. Designed for remote code pushes —
              text Tyrion "update" and the daemon self-updates.

  reset       Stop the daemon and delete ALL data in ~/.casterly
              except contacts.json. Then start fresh. Use this to
              clear memory, goals, issues, tasks, reflections, etc.

  status      Show whether the daemon is running, its PID, uptime,
              memory usage, and current git version.

  logs        Tail the daemon log file (~/.casterly/logs/tyrion.log).

  help        Show this help message.

Files:
  PID file    ~/.casterly/tyrion.pid
  Log file    ~/.casterly/logs/tyrion.log
  Update log  ~/.casterly/logs/update.log
  Data dir    ~/.casterly/

EOF
}

# ─── Main ─────────────────────────────────────────────────────────────────────

case "${1:-}" in
  start)    cmd_start ;;
  stop)     cmd_stop ;;
  restart)  cmd_restart ;;
  update)   cmd_update ;;
  reset)    cmd_reset ;;
  status)   cmd_status ;;
  logs)     cmd_logs ;;
  help|-h|--help) cmd_help ;;
  *)
    cmd_help
    exit 1
    ;;
esac
