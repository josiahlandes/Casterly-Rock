#!/bin/bash
# MLX Inference Server (vllm-mlx)
#
# Launches vllm-mlx as an OpenAI-compatible inference server for Apple Silicon.
# Achieves 50-87% faster inference than Ollama for large dense models.
#
# Prerequisites:
#   pip install vllm-mlx
#   Download/convert model: mlx_lm.convert --hf-path Qwen/Qwen3.5-122B-MLX -q 4bit
#
# Usage:
#   ./scripts/mlx-server.sh start         - Start the server
#   ./scripts/mlx-server.sh start --spec  - Start with speculative decoding
#   ./scripts/mlx-server.sh stop          - Stop the server
#   ./scripts/mlx-server.sh status        - Check server status
#   ./scripts/mlx-server.sh logs          - Tail the log file
#
# See docs/roadmap.md Tier 2, Items 5 and 6.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LOG_DIR="${HOME}/.casterly/mlx/logs"
PID_FILE="${HOME}/.casterly/mlx/server.pid"

# ── Configuration ────────────────────────────────────────────────────────────
# Override these via environment variables if needed.

MLX_MODEL="${MLX_MODEL:-mlx-community/Qwen3.5-122B-MLX-4bit}"
MLX_HOST="${MLX_HOST:-127.0.0.1}"
MLX_PORT="${MLX_PORT:-8000}"

# Speculative decoding (Tier 2, Item 6)
MLX_DRAFT_MODEL="${MLX_DRAFT_MODEL:-mlx-community/Qwen3.5-0.5B-MLX-4bit}"
MLX_SPEC_TOKENS="${MLX_SPEC_TOKENS:-5}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

mkdir -p "$LOG_DIR"
mkdir -p "$(dirname "$PID_FILE")"

usage() {
    echo "MLX Inference Server (vllm-mlx)"
    echo ""
    echo "Usage: $0 {start|stop|restart|status|logs} [--spec]"
    echo ""
    echo "Commands:"
    echo "  start         - Start the vllm-mlx server"
    echo "  start --spec  - Start with speculative decoding (draft model)"
    echo "  stop          - Stop the running server"
    echo "  restart       - Stop and start the server"
    echo "  status        - Check if server is running"
    echo "  logs          - Tail the server log file"
    echo ""
    echo "Environment variables:"
    echo "  MLX_MODEL        Model to serve (default: $MLX_MODEL)"
    echo "  MLX_HOST         Bind address (default: $MLX_HOST)"
    echo "  MLX_PORT         Port (default: $MLX_PORT)"
    echo "  MLX_DRAFT_MODEL  Draft model for speculative decoding (default: $MLX_DRAFT_MODEL)"
    echo "  MLX_SPEC_TOKENS  Speculative tokens per step (default: $MLX_SPEC_TOKENS)"
    exit 1
}

log_file() {
    echo "$LOG_DIR/server-$(date +%Y%m%d).log"
}

check_deps() {
    if ! command -v vllm &>/dev/null; then
        echo -e "${RED}Error: vllm not found. Install with: pip install vllm-mlx${NC}"
        exit 1
    fi
}

start_server() {
    local use_spec=false
    if [[ "${1:-}" == "--spec" ]]; then
        use_spec=true
    fi

    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo -e "${YELLOW}Server already running (PID: $(cat "$PID_FILE"))${NC}"
        exit 1
    fi

    check_deps

    echo -e "${BLUE}Starting MLX inference server...${NC}"
    echo -e "  Model: ${GREEN}$MLX_MODEL${NC}"
    echo -e "  Endpoint: ${GREEN}http://$MLX_HOST:$MLX_PORT${NC}"

    local CMD=(
        vllm serve "$MLX_MODEL"
        --host "$MLX_HOST"
        --port "$MLX_PORT"
        --device mps
    )

    if [ "$use_spec" = true ]; then
        echo -e "  Draft model: ${GREEN}$MLX_DRAFT_MODEL${NC}"
        echo -e "  Spec tokens: ${GREEN}$MLX_SPEC_TOKENS${NC}"
        CMD+=(
            --speculative-model "$MLX_DRAFT_MODEL"
            --num-speculative-tokens "$MLX_SPEC_TOKENS"
        )
    fi

    cd "$PROJECT_ROOT"
    nohup "${CMD[@]}" >> "$(log_file)" 2>&1 &

    echo $! > "$PID_FILE"

    # Wait for the server to start (check health endpoint)
    echo -n "  Waiting for server..."
    for i in {1..60}; do
        if curl -s "http://$MLX_HOST:$MLX_PORT/health" > /dev/null 2>&1; then
            echo ""
            echo -e "${GREEN}Server started successfully (PID: $(cat "$PID_FILE"))${NC}"
            echo -e "Logs: $(log_file)"
            return 0
        fi

        # Check if process died
        if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
            echo ""
            echo -e "${RED}Server failed to start. Check logs:${NC}"
            tail -20 "$(log_file)" 2>/dev/null || echo "No logs available"
            rm -f "$PID_FILE"
            exit 1
        fi

        echo -n "."
        sleep 2
    done

    echo ""
    echo -e "${YELLOW}Server is starting slowly. Check logs: $(log_file)${NC}"
}

stop_server() {
    if [ ! -f "$PID_FILE" ]; then
        echo -e "${YELLOW}Server not running (no PID file)${NC}"
        return 0
    fi

    PID=$(cat "$PID_FILE")

    if kill -0 "$PID" 2>/dev/null; then
        echo -e "${BLUE}Stopping MLX server (PID: $PID)...${NC}"
        kill "$PID"

        for i in {1..10}; do
            if ! kill -0 "$PID" 2>/dev/null; then
                break
            fi
            sleep 1
        done

        if kill -0 "$PID" 2>/dev/null; then
            echo -e "${YELLOW}Force killing server...${NC}"
            kill -9 "$PID" 2>/dev/null || true
        fi

        rm -f "$PID_FILE"
        echo -e "${GREEN}Server stopped${NC}"
    else
        echo -e "${YELLOW}Server not running (stale PID file)${NC}"
        rm -f "$PID_FILE"
    fi
}

status_server() {
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo -e "${GREEN}MLX server running (PID: $(cat "$PID_FILE"))${NC}"
        echo ""

        # Check health
        if curl -s "http://$MLX_HOST:$MLX_PORT/health" > /dev/null 2>&1; then
            echo -e "  Health: ${GREEN}OK${NC}"
        else
            echo -e "  Health: ${RED}NOT RESPONDING${NC}"
        fi

        # Show model info
        local models
        models=$(curl -s "http://$MLX_HOST:$MLX_PORT/v1/models" 2>/dev/null || echo "{}")
        echo -e "  Models: $models"
    else
        echo -e "${YELLOW}MLX server not running${NC}"
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
        ls -la "$LOG_DIR"/*.log 2>/dev/null || echo "No logs found"
    fi
}

# Main command handler
case "${1:-}" in
    start)
        start_server "${2:-}"
        ;;
    stop)
        stop_server
        ;;
    restart)
        stop_server
        sleep 2
        start_server "${2:-}"
        ;;
    status)
        status_server
        ;;
    logs)
        show_logs
        ;;
    *)
        usage
        ;;
esac
