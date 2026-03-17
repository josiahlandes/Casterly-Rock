#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# start-all.sh — Unified Startup for Tyrion + All Inference Servers
#
# Starts the full Tyrion stack in the correct order:
#   1. Ollama server (fast model — 35B-A3B MoE on :11434)
#   2. MLX reasoner (27B dense on :8000)
#   3. MLX coder (80B-A3B MoE on :8001)
#   4. Tyrion daemon (dual-loop controller)
#
# Usage:
#   ./scripts/start-all.sh              Start everything
#   ./scripts/start-all.sh --no-daemon  Start servers only (no Tyrion daemon)
#   ./scripts/start-all.sh stop         Stop everything
#   ./scripts/start-all.sh status       Show status of all services
#
# Memory budget (~128 GB Mac Studio M4 Max):
#   Reasoner:  ~18 GB (27B dense, MLX)
#   Coder:     ~42 GB (80B-A3B MXFP4, MLX)
#   Fast:      ~24 GB (35B-A3B, Ollama)
#   Total:     ~84 GB — ~44 GB headroom
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# ─── Colors ───────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

# ─── Configuration ────────────────────────────────────────────────────────────

# Reasoner: 27B dense model with thinking + reasoning parser
REASONER_MODEL="nightmedia/Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-qx64-hi-mlx"
REASONER_PORT=8000

# Coder: 80B-A3B hybrid MoE+DeltaNet with tool calling
CODER_MODEL="nightmedia/Qwen3-Coder-Next-mxfp4-mlx"
CODER_PORT=8001

# Ollama fast model
OLLAMA_FAST_MODEL="qwen3.5:35b-a3b"

# ─── Helpers ──────────────────────────────────────────────────────────────────

section() {
  echo ""
  echo -e "${BOLD}── $1 ──${NC}"
}

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }

check_health() {
  local url="$1" timeout="${2:-5}"
  curl -sf --max-time "$timeout" "$url" > /dev/null 2>&1
}

# ─── Status ───────────────────────────────────────────────────────────────────

cmd_status() {
  echo -e "${BOLD}Tyrion Stack Status${NC}"
  echo ""

  # Ollama
  if pgrep -x "ollama" > /dev/null 2>&1; then
    if check_health "http://localhost:11434/api/tags"; then
      ok "Ollama            running (:11434)"
    else
      warn "Ollama            process alive, not responding"
    fi
  else
    fail "Ollama            not running"
  fi

  # MLX Reasoner
  if [ -f "$HOME/.casterly/mlx/reasoner.pid" ] && kill -0 "$(cat "$HOME/.casterly/mlx/reasoner.pid")" 2>/dev/null; then
    if check_health "http://localhost:$REASONER_PORT/health"; then
      ok "MLX Reasoner      running (:$REASONER_PORT)"
    else
      warn "MLX Reasoner      process alive, not responding"
    fi
  else
    fail "MLX Reasoner      not running"
  fi

  # MLX Coder
  if [ -f "$HOME/.casterly/mlx/coder.pid" ] && kill -0 "$(cat "$HOME/.casterly/mlx/coder.pid")" 2>/dev/null; then
    if check_health "http://localhost:$CODER_PORT/health"; then
      ok "MLX Coder         running (:$CODER_PORT)"
    else
      warn "MLX Coder         process alive, not responding"
    fi
  else
    fail "MLX Coder         not running"
  fi

  # Tyrion daemon
  if [ -f "$HOME/.casterly/tyrion.pid" ] && kill -0 "$(cat "$HOME/.casterly/tyrion.pid")" 2>/dev/null; then
    ok "Tyrion Daemon     running (PID: $(cat "$HOME/.casterly/tyrion.pid"))"
  else
    # Fallback: check for process
    local pid
    pid=$(pgrep -f "imessage-daemon" 2>/dev/null | head -1) || true
    if [ -n "$pid" ]; then
      ok "Tyrion Daemon     running (PID: $pid, no PID file)"
    else
      fail "Tyrion Daemon     not running"
    fi
  fi
}

# ─── Stop All ─────────────────────────────────────────────────────────────────

cmd_stop() {
  echo -e "${BOLD}Stopping Tyrion Stack${NC}"

  # Stop in reverse order: daemon first, then servers

  section "Tyrion Daemon"
  bash "$SCRIPT_DIR/tyrion.sh" stop 2>/dev/null || warn "Tyrion daemon was not running"

  section "MLX Coder (:$CODER_PORT)"
  MLX_INSTANCE=coder MLX_PORT=$CODER_PORT bash "$SCRIPT_DIR/mlx-server.sh" stop 2>/dev/null || warn "MLX coder was not running"

  section "MLX Reasoner (:$REASONER_PORT)"
  MLX_INSTANCE=reasoner MLX_PORT=$REASONER_PORT bash "$SCRIPT_DIR/mlx-server.sh" stop 2>/dev/null || warn "MLX reasoner was not running"

  section "Ollama"
  if pgrep -x "ollama" > /dev/null 2>&1; then
    echo -e "  ${BLUE}Stopping Ollama...${NC}"
    pkill -x "ollama" 2>/dev/null || true
    sleep 2
    if pgrep -x "ollama" > /dev/null 2>&1; then
      warn "Ollama still running — may be managed by launchd"
    else
      ok "Ollama stopped"
    fi
  else
    warn "Ollama was not running"
  fi

  echo ""
  echo -e "${GREEN}All services stopped${NC}"
}

