#!/bin/bash
# Tyrion Autonomous Improvement Daemon
# Runs the self-improvement loop continuously
#
# Usage:
#   ./scripts/tyrion-daemon.sh start   - Start the daemon
#   ./scripts/tyrion-daemon.sh stop    - Stop the daemon
#   ./scripts/tyrion-daemon.sh status  - Check daemon status
#   ./scripts/tyrion-daemon.sh logs    - Tail the log file
#   ./scripts/tyrion-daemon.sh stats   - Show aggregate statistics

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LOG_DIR="${HOME}/.casterly/autonomous/logs"
PID_FILE="${HOME}/.casterly/autonomous/daemon.pid"
METRICS_FILE="${HOME}/.casterly/autonomous/metrics.jsonl"

# Create directories
mkdir -p "$LOG_DIR"
mkdir -p "$(dirname "$PID_FILE")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

usage() {
    echo "Tyrion Autonomous Improvement Daemon"
    echo ""
    echo "Usage: $0 {start|stop|restart|status|logs|stats}"
    echo ""
    echo "Commands:"
    echo "  start   - Start the daemon in the background"
    echo "  stop    - Stop the running daemon"
    echo "  restart - Stop and start the daemon"
    echo "  status  - Check if daemon is running"
    echo "  logs    - Tail the daemon log file"
    echo "  stats   - Show aggregate statistics"
    exit 1
}

log_file() {
    echo "$LOG_DIR/daemon-$(date +%Y%m%d).log"
}

start_daemon() {
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo -e "${YELLOW}Daemon already running (PID: $(cat "$PID_FILE"))${NC}"
        exit 1
    fi

    echo -e "${BLUE}Starting Tyrion autonomous improvement daemon...${NC}"

    # Check if config exists
    if [ ! -f "$PROJECT_ROOT/config/autonomous.yaml" ]; then
        echo -e "${RED}Error: config/autonomous.yaml not found${NC}"
        exit 1
    fi

    # Check if enabled in config
    if ! grep -q "enabled: true" "$PROJECT_ROOT/config/autonomous.yaml"; then
        echo -e "${YELLOW}Warning: autonomous.enabled is not true in config${NC}"
        echo -e "${YELLOW}Set 'enabled: true' in config/autonomous.yaml to start${NC}"
    fi

    # KV cache quantization: ~50% KV memory reduction with negligible quality loss.
    # See docs/roadmap.md Tier 1, Item 2.
    export OLLAMA_KV_CACHE_TYPE="${OLLAMA_KV_CACHE_TYPE:-q8_0}"

    # Start the daemon
    cd "$PROJECT_ROOT"
    nohup npx tsx src/autonomous/loop.ts \
        >> "$(log_file)" 2>&1 &

    echo $! > "$PID_FILE"

    # Wait a moment to check if it started
    sleep 2

    if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo -e "${GREEN}Daemon started successfully (PID: $(cat "$PID_FILE"))${NC}"
        echo -e "Logs: $(log_file)"
    else
        echo -e "${RED}Daemon failed to start. Check logs:${NC}"
        tail -20 "$(log_file)" 2>/dev/null || echo "No logs available"
        rm -f "$PID_FILE"
        exit 1
    fi
}

stop_daemon() {
    if [ ! -f "$PID_FILE" ]; then
        echo -e "${YELLOW}Daemon not running (no PID file)${NC}"
        return 0
    fi

    PID=$(cat "$PID_FILE")

    if kill -0 "$PID" 2>/dev/null; then
        echo -e "${BLUE}Stopping daemon (PID: $PID)...${NC}"
        kill "$PID"

        # Wait for graceful shutdown
        for i in {1..10}; do
            if ! kill -0 "$PID" 2>/dev/null; then
                break
            fi
            sleep 1
        done

        # Force kill if still running
        if kill -0 "$PID" 2>/dev/null; then
            echo -e "${YELLOW}Force killing daemon...${NC}"
            kill -9 "$PID" 2>/dev/null || true
        fi

        rm -f "$PID_FILE"
        echo -e "${GREEN}Daemon stopped${NC}"
    else
        echo -e "${YELLOW}Daemon not running (stale PID file)${NC}"
        rm -f "$PID_FILE"
    fi
}

