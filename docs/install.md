# Casterly Installation Guide

This guide covers installation, configuration, and running Casterly on Mac Studio M4 Max.

## Prerequisites

### Required

| Requirement | Version | Purpose |
|-------------|---------|---------|
| Node.js | 18.x or later | Runtime environment |
| npm | 9.x or later | Package management |
| macOS | 12.x or later | Primary platform (for iMessage) |
| Ollama | Latest | Local LLM provider (FastLoop) |
| vllm-mlx | Latest | MLX inference server (DeepLoop) |
| Python 3.10+ | Latest | Required by vllm-mlx |

### Hardware

| Spec | Requirement |
|------|-------------|
| Platform | Mac Studio M4 Max |
| Memory | 128GB unified |
| Storage | NVMe SSD |

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/your-org/casterly.git
cd casterly

# 2. Install dependencies
npm install

# 3. Set up Ollama (FastLoop)
ollama pull qwen3.5:35b-a3b

# 4. Set up MLX models (DeepLoop)
pip install vllm-mlx huggingface-hub
huggingface-cli download nightmedia/Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-qx64-hi-mlx
huggingface-cli download nightmedia/Qwen3-Coder-Next-mxfp4-mlx

# 5. Build and install
npm run install:host

# 6. Add to PATH (if not already)
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

# 7. Run
casterly "Hello, what can you do?"
```

## Detailed Installation

### Step 1: Install Dependencies

```bash
npm install
```

This installs:
- `yaml` - Configuration file parsing
- `zod` - Runtime schema validation
- Development tools (TypeScript, ESLint, Vitest)

### Step 2: Set Up Ollama (FastLoop)

1. Install Ollama from [ollama.ai](https://ollama.ai)

2. Pull the FastLoop model:
   ```bash
   # FastLoop: triage, review, acknowledgment (~24 GB, MoE: 35B total, 3B active)
   ollama pull qwen3.5:35b-a3b
   ```

3. Verify Ollama is running:
   ```bash
   curl http://localhost:11434/api/tags
   ```

### Step 3: Set Up vllm-mlx (DeepLoop)

vllm-mlx runs two instances for the DeepLoop's reasoner and coder models.

1. Install vllm-mlx:
   ```bash
   pip install vllm-mlx
   ```

2. Download the DeepLoop models:
   ```bash
   # Reasoner: 27B dense model for planning/review (~18 GB)
   huggingface-cli download nightmedia/Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-qx64-hi-mlx

   # Coder: 80B-A3B MoE for tool-calling code generation (~42 GB, MXFP4)
   huggingface-cli download nightmedia/Qwen3-Coder-Next-mxfp4-mlx
   ```

3. Start the MLX servers using the instance manager:
   ```bash
   # Start the reasoner instance (port 8000)
   MLX_INSTANCE=reasoner MLX_PORT=8000 \
   MLX_MODEL=nightmedia/Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-qx64-hi-mlx \
   MLX_MAX_TOKENS=32768 MLX_REASONING_PARSER=qwen3 \
   ./scripts/mlx-server.sh start

   # Start the coder instance (port 8001)
   MLX_INSTANCE=coder MLX_PORT=8001 \
   MLX_MODEL=nightmedia/Qwen3-Coder-Next-mxfp4-mlx \
   MLX_MAX_TOKENS=16384 \
   ./scripts/mlx-server.sh start
   ```

4. Verify both servers:
   ```bash
   curl http://localhost:8000/health
   curl http://localhost:8001/health
   ```

5. Check status:
   ```bash
   ./scripts/mlx-server.sh status
   ```

Note: The daemon auto-starts MLX servers if they're not running (configured in `src/providers/mlx-health.ts`).

### Step 4: Configure Casterly

Edit `config/default.yaml`:

```yaml
local:
  provider: ollama
  model: qwen3.5:35b-a3b
  baseUrl: http://localhost:11434
  timeoutMs: 300000  # 5 minutes
