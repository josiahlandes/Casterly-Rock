# Casterly Hybrid Implementation Plan

## Overview

A hybrid LLM system where a **fast local model** (running on M4 Mac Mini with 16GB) serves as both:
1. **Intelligent Router** - Decides if a request is sensitive or needs frontier capability
2. **Privacy Handler** - Processes all sensitive data locally (calendar, finances, voice memos, etc.)

Cloud APIs (Claude, Grok, GPT, Gemini, etc.) are only called when bleeding-edge capability is needed - saving money while keeping private data at home.

---

## Architecture

```
User Request
     │
     ▼
┌─────────────────────────────────────┐
│     LOCAL LLM (Ollama + Qwen 7B)    │
│                                     │
│  1. Classify: Sensitive or Complex? │
│  2. If sensitive → Handle locally   │
│  3. If complex → Forward to cloud   │
└─────────────────────────────────────┘
           │                │
    [Sensitive]        [Complex/SOTA needed]
           │                │
           ▼                ▼
    ┌───────────┐    ┌─────────────────┐
    │  LOCAL    │    │  CLOUD ROUTER   │
    │  RESPONSE │    │  Pick best API: │
    │           │    │  - Claude       │
    │ Calendar  │    │  - Grok         │
    │ Finances  │    │  - GPT          │
    │ Voice     │    │  - Gemini       │
    │ memos     │    │  (configurable) │
    └───────────┘    └─────────────────┘
```

---

## Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Language | TypeScript/Node.js | Strong typing, async/await, rich ecosystem |
| Local LLM Server | Ollama | REST API, headless, request batching |
| Local Model | Qwen 2.5 7B (Q4_K_M) | Best balance of speed/capability for 16GB |
| Cloud Providers | Multi-provider | Anthropic, OpenAI, Google, xAI SDKs |
| Config | YAML + Zod | Type-safe configuration |
| Testing | Vitest | Fast, TypeScript-native |

---

## Project Structure

```
Casterly/
├── src/
│   ├── index.ts                 # Entry point
│   ├── config/
│   │   ├── index.ts             # Config loader
│   │   └── schema.ts            # Zod schemas
│   │
│   ├── router/
│   │   ├── index.ts             # Main router
│   │   ├── classifier.ts        # Local LLM classification
│   │   └── patterns.ts          # Regex fallback patterns
│   │
│   ├── providers/
│   │   ├── base.ts              # Abstract interface
│   │   ├── ollama.ts            # Local (Ollama)
│   │   ├── claude.ts            # Anthropic
│   │   ├── openai.ts            # OpenAI/GPT
│   │   ├── google.ts            # Gemini
│   │   └── xai.ts               # Grok
│   │
│   ├── security/
│   │   ├── detector.ts          # Sensitive data detection
│   │   └── redactor.ts          # Log redaction
│   │
│   ├── interfaces/
│   │   └── cli.ts               # CLI interface
│   │
│   └── logging/
│       └── safe-logger.ts       # Privacy-aware logging
│
├── config/
│   └── default.yaml             # Default configuration
├── scripts/
│   └── setup-ollama.sh          # Ollama setup helper
├── tests/
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Core Components

### 1. Router (Local LLM as Brain)

The local LLM makes routing decisions using a structured prompt:

```typescript
// src/router/classifier.ts
const ROUTER_PROMPT = `You are a privacy-aware router. Analyze this request and decide:

ROUTE TO LOCAL if the request involves:
- Personal calendar, schedule, appointments
- Financial data (bank, budget, transactions)
- Voice memos, personal notes, journals
- Health/medical information
- Passwords, credentials, API keys
- Private documents, contracts
- Personal relationships, contacts
- Anything the user wouldn't want a company to see

ROUTE TO CLOUD if the request:
- Requires cutting-edge reasoning/coding
- Needs web search or current information
- Is general knowledge with no private data
- Involves public/non-sensitive topics

Respond with JSON:
{
  "route": "local" | "cloud",
  "reason": "brief explanation",
  "confidence": 0.0-1.0
}`;
```

### 2. Multi-Cloud Provider Selection

```typescript
// src/providers/index.ts
interface CloudProviderConfig {
  claude?: { apiKey: string; model: string };
  openai?: { apiKey: string; model: string };
  google?: { apiKey: string; model: string };
  xai?: { apiKey: string; model: string };
}