status_daemon() {
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo -e "${GREEN}Daemon running (PID: $(cat "$PID_FILE"))${NC}"
        echo ""

        # Show recent activity
        echo -e "${BLUE}Recent activity:${NC}"
        tail -20 "$(log_file)" 2>/dev/null | grep -E "CYCLE|SUCCESS|FAILURE|ERROR" || echo "  (no recent activity)"

        # Show stats if available
        if [ -f "$METRICS_FILE" ]; then
            echo ""
            echo -e "${BLUE}Today's stats:${NC}"
            TODAY=$(date +%Y-%m-%d)
            CYCLES=$(grep -c "$TODAY" "$METRICS_FILE" 2>/dev/null || echo "0")
            echo "  Cycles today: $CYCLES"
        fi
    else
        echo -e "${YELLOW}Daemon not running${NC}"
        if [ -f "$PID_FILE" ]; then
            rm -f "$PID_FILE"
        fi
    fi
}

show_logs() {
    if [ -f "$(log_file)" ]; then
        tail -f "$(log_file)"
    else
        echo -e "${YELLOW}No log file found for today${NC}"
        echo "Looking for recent logs..."
        ls -la "$LOG_DIR"/*.log 2>/dev/null || echo "No logs found"
    fi
}

show_stats() {
    echo -e "${BLUE}Autonomous Improvement Statistics${NC}"
    echo "=================================="
    echo ""

    if [ ! -f "$METRICS_FILE" ]; then
        echo -e "${YELLOW}No metrics data available yet${NC}"
        return
    fi

    # Total cycles
    TOTAL=$(wc -l < "$METRICS_FILE" 2>/dev/null || echo "0")
    echo "Total cycles: $TOTAL"

    # Today's cycles
    TODAY=$(date +%Y-%m-%d)
    TODAY_CYCLES=$(grep -c "$TODAY" "$METRICS_FILE" 2>/dev/null || echo "0")
    echo "Cycles today: $TODAY_CYCLES"

    # Success rate (approximate - count cycles with hypothesesSucceeded > 0)
    if [ "$TOTAL" -gt 0 ]; then
        SUCCESS=$(grep -c '"hypothesesSucceeded":[1-9]' "$METRICS_FILE" 2>/dev/null || echo "0")
        RATE=$(echo "scale=1; $SUCCESS * 100 / $TOTAL" | bc 2>/dev/null || echo "N/A")
        echo "Success rate: ${RATE}%"
    fi

    # Recent reflections
    REFLECTIONS_DIR="${HOME}/.casterly/autonomous/reflections"
    if [ -d "$REFLECTIONS_DIR" ]; then
        REFLECTION_COUNT=$(ls -1 "$REFLECTIONS_DIR"/*.json 2>/dev/null | wc -l || echo "0")
        echo "Total reflections: $REFLECTION_COUNT"
    fi

    echo ""
    echo -e "${BLUE}Last 5 cycles:${NC}"
    tail -5 "$METRICS_FILE" 2>/dev/null | while read -r line; do
        CYCLE_ID=$(echo "$line" | grep -o '"cycleId":"[^"]*"' | cut -d'"' -f4)
        SUCCEEDED=$(echo "$line" | grep -o '"hypothesesSucceeded":[0-9]*' | cut -d':' -f2)
        ATTEMPTED=$(echo "$line" | grep -o '"hypothesesAttempted":[0-9]*' | cut -d':' -f2)
        echo "  $CYCLE_ID: $SUCCEEDED/$ATTEMPTED succeeded"
    done
}

# Main command handler
case "${1:-}" in
    start)
        start_daemon
        ;;
    stop)
        stop_daemon
        ;;
    restart)
        stop_daemon
        sleep 2
        start_daemon
        ;;
    status)
        status_daemon
        ;;
    logs)
        show_logs
        ;;
    stats)
        show_stats
        ;;
    *)
        usage
        ;;
esac
