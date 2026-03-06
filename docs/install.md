# Casterly Installation Guide

This guide covers installation, configuration, and running Casterly on Mac Studio M4 Max.

## Prerequisites

### Required

| Requirement | Version | Purpose |
|-------------|---------|---------|
| Node.js | 18.x or later | Runtime environment |
| npm | 9.x or later | Package management |
| macOS | 12.x or later | Primary platform (for iMessage) |
| Ollama | Latest | Local LLM provider |

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

# 3. Set up Ollama models
ollama pull qwen3.5:122b
ollama pull qwen3.5:35b-a3b

# 4. Build and install
npm run install:host

# 5. Add to PATH (if not already)
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

# 6. Run
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

### Step 2: Set Up Ollama

1. Install Ollama from [ollama.ai](https://ollama.ai)

2. Pull the required models:
   ```bash
   # DeepLoop: reasoning, planning, and code generation (~81 GB)
   ollama pull qwen3.5:122b

   # FastLoop: triage, review, acknowledgment (~24 GB, MoE: 35B total, 3B active)
   ollama pull qwen3.5:35b-a3b
   ```

3. Verify Ollama is running:
   ```bash
   curl http://localhost:11434/api/tags
   ```

4. Check models are available:
   ```bash
   ollama list
   ```

### Step 3: Configure Casterly

Edit `config/default.yaml`:

```yaml
local:
  provider: ollama
  model: qwen3.5:122b
  baseUrl: http://localhost:11434
  timeoutMs: 300000  # 5 minutes for 122B models
```

Model routing is configured in `config/models.yaml`:

```yaml
models:
  primary:
    provider: ollama
    model: qwen3.5:122b
    temperature: 0.6

  fast:
    provider: ollama
    model: qwen3.5:35b-a3b
    temperature: 0.3

hardware:
  platform: mac-studio-m4-max
  memory_gb: 128
  max_concurrent_models: 2
```

### Step 4: Build and Install

```bash
npm run install:host
```

This:
1. Compiles TypeScript to JavaScript
2. Creates a symlink at `~/.local/bin/casterly`

### Step 5: Verify Installation

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

### "Model not found"

Pull the required models:

```bash
ollama pull qwen3.5:122b
ollama pull qwen3.5:35b-a3b
```

### "Out of memory"

With 128GB unified memory, the two-model architecture uses ~105 GB (81 GB + 24 GB), leaving ~23 GB headroom. If you encounter memory issues:

1. Check what models are loaded:
   ```bash
   ollama ps
   ```

2. Unload unused models:
   ```bash
   ollama stop <model-name>
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
