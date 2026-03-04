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

# KV cache quantization (Tier 4, Item 12 — K8V4 mixed-precision)
# Supported bit widths: 2, 3, 4, 5, 6, 8 (from mlx.core.quantize)
# Supported group sizes: 32, 64, 128
# K8V4 preset: keys=8-bit, values=4-bit → ~59% KV cache reduction
# References: KIVI (Liu et al., 2024), KVQuant (Hooper et al., 2024)
MLX_KV_KEY_BITS="${MLX_KV_KEY_BITS:-}"
MLX_KV_VALUE_BITS="${MLX_KV_VALUE_BITS:-}"
MLX_KV_GROUP_SIZE="${MLX_KV_GROUP_SIZE:-64}"
MLX_KV_QUANTIZED_START="${MLX_KV_QUANTIZED_START:-0}"
# Set to 1 when vllm-mlx gains --kv-bits support (see mlx-lm Issue #615)
MLX_KV_SERVER_SUPPORT="${MLX_KV_SERVER_SUPPORT:-0}"

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
    echo "  MLX_MODEL              Model to serve (default: $MLX_MODEL)"
    echo "  MLX_HOST               Bind address (default: $MLX_HOST)"
    echo "  MLX_PORT               Port (default: $MLX_PORT)"
    echo "  MLX_DRAFT_MODEL        Draft model for speculative decoding (default: $MLX_DRAFT_MODEL)"
    echo "  MLX_SPEC_TOKENS        Speculative tokens per step (default: $MLX_SPEC_TOKENS)"
    echo ""
    echo "KV cache quantization (K8V4 — Tier 4, Item 12):"
    echo "  MLX_KV_KEY_BITS        Bits for key cache (2,3,4,5,6,8; default: unset = FP16)"
    echo "  MLX_KV_VALUE_BITS      Bits for value cache (2,3,4,5,6,8; default: unset = FP16)"
    echo "  MLX_KV_GROUP_SIZE      Quantization group size (32,64,128; default: $MLX_KV_GROUP_SIZE)"
    echo "  MLX_KV_QUANTIZED_START Step to begin quantization (default: $MLX_KV_QUANTIZED_START)"
    echo "  MLX_KV_SERVER_SUPPORT  Set to 1 when vllm-mlx supports --kv-bits (default: 0)"
    exit 1
}

log_file() {
    echo "$LOG_DIR/server-$(date +%Y%m%d).log"
}

check_deps() {
    if ! command -v vllm-mlx &>/dev/null; then
        echo -e "${RED}Error: vllm-mlx not found. Install with: uv tool install vllm-mlx${NC}"
        exit 1
    fi
}

supports_speculative_decoding() {
    local help_text
    help_text="$(vllm-mlx serve --help 2>&1 || true)"
    [[ "$help_text" == *"--speculative-model"* ]] && [[ "$help_text" == *"--num-speculative-tokens"* ]]
}

