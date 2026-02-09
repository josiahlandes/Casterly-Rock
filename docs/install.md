# Casterly Installation Guide

This guide covers installation, configuration, and running Casterly.

## Prerequisites

### Required

| Requirement | Version | Purpose |
|-------------|---------|---------|
| Node.js | 18.x or later | Runtime environment |
| npm | 9.x or later | Package management |
| macOS | 12.x or later | Primary platform (for iMessage) |

### Optional (for full functionality)

| Requirement | Purpose |
|-------------|---------|
| Ollama | Local LLM provider |
| Anthropic API key | Cloud LLM provider (Claude) |

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/your-org/casterly.git
cd casterly

# 2. Install dependencies
npm install

# 3. Build and install
npm run install:host

# 4. Add to PATH (if not already)
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

# 5. Run
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

### Step 2: Configure Providers

#### Local Provider (Ollama)

1. Install Ollama from [ollama.ai](https://ollama.ai)

2. Pull a model:
   ```bash
   ollama pull qwen3:14b
   ```

3. Verify Ollama is running:
   ```bash
   curl http://localhost:11434/api/tags
   ```

#### Cloud Provider (Claude)

1. Get an API key from [console.anthropic.com](https://console.anthropic.com)

2. Set the environment variable:
   ```bash
   export ANTHROPIC_API_KEY="sk-ant-..."
   ```

   Or add to your shell profile:
   ```bash
   echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.zshrc
   ```

### Step 3: Configure Casterly

Edit `config/default.yaml`:

```yaml
local:
  provider: ollama
  model: qwen3:14b                      # Tool-capable model (~9GB RAM)
  baseUrl: http://localhost:11434
  timeoutMs: 60000

cloud:
  provider: claude
  model: claude-sonnet-4-20250514
  apiKeyEnv: ANTHROPIC_API_KEY           # Environment variable name
  timeoutMs: 45000

router:
  defaultRoute: local                    # Fallback when uncertain
  confidenceThreshold: 0.7               # Min confidence for cloud

sensitivity:
  alwaysLocal:                           # Categories that never go to cloud
    - calendar
    - finances
    - voice_memos
    - health
    - credentials
    - documents
    - contacts
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
# Basic query (routing only, no execution)
casterly "What's the weather like?"

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

### "ANTHROPIC_API_KEY not set"

Set the environment variable:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

### "Model not found"

Pull the model specified in config:

```bash
ollama pull qwen3:14b
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
```

## Security Notes

- API keys are read from environment variables, not stored in config
- Sensitive data categories route locally by default
- Logs are automatically redacted
- iMessage database access requires Full Disk Access permission

For more details, see [docs/rulebook.md](rulebook.md).
