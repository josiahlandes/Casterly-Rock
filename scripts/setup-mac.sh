#!/bin/bash
# setup-mac.sh - Set up Tyrion/Casterly on a fresh Mac
#
# Usage: ./scripts/setup-mac.sh
#
# This script checks prerequisites, installs dependencies, pulls Ollama
# models, builds the project, installs the CLI, and sets up the workspace.

set -e

# ═══════════════════════════════════════════════════════════════════════════════
# Configuration
# ═══════════════════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CASTERLY_HOME="${HOME}/.casterly"
WORKSPACE_DIR="${CASTERLY_HOME}/workspace"
BIN_DIR="${HOME}/.local/bin"

PRIMARY_MODEL="hermes3:70b"
CODING_MODEL="qwen3-coder-next:latest"
OLLAMA_URL="http://localhost:11434"

# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════

info()    { echo "==> $1"; }
success() { echo "  OK: $1"; }
warn()    { echo "  WARN: $1"; }
fail()    { echo "  FAIL: $1"; exit 1; }

check_command() {
    command -v "$1" >/dev/null 2>&1
}

# ═══════════════════════════════════════════════════════════════════════════════
# Step 1: Check macOS
# ═══════════════════════════════════════════════════════════════════════════════

info "Checking macOS version..."
if [[ "$(uname)" != "Darwin" ]]; then
    fail "This script is for macOS only."
fi

MACOS_VERSION=$(sw_vers -productVersion 2>/dev/null || echo "unknown")
MACOS_MAJOR=$(echo "$MACOS_VERSION" | cut -d. -f1)

if [[ "$MACOS_MAJOR" -lt 12 ]] 2>/dev/null; then
    fail "macOS 12 or later required. Found: $MACOS_VERSION"
fi
success "macOS $MACOS_VERSION"

# ═══════════════════════════════════════════════════════════════════════════════
# Step 2: Check Node.js and npm
# ═══════════════════════════════════════════════════════════════════════════════

info "Checking Node.js..."
if ! check_command node; then
    echo ""
    echo "  Node.js is not installed. Install it using one of:"
    echo ""
    echo "    brew install node          # via Homebrew"
    echo "    https://nodejs.org         # official installer"
    echo ""
    fail "Node.js 18+ is required."
fi