// User configures which cloud providers are available
// and optionally sets a preferred one or lets the system pick
```

### 3. Sensitive Data Patterns (Fast Fallback)

Before LLM routing, quick regex patterns catch obvious sensitive data:

```typescript
const SENSITIVE_PATTERNS = {
  financial: [/\b\d{3}-\d{2}-\d{4}\b/, /credit card/i, /bank account/i],
  credentials: [/password/i, /api[_-]?key/i, /Bearer \w+/],
  calendar: [/my calendar/i, /schedule/i, /appointment/i],
  health: [/diagnosis/i, /prescription/i, /medical/i],
};
```

---

## Configuration

```yaml
# config/default.yaml
local:
  provider: ollama
  model: llama3.1:8b-instruct-q4_K_M
  baseUrl: http://localhost:11434

cloud:
  provider: claude
  model: claude-sonnet-4-20250514
  # Future: add openai, google, xai providers

router:
  # Bias toward privacy - when in doubt, stay local
  defaultRoute: local
  confidenceThreshold: 0.7

sensitivity:
  # Categories that ALWAYS stay local
  alwaysLocal:
    - calendar
    - finances
    - voice_memos
    - health
    - credentials
```

---

## Implementation Phases

### Phase 1: Foundation
- [ ] Initialize TypeScript project with dependencies
- [ ] Implement Ollama provider (local LLM)
- [ ] Implement Claude provider (cloud)
- [ ] Basic CLI interface
- [ ] Simple keyword-based routing

### Phase 2: Smart Routing
- [ ] LLM-based classification using local model
- [ ] Regex pattern fallback layer
- [ ] Confidence scoring and thresholds
- [ ] Privacy-safe logging with redaction

### Phase 3: Polish
- [ ] Conversation context management
- [ ] Streaming responses
- [ ] Error handling and fallbacks
- [ ] Health checks and monitoring

### Future: Multi-Cloud (optional)
- [ ] Add OpenAI/GPT provider
- [ ] Add Google/Gemini provider
- [ ] Add xAI/Grok provider
- [ ] Provider selection logic

---

## Local LLM Setup (Ollama on M4 Mac Mini)

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull the model (~5-6GB download, varies by build)
ollama pull llama3.1:8b-instruct-q4_K_M

# Verify it works
ollama run llama3.1:8b-instruct-q4_K_M "Hello, are you running locally?"
```

**Memory Budget (16GB):**
- macOS + apps: ~4-6GB
- Llama 3.1 8B Q4: ~5-6GB (approx)
- Headroom for context: ~5-6GB
- Result: Comfortable fit with room for other apps

---

## Verification Plan

1. **Test routing accuracy:**
   - Send "What's on my calendar tomorrow?" → Should route LOCAL
   - Send "Explain quantum computing" → Should route CLOUD
   - Send "My SSN is 123-45-6789" → Should route LOCAL (pattern match)

2. **Test privacy:**
   - Verify sensitive content never appears in logs
   - Confirm local requests don't hit any network endpoints

3. **Test cloud fallback:**
   - Disable one cloud provider, verify system uses another
   - Test with various provider configurations

---

## Critical Files to Implement

1. **src/router/classifier.ts** - Local LLM routing logic (security-critical)
2. **src/providers/ollama.ts** - Local LLM client
3. **src/providers/claude.ts** - Claude API client
4. **src/security/detector.ts** - Pattern matching for sensitive data
5. **src/config/schema.ts** - Configuration validation