# ─── Start All ────────────────────────────────────────────────────────────────

cmd_start() {
  local no_daemon=false
  if [[ "${1:-}" == "--no-daemon" ]]; then
    no_daemon=true
  fi

  echo -e "${BOLD}Starting Tyrion Stack${NC}"
  echo -e "Memory budget: ~84 GB of 128 GB (~44 GB headroom)"

  # ── 1. Ollama ─────────────────────────────────────────────────────────────
  section "Ollama (:11434)"

  if pgrep -x "ollama" > /dev/null 2>&1; then
    ok "Already running"
  else
    echo -e "  ${BLUE}Starting Ollama...${NC}"
    # Set KV cache quantization for Ollama
    export OLLAMA_KV_CACHE_TYPE=q8_0
    ollama serve > /dev/null 2>&1 &
    disown

    # Wait for Ollama to be ready
    for i in {1..30}; do
      if check_health "http://localhost:11434/api/tags"; then
        ok "Started"
        break
      fi
      if (( i == 30 )); then
        fail "Ollama failed to start within 30s"
        exit 1
      fi
      sleep 1
    done
  fi

  # Ensure fast model is loaded
  echo -e "  ${BLUE}Warming $OLLAMA_FAST_MODEL...${NC}"
  if curl -sf "http://localhost:11434/api/generate" \
    -d "{\"model\":\"$OLLAMA_FAST_MODEL\",\"prompt\":\"hi\",\"options\":{\"num_predict\":1},\"keep_alive\":-1}" \
    > /dev/null 2>&1; then
    ok "Fast model warm"
  else
    warn "Could not warm fast model (will load on first request)"
  fi

  # ── 2. MLX Reasoner ───────────────────────────────────────────────────────
  section "MLX Reasoner (:$REASONER_PORT)"

  if [ -f "$HOME/.casterly/mlx/reasoner.pid" ] && kill -0 "$(cat "$HOME/.casterly/mlx/reasoner.pid")" 2>/dev/null && check_health "http://localhost:$REASONER_PORT/health"; then
    ok "Already running"
  else
    MLX_INSTANCE=reasoner \
    MLX_MODEL="$REASONER_MODEL" \
    MLX_PORT=$REASONER_PORT \
    MLX_MAX_TOKENS=16384 \
    MLX_REASONING_PARSER=qwen3 \
    MLX_KV_KEY_BITS=8 \
    MLX_KV_VALUE_BITS=4 \
    MLX_KV_GROUP_SIZE=64 \
      bash "$SCRIPT_DIR/mlx-server.sh" start

    if check_health "http://localhost:$REASONER_PORT/health"; then
      ok "Reasoner healthy"
    else
      fail "Reasoner started but health check failed"
    fi
  fi

  # ── 3. MLX Coder ──────────────────────────────────────────────────────────
  section "MLX Coder (:$CODER_PORT)"

  if [ -f "$HOME/.casterly/mlx/coder.pid" ] && kill -0 "$(cat "$HOME/.casterly/mlx/coder.pid")" 2>/dev/null && check_health "http://localhost:$CODER_PORT/health"; then
    ok "Already running"
  else
    MLX_INSTANCE=coder \
    MLX_MODEL="$CODER_MODEL" \
    MLX_PORT=$CODER_PORT \
    MLX_MAX_TOKENS=16384 \
    MLX_TOOL_PARSER=qwen \
      bash "$SCRIPT_DIR/mlx-server.sh" start

    if check_health "http://localhost:$CODER_PORT/health"; then
      ok "Coder healthy"
    else
      fail "Coder started but health check failed"
    fi
  fi

  # ── 4. Tyrion Daemon ──────────────────────────────────────────────────────
  if [ "$no_daemon" = true ]; then
    section "Tyrion Daemon (skipped — --no-daemon)"
  else
    section "Tyrion Daemon"
    bash "$SCRIPT_DIR/tyrion.sh" start
  fi

  # ── Summary ───────────────────────────────────────────────────────────────
  echo ""
  echo -e "${GREEN}${BOLD}Tyrion stack is up${NC}"
  cmd_status
}

# ─── Main ─────────────────────────────────────────────────────────────────────

case "${1:-}" in
  stop)
    cmd_stop
    ;;
  status)
    cmd_status
    ;;
  --no-daemon)
    cmd_start "--no-daemon"
    ;;
  start|"")
    cmd_start "${2:-}"
    ;;
  help|-h|--help)
    echo "Usage: $0 [start|stop|status] [--no-daemon]"
    echo ""
    echo "  start          Start Ollama, MLX servers, and Tyrion daemon (default)"
    echo "  start --no-daemon  Start servers only, skip the Tyrion daemon"
    echo "  --no-daemon    Shorthand for start --no-daemon"
    echo "  stop           Stop everything in reverse order"
    echo "  status         Show status of all services"
    ;;
  *)
    echo -e "${RED}Unknown command: $1${NC}"
    echo "Usage: $0 [start|stop|status] [--no-daemon]"
    exit 1
    ;;
esac