NODE_VERSION=$(node -v | sed 's/v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
if [[ "$NODE_MAJOR" -lt 18 ]]; then
    fail "Node.js 18+ required. Found: $NODE_VERSION"
fi
success "Node.js $NODE_VERSION"

info "Checking npm..."
if ! check_command npm; then
    fail "npm not found. It should come with Node.js."
fi
success "npm $(npm -v)"

# ═══════════════════════════════════════════════════════════════════════════════
# Step 3: Check / install Ollama
# ═══════════════════════════════════════════════════════════════════════════════

info "Checking Ollama..."
if ! check_command ollama; then
    echo ""
    echo "  Ollama is not installed. Install it from:"
    echo ""
    echo "    https://ollama.ai"
    echo ""
    echo "  After installing, run this script again."
    fail "Ollama is required for local inference."
fi
success "Ollama found"

info "Checking Ollama is running..."
if ! curl -s "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
    echo ""
    echo "  Ollama is installed but not running. Start it with:"
    echo ""
    echo "    ollama serve"
    echo ""
    echo "  Or open the Ollama app from Applications."
    fail "Ollama must be running at $OLLAMA_URL"
fi
success "Ollama is running"

# ═══════════════════════════════════════════════════════════════════════════════
# Step 4: Pull Ollama models
# ═══════════════════════════════════════════════════════════════════════════════

pull_model() {
    local model="$1"
    if ollama list 2>/dev/null | grep -q "$(echo "$model" | cut -d: -f1)"; then
        success "$model already pulled"
    else
        info "Pulling $model (this will take a while)..."
        ollama pull "$model" || fail "Failed to pull $model"
        success "$model pulled"
    fi
}

info "Checking Ollama models..."
pull_model "$PRIMARY_MODEL"
pull_model "$CODING_MODEL"

# ═══════════════════════════════════════════════════════════════════════════════
# Step 5: Install npm dependencies
# ═══════════════════════════════════════════════════════════════════════════════

info "Installing npm dependencies..."
cd "$REPO_DIR"
npm install || fail "npm install failed"
success "Dependencies installed"

# ═══════════════════════════════════════════════════════════════════════════════
# Step 6: Build the project
# ═══════════════════════════════════════════════════════════════════════════════

info "Building Casterly..."
npm run build || fail "Build failed"
success "Build complete"

# ═══════════════════════════════════════════════════════════════════════════════
# Step 7: Install CLI
# ═══════════════════════════════════════════════════════════════════════════════

info "Installing casterly CLI..."
npm run install:host || fail "CLI installation failed"
success "CLI installed to $BIN_DIR/casterly"

# ═══════════════════════════════════════════════════════════════════════════════
# Step 8: Set up workspace
# ═══════════════════════════════════════════════════════════════════════════════

info "Setting up workspace at $CASTERLY_HOME..."

mkdir -p "$WORKSPACE_DIR"
mkdir -p "$CASTERLY_HOME/sessions"
mkdir -p "$CASTERLY_HOME/memory"
mkdir -p "$CASTERLY_HOME/logs"

# Copy workspace personality files if they don't already exist
for file in IDENTITY.md SOUL.md USER.md TOOLS.md; do
    src="$REPO_DIR/workspace/$file"
    dst="$WORKSPACE_DIR/$file"
    if [[ -f "$src" ]] && [[ ! -f "$dst" ]]; then
        cp "$src" "$dst"
        success "Copied $file to workspace"
    elif [[ -f "$dst" ]]; then
        success "$file already exists in workspace (kept existing)"
    fi
done

# ═══════════════════════════════════════════════════════════════════════════════
# Step 9: Set up PATH
# ═══════════════════════════════════════════════════════════════════════════════

info "Checking PATH..."
SHELL_RC="$HOME/.zshrc"
if [[ -n "$BASH_VERSION" ]] && [[ -f "$HOME/.bashrc" ]]; then
    SHELL_RC="$HOME/.bashrc"
fi

if echo "$PATH" | tr ':' '\n' | grep -q "$BIN_DIR"; then
    success "$BIN_DIR is already on PATH"
else
    echo "" >> "$SHELL_RC"
    echo "# Casterly CLI" >> "$SHELL_RC"
    echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$SHELL_RC"
    success "Added $BIN_DIR to PATH in $SHELL_RC"
    warn "Run 'source $SHELL_RC' or open a new terminal to use 'casterly'"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Step 10: macOS permissions reminder
# ═══════════════════════════════════════════════════════════════════════════════

info "macOS permissions (manual steps)..."
echo ""
echo "  For iMessage integration, grant Full Disk Access to your terminal:"
echo ""
echo "    System Settings > Privacy & Security > Full Disk Access"
echo "    Add: Terminal.app (or iTerm2, Warp, etc.)"
echo ""
echo "  For Calendar and system automation, macOS will prompt on first use."
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# Done
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo "═══════════════════════════════════════════════════════════════════════════════"
echo "  Tyrion is ready."
echo "═══════════════════════════════════════════════════════════════════════════════"
echo ""
echo "  Quick start:"
echo ""
echo "    casterly \"Hello, what can you do?\""
echo ""
echo "  iMessage daemon:"
echo ""
echo "    npm run imessage          # development mode"
echo "    npm run imessage:start    # production mode"
echo ""
echo "  Development:"
echo ""
echo "    npm run dev -- \"Your query\"    # run without building"
echo "    npm run check                  # run all quality gates"
echo ""
echo "  Workspace files:  $WORKSPACE_DIR"
echo "  Config:           $REPO_DIR/config/default.yaml"
echo "  Logs:             $CASTERLY_HOME/logs/"
echo ""