```

Model routing is configured in `config/models.yaml`:

```yaml
models:
  primary:
    provider: ollama
    model: qwen3.5:35b-a3b
    temperature: 0.6

  fast:
    provider: ollama
    model: qwen3.5:35b-a3b
    temperature: 0.3

mlx:
  base_url: http://localhost:8000
  model: nightmedia/Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-qx64-hi-mlx
  timeout_ms: 300000

mlx_coder:
  base_url: http://localhost:8001
  model: nightmedia/Qwen3-Coder-Next-mxfp4-mlx
  timeout_ms: 600000

hardware:
  platform: mac-studio-m4-max
  memory_gb: 128
  max_concurrent_models: 3
```

### Step 5: Build and Install

```bash
npm run install:host
```

This:
1. Compiles TypeScript to JavaScript
2. Creates a symlink at `~/.local/bin/casterly`

### Step 6: Verify Installation

```bash
# Check installation
which casterly

# Test basic functionality
casterly "What is 2 + 2?"

# Test with execution
casterly "List files in current directory" --execute
```

## Running Casterly

### CLI Mode

```bash
# Basic query
casterly "What's on my schedule today?"

# With command execution enabled
casterly "Create a file called test.txt" --execute

# Development mode (without building)
npm run dev -- "Your query here"
```

### iMessage Daemon

For iMessage integration on macOS:

```bash
# Development mode (foreground, live TypeScript)
npm run imessage

# Production mode (foreground, compiled JS)
npm run imessage:start
```

The daemon:
- Polls iMessage database every 2 seconds
- Processes incoming messages
- Sends responses back via iMessage

### Tyrion Lifecycle Manager

For production use, the `tyrion.sh` script manages the daemon as a background process:

```bash
# Start the daemon (builds first, runs in background)
./scripts/tyrion.sh start       # or: npm run tyrion:start

# Stop gracefully
./scripts/tyrion.sh stop        # or: npm run tyrion:stop

# Restart (stop + start)
./scripts/tyrion.sh restart     # or: npm run tyrion:restart

# Pull latest code from main, rebuild, restart
./scripts/tyrion.sh update      # or: npm run tyrion:update

# Clear all data except contacts, restart fresh
./scripts/tyrion.sh reset       # or: npm run tyrion:reset

# Check if running, show PID/uptime/memory
./scripts/tyrion.sh status      # or: npm run tyrion:status

# Tail the daemon log
./scripts/tyrion.sh logs        # or: npm run tyrion:logs

# Show all commands
./scripts/tyrion.sh help
```

The `update` command is designed for remote development: push code via Claude Code, then text Tyrion "update" to pull, build, and restart.

### MLX Server Management

```bash
# Start individual instances
MLX_INSTANCE=reasoner ./scripts/mlx-server.sh start
MLX_INSTANCE=coder ./scripts/mlx-server.sh start

# Check status of all instances
./scripts/mlx-server.sh status

# Stop individual instances
MLX_INSTANCE=reasoner ./scripts/mlx-server.sh stop
MLX_INSTANCE=coder ./scripts/mlx-server.sh stop

# View logs
MLX_INSTANCE=reasoner ./scripts/mlx-server.sh logs
MLX_INSTANCE=coder ./scripts/mlx-server.sh logs
```

## Workspace Setup

Create personalization files in `~/.casterly/workspace/`:

```bash
mkdir -p ~/.casterly/workspace
```

### IDENTITY.md

```markdown
# Identity

Name: Casterly
Role: Personal AI assistant
```

### SOUL.md

```markdown
# Personality

You are a helpful, privacy-conscious AI assistant.

## Communication Style
- Concise and direct
- Honest about limitations
- Privacy-first mindset
```

### USER.md

```markdown
# User Profile

