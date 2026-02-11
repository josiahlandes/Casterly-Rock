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
ollama pull hermes3:70b
ollama pull qwen3-coder-next:latest

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
   # Primary model for general tasks
   ollama pull hermes3:70b

   # Coding model
   ollama pull qwen3-coder-next:latest
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
  model: hermes3:70b
  baseUrl: http://localhost:11434
  timeoutMs: 300000  # 5 minutes for 70B models
```

Model routing is configured in `config/models.yaml`:

```yaml
models:
  coding:
    provider: ollama
    model: qwen3-coder-next:latest
    temperature: 0.1

  primary:
    provider: ollama
    model: hermes3:70b
    temperature: 0.7

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
# Development mode
npm run imessage

# Production mode
npm run imessage:start
```

The daemon:
- Polls iMessage database every 2 seconds
- Processes incoming messages
- Sends responses back via iMessage

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
| `npm run install:host` | Build and install CLI |

## Directory Structure

After installation:

```
~/.casterly/
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
ollama pull hermes3:70b
ollama pull qwen3-coder-next:latest
```

### "Out of memory"

With 128GB unified memory, you should be able to run two 70B models simultaneously. If you encounter memory issues:

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

For more details, see [docs/rulebook.md](rulebook.md).