validate_model_compatibility() {
    if ! command -v python3 &>/dev/null; then
        echo -e "${YELLOW}Warning: python3 not found; skipping model compatibility check.${NC}"
        return 0
    fi

    local config_json=""

    # Local model directory with config.json
    if [ -f "$MLX_MODEL/config.json" ]; then
        config_json="$(cat "$MLX_MODEL/config.json")"
    # HuggingFace repo id (query metadata API; returns JSON reliably)
    elif [[ "$MLX_MODEL" == */* ]]; then
        config_json="$(curl -fsSL "https://huggingface.co/api/models/$MLX_MODEL" 2>/dev/null || true)"
    else
        echo -e "${YELLOW}Warning: Unknown model format; skipping compatibility check: $MLX_MODEL${NC}"
        return 0
    fi

    if [ -z "$config_json" ]; then
        echo -e "${YELLOW}Warning: Could not fetch model config; skipping compatibility check.${NC}"
        return 0
    fi

    if ! MODEL_CONFIG_JSON="$config_json" python3 - <<'PY'
import json
import os
import sys

try:
    raw = json.loads(os.environ.get("MODEL_CONFIG_JSON", ""))
except Exception as exc:
    print(f"invalid config JSON: {exc}", file=sys.stderr)
    sys.exit(3)

if isinstance(raw, dict) and isinstance(raw.get("config"), dict):
    cfg = raw["config"]
else:
    cfg = raw

vision = cfg.get("vision_config") is not None

# Only reject models with vision_config (true multimodal).
# ConditionalGeneration in the architecture name is normal for MoE models
# (e.g. Qwen3_5MoeForConditionalGeneration) and does NOT imply multimodal.
if vision:
    print("vision_config present", file=sys.stderr)
    sys.exit(2)
PY
    then
        echo -e "${RED}Error: Model appears multimodal/incompatible for text-only vllm-mlx.${NC}"
        echo -e "  model: ${YELLOW}$MLX_MODEL${NC}"
        echo -e "  hint: use a text-only model (e.g. mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit)"
        return 1
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
    validate_model_compatibility || exit 1

    if [ "$use_spec" = true ] && ! supports_speculative_decoding; then
        echo -e "${YELLOW}Warning: Installed vllm-mlx does not support speculative flags; starting without --spec.${NC}"
        use_spec=false
    fi

    # ── KV cache validation ──────────────────────────────────────────────
    local kv_enabled=false
    if [ -n "$MLX_KV_KEY_BITS" ] || [ -n "$MLX_KV_VALUE_BITS" ]; then
        kv_enabled=true
        local valid_bits="2 3 4 5 6 8"
        local valid_group_sizes="32 64 128"

        if [ -n "$MLX_KV_KEY_BITS" ]; then
            if ! echo "$valid_bits" | grep -qw "$MLX_KV_KEY_BITS"; then
                echo -e "${RED}Error: MLX_KV_KEY_BITS=$MLX_KV_KEY_BITS is invalid. Must be one of: $valid_bits${NC}"
                exit 1
            fi
        fi

        if [ -n "$MLX_KV_VALUE_BITS" ]; then
            if ! echo "$valid_bits" | grep -qw "$MLX_KV_VALUE_BITS"; then
                echo -e "${RED}Error: MLX_KV_VALUE_BITS=$MLX_KV_VALUE_BITS is invalid. Must be one of: $valid_bits${NC}"
                exit 1
            fi
        fi

        if ! echo "$valid_group_sizes" | grep -qw "$MLX_KV_GROUP_SIZE"; then
            echo -e "${RED}Error: MLX_KV_GROUP_SIZE=$MLX_KV_GROUP_SIZE is invalid. Must be one of: $valid_group_sizes${NC}"
            exit 1
        fi
    fi

    echo -e "${BLUE}Starting MLX inference server...${NC}"
    echo -e "  Model: ${GREEN}$MLX_MODEL${NC}"
    echo -e "  Endpoint: ${GREEN}http://$MLX_HOST:$MLX_PORT${NC}"

    local CMD=(
        vllm-mlx serve "$MLX_MODEL"
        --host "$MLX_HOST"
        --port "$MLX_PORT"
        --enable-auto-tool-choice
        --tool-call-parser qwen
        --reasoning-parser qwen3
        --max-tokens 16384
    )

    if [ "$use_spec" = true ]; then
        echo -e "  Draft model: ${GREEN}$MLX_DRAFT_MODEL${NC}"
        echo -e "  Spec tokens: ${GREEN}$MLX_SPEC_TOKENS${NC}"
        CMD+=(
            --speculative-model "$MLX_DRAFT_MODEL"
            --num-speculative-tokens "$MLX_SPEC_TOKENS"
        )
    fi

    # ── KV cache quantization flags ──────────────────────────────────────
    if [ "$kv_enabled" = true ]; then
        local key_label="${MLX_KV_KEY_BITS:-fp16}"
        local val_label="${MLX_KV_VALUE_BITS:-fp16}"
        echo -e "  KV cache: ${GREEN}K${key_label}V${val_label}${NC} (group_size=${MLX_KV_GROUP_SIZE})"

        if [ "$MLX_KV_SERVER_SUPPORT" = "1" ]; then
            # When vllm-mlx adds support, pass flags to the server command.
            # The exact flag names will depend on vllm-mlx's implementation.
            # Expected flags (based on mlx_lm CLI):
            #   --kv-bits <bits>          (uniform, or key bits for split)
            #   --kv-group-size <size>
            #   --quantized-kv-start <n>
            if [ -n "$MLX_KV_KEY_BITS" ]; then
                CMD+=(--kv-bits "$MLX_KV_KEY_BITS")
            fi
            if [ -n "$MLX_KV_VALUE_BITS" ] && [ "$MLX_KV_VALUE_BITS" != "$MLX_KV_KEY_BITS" ]; then
                CMD+=(--kv-value-bits "$MLX_KV_VALUE_BITS")
            fi
            CMD+=(--kv-group-size "$MLX_KV_GROUP_SIZE")
            if [ "$MLX_KV_QUANTIZED_START" != "0" ]; then
                CMD+=(--quantized-kv-start "$MLX_KV_QUANTIZED_START")
            fi
        else
            echo -e "  ${YELLOW}(config validated — awaiting vllm-mlx --kv-bits support, see mlx-lm #615)${NC}"
        fi
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

        # Show KV cache config
        if [ -n "$MLX_KV_KEY_BITS" ] || [ -n "$MLX_KV_VALUE_BITS" ]; then
            echo -e "  KV cache: K${MLX_KV_KEY_BITS:-fp16}V${MLX_KV_VALUE_BITS:-fp16} (group=${MLX_KV_GROUP_SIZE})"
            if [ "$MLX_KV_SERVER_SUPPORT" = "1" ]; then
                echo -e "  KV server support: ${GREEN}active${NC}"
            else
                echo -e "  KV server support: ${YELLOW}pending (config only)${NC}"
            fi
        else
            echo -e "  KV cache: FP16 (no quantization)"
        fi
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