Name: [Your name]
Timezone: America/New_York
```

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Run in development mode |
| `npm run build` | Compile TypeScript |
| `npm run typecheck` | Type checking only |
| `npm run lint` | Run ESLint |
| `npm run test` | Run tests |
| `npm run check` | Run all quality gates |
| `npm run guardrails` | Check protected paths |
| `npm run security:scan` | Security scanning |
| `npm run imessage` | iMessage daemon (dev) |
| `npm run imessage:start` | iMessage daemon (prod) |
| `npm run tyrion:start` | Start Tyrion daemon (background) |
| `npm run tyrion:stop` | Stop Tyrion daemon |
| `npm run tyrion:restart` | Restart Tyrion daemon |
| `npm run tyrion:update` | Pull, build, restart |
| `npm run tyrion:reset` | Clear data (keep contacts), restart |
| `npm run tyrion:status` | Show daemon status |
| `npm run tyrion:logs` | Tail daemon log |
| `npm run install:host` | Build and install CLI |

## Directory Structure

After installation:

```
~/.casterly/
├── contacts.json           # Address book (preserved on reset)
├── tyrion.pid              # Daemon PID file
├── logs/                   # Daemon and update logs
│   ├── tyrion.log
│   └── update.log
├── mlx/                    # MLX server state
│   ├── reasoner.pid        # Reasoner instance PID
│   ├── coder.pid           # Coder instance PID
│   └── logs/               # Per-instance server logs
├── workspace/              # Personalization files
│   ├── IDENTITY.md
│   ├── SOUL.md
│   ├── TOOLS.md
│   └── USER.md
├── sessions/               # Conversation history
│   └── imessage/
│       └── <chat-id>.jsonl
├── memory/                 # Long-term memory
└── users.json              # Multi-user config

~/.local/bin/
└── casterly -> /path/to/casterly/dist/index.js
```

## Troubleshooting

### "command not found: casterly"

Add `~/.local/bin` to your PATH:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### "Cannot connect to Ollama"

1. Check Ollama is running:
   ```bash
   ollama serve
   ```

2. Verify the URL in config matches:
   ```bash
   curl http://localhost:11434/api/tags
   ```

### "MLX server not ready"

1. Check if the MLX servers are running:
   ```bash
   ./scripts/mlx-server.sh status
   ```

2. Start them manually:
   ```bash
   MLX_INSTANCE=reasoner ./scripts/mlx-server.sh start
   MLX_INSTANCE=coder ./scripts/mlx-server.sh start
   ```

3. Check health endpoints:
   ```bash
   curl http://localhost:8000/health
   curl http://localhost:8001/health
   ```

### "Model not found"

Pull the required models:

```bash
# FastLoop (Ollama)
ollama pull qwen3.5:35b-a3b

# DeepLoop (HuggingFace -> MLX)
huggingface-cli download nightmedia/Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-qx64-hi-mlx
huggingface-cli download nightmedia/Qwen3-Coder-Next-mxfp4-mlx
```

### "Out of memory"

With 128GB unified memory, the triple-model architecture uses ~84 GB (18 + 42 + 24 GB), leaving ~44 GB headroom. If you encounter memory issues:

1. Check what models are loaded:
   ```bash
   ollama ps
   ./scripts/mlx-server.sh status
   ```

2. Unload unused models:
   ```bash
   ollama stop <model-name>
   MLX_INSTANCE=<name> ./scripts/mlx-server.sh stop
   ```

### iMessage permissions (macOS)

Grant Full Disk Access to Terminal/iTerm:
1. System Preferences > Security & Privacy > Privacy
2. Select "Full Disk Access"
3. Add your terminal application

## Uninstall

```bash
# Remove CLI symlink
rm ~/.local/bin/casterly

# Remove user data (optional)
rm -rf ~/.casterly

# Remove repository
cd ..
rm -rf casterly
```

## Upgrading

The easiest way to upgrade is the lifecycle manager:

```bash
# One command: pull, install deps if changed, build, restart
./scripts/tyrion.sh update
```

Or manually:

```bash
# Pull latest changes
git pull origin main

# Reinstall dependencies
npm install

# Rebuild
npm run install:host

# Check for new models
ollama list
```

## Security Notes

- All inference runs locally on Mac Studio
- No data ever leaves the machine
- Logs are automatically redacted
- iMessage database access requires Full Disk Access permission

For more details, see [rulebook.md](rulebook.md) and [security-and-privacy.md](security-and-privacy.md).
