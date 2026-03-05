# Casterly Error Code System

Comprehensive error handling with structured codes, user-friendly messages, and actionable suggestions.

## Overview

The error system replaces generic error messages like "Sorry, I encountered an error" with specific, actionable information:

```
Before: "Sorry, I encountered an error processing your message."

After:  "Error E101: Ollama service not running. Start Ollama with: ollama serve"
```

## Error Code Structure

Each error has:

| Field | Description |
|-------|-------------|
| `code` | Unique identifier (e.g., E101) |
| `category` | Error category (Provider, Router, Tools, etc.) |
| `message` | Human-readable description |
| `suggestion` | Actionable fix instructions |
| `severity` | `warning`, `error`, or `critical` |

## Error Code Categories

```
E1xx - Provider errors (Ollama local only)
E3xx - Tool execution errors
E4xx - Configuration errors
E5xx - Network errors
E6xx - Security/Safety errors
E7xx - Session errors
E8xx - Memory errors
E9xx - Skill errors
```

> **Mac Studio Edition**: All inference is local. Cloud-related errors (E110-E115) and router errors (E2xx) are not used.

---

## Complete Error Code Reference

### E1xx - Provider Errors

Errors related to the Ollama provider (local only).

#### E100 - No providers available
```
Message:    No providers available
Suggestion: Check that Ollama is running: ollama serve
Severity:   critical
```

**Cause:** Ollama provider could not be initialized.

**Resolution:**
1. Start Ollama: `ollama serve`
2. Verify it's running: `curl http://localhost:11434/api/tags`

---

#### E101 - Ollama service not running
```
Message:    Ollama service not running
Suggestion: Start Ollama with: ollama serve
Severity:   error
```

**Cause:** Connection to Ollama failed (usually ECONNREFUSED on localhost:11434).

**Resolution:**
```bash
# Check if Ollama is running
curl http://localhost:11434/api/tags

# If not, start it
ollama serve

# Or on macOS, open the Ollama app
```

---

#### E102 - Ollama model not found
```
Message:    Ollama model not found
Suggestion: Pull the model with: ollama pull qwen3:14b
Severity:   error
```

**Cause:** The configured model isn't available in Ollama.

**Resolution:**
```bash
# List available models
ollama list

# Pull the required model
ollama pull qwen3:14b

# Or pull a smaller model
ollama pull llama3.1:8b
```

---

#### E103 - Ollama request timeout
```
Message:    Ollama request timeout
Suggestion: Model may be loading or system is under heavy load. Try again in a moment.
Severity:   warning
```

**Cause:** Request exceeded the configured timeout (default 60s).

**Resolution:**
- Wait for model to finish loading (first request after startup is slow)
- Increase `timeoutMs` in config/default.yaml
- Use a smaller model
- Close other applications to free RAM

---

#### E104 - Ollama out of memory
```
Message:    Ollama out of memory
Suggestion: Try a smaller model (llama3.1:8b) or close other applications
Severity:   error
```

**Cause:** Not enough RAM to load the model.

**Resolution:**
1. Check memory usage: `top` or Activity Monitor
2. Close memory-heavy applications
3. Use a smaller model:
   ```yaml
   # config/default.yaml
   local:
     model: llama3.1:8b  # Instead of qwen3:14b
   ```

---

#### E120 - Provider returned empty response
```
Message:    Provider returned empty response
Suggestion: Model may have failed silently. Try rephrasing your request.
Severity:   error
```

**Cause:** Model returned no content.

**Resolution:**
- Rephrase the question
- Check if model is overloaded
- Try a different model

---

#### E121 - Provider returned invalid response
```
Message:    Provider returned invalid response
Suggestion: Unexpected response format. This may be a bug.
Severity:   error
```

**Cause:** Response couldn't be parsed.

**Resolution:**
- Try again
- If persistent, check logs and report issue

---

### E3xx - Tool Execution Errors

Errors when running bash commands or other tools.

#### E300 - Tool execution failed
```
Message:    Tool execution failed
Suggestion: A command failed to run. Check the command syntax.
Severity:   error
```

**Cause:** Command returned non-zero exit code.

**Resolution:**
- Check the command syntax
- Verify required files/directories exist

---

#### E301 - Tool not found
```
Message:    Tool not found
Suggestion: Requested tool is not registered.
Severity:   error
```

**Cause:** Model called a tool that doesn't exist.

**Resolution:**
- This usually indicates a model error
- Try rephrasing the request

---

#### E302 - Tool timeout
```
Message:    Tool timeout
Suggestion: Command took too long. It may still be running in background.
Severity:   warning
```

**Cause:** Command exceeded timeout.

**Resolution:**
- Check if command is still running: `ps aux | grep <command>`
- Kill if needed: `pkill <command>`

---

#### E303 - Too many tool iterations
```
Message:    Too many tool iterations
Suggestion: Reached max tool calls (5). Task may be too complex.
Severity:   warning
```

**Cause:** Model kept calling tools beyond the limit.

**Resolution:**
- Break task into smaller steps
- Increase `maxIterations` in config (carefully)

---

#### E304 - Invalid tool call from model
```
Message:    Invalid tool call from model
Suggestion: Model returned malformed tool call. Try rephrasing.
Severity:   error
```

**Cause:** Tool call couldn't be parsed.

**Resolution:**
- Rephrase the request
- May indicate model doesn't fully support tool use

---

#### E305 - Tool returned error
```
Message:    Tool returned error
Suggestion: Command ran but returned an error. Check the output.
Severity:   warning
```

**Cause:** Tool executed but reported an error.

**Resolution:**
- Check the error output for details
- Fix the underlying issue

---

### E4xx - Configuration Errors

Errors in configuration files.

#### E400 - Configuration file not found
```
Message:    Configuration file not found
Suggestion: Create config/default.yaml or copy from config/default.yaml.example
Severity:   critical
```

**Resolution:**
```bash
cp config/default.yaml.example config/default.yaml
```

---

#### E401 - Invalid configuration
```
Message:    Invalid configuration
Suggestion: Config file has syntax errors. Check YAML formatting.
Severity:   critical
```

**Resolution:**
- Use a YAML validator
- Check for tabs (use spaces instead)
- Verify indentation

---

#### E402 - Missing required config field
```
Message:    Missing required config field
Suggestion: A required configuration field is missing.
Severity:   error
```

---

#### E403 - Invalid config value
```
Message:    Invalid config value
Suggestion: A configuration value is invalid or out of range.
Severity:   error
```

---

### E5xx - Network Errors

General network connectivity issues.

#### E500 - Connection refused
```
Message:    Connection refused
Suggestion: Service not listening. Check if Ollama/API server is running.
Severity:   error
```

**Resolution:**
- Check target service is running
- Verify port is correct
- Check firewall settings

---

#### E501 - Connection timeout
```
Message:    Connection timeout
Suggestion: Network request timed out. Check your connection.
Severity:   error
```

---

#### E502 - DNS resolution failed
```
Message:    DNS resolution failed
Suggestion: Could not resolve hostname. Check network connection.
Severity:   error
```

---

#### E503 - SSL/TLS error
```
Message:    SSL/TLS error
Suggestion: Secure connection failed. Check certificates.
Severity:   error
```

---

#### E504 - Network unreachable
```
Message:    Network unreachable
Suggestion: No network connection. Check WiFi/Ethernet.
Severity:   error
```

---

### E6xx - Security/Safety Errors

Security and safety gate errors.

#### E600 - Command blocked by safety filter
```
Message:    Command blocked by safety filter
Suggestion: This command is not allowed for safety reasons.
Severity:   warning
```

**Cause:** Command matched a blocked pattern (rm -rf /, fork bomb, etc.)

**Resolution:**
- Command was blocked intentionally
- If legitimate, modify the safety patterns in config

---

#### E601 - Command requires approval
```
Message:    Command requires approval
Suggestion: This action needs explicit confirmation.
Severity:   warning
```

---

#### E602 - Sensitive data detected in output
```
Message:    Sensitive data detected in output
Suggestion: Response contained sensitive data that was redacted.
Severity:   warning
```

---

#### E603 - Permission denied
```
Message:    Permission denied
Suggestion: Insufficient permissions for this operation.
Severity:   error
```

---

### E7xx - Session Errors

Conversation session issues.

#### E700 - Session not found
```
Message:    Session not found
Suggestion: Session may have expired or been cleared.
Severity:   warning
```

---

#### E701 - Session file corrupted
```
Message:    Session file corrupted
Suggestion: Session history could not be loaded. Starting fresh.
Severity:   warning
```

**Resolution:**
```bash
# Remove corrupted session file
rm ~/.casterly/sessions/imessage/*.jsonl
```

---

#### E702 - Failed to save session
```
Message:    Failed to save session
Suggestion: Could not write session file. Check disk space and permissions.
Severity:   error
```

---

### E8xx - Memory Errors

Long-term memory system issues.

#### E800 - Memory file not found
```
Message:    Memory file not found
Suggestion: MEMORY.md does not exist yet. It will be created when needed.
Severity:   warning
```

---

#### E801 - Failed to write memory
```
Message:    Failed to write memory
Suggestion: Could not save to memory file. Check disk space and permissions.
Severity:   error
```

---

#### E802 - Memory file corrupted
```
Message:    Memory file corrupted
Suggestion: Memory file could not be parsed. May need manual review.
Severity:   warning
```

---

### E9xx - Skill Errors

Skill loading and execution issues.

#### E900 - Skill not available
```
Message:    Skill not available
Suggestion: Required binary or environment variable not found.
Severity:   warning
```

**Resolution:**
- Check skill requirements in SKILL.md
- Install required binaries
- Set required environment variables

---

#### E901 - Skill file invalid
```
Message:    Skill file invalid
Suggestion: SKILL.md has syntax errors in frontmatter.
Severity:   error
```

---

#### E902 - Skill tool schema invalid
```
Message:    Skill tool schema invalid
Suggestion: Tool definition in skill has invalid schema.
Severity:   error
```

---

## Implementation Details

### Core Classes and Functions

#### `CasterlyError` Class

```typescript
import { CasterlyError, createError } from './errors/index.js';

// Create error by code
const error = createError('E101', {
  port: 11434,
  host: 'localhost'
});

// Error properties
error.code;        // "E101"
error.category;    // "Provider"
error.message;     // "Ollama service not running"
error.suggestion;  // "Start Ollama with: ollama serve"
error.severity;    // "error"
error.details;     // { port: 11434, host: 'localhost' }
error.timestamp;   // "2024-01-15T10:30:00.000Z"
```

#### `wrapError()` - Auto-detect Error Type

```typescript
import { wrapError } from './errors/index.js';

try {
  await fetch('http://localhost:11434/api/chat');
} catch (error) {
  // Automatically detects error type from message
  const casterlyError = wrapError(error);
  // If message contains "connection refused" → E500
  // If message contains "timeout" → E501
  // If message contains "billing" → E112
  // etc.
}
```

Detection patterns:
| Pattern in message | Error Code |
|-------------------|------------|
| `econnrefused`, `connection refused` | E500 |
| `timeout`, `timed out` | E501 |
| `enotfound`, `getaddrinfo` | E502 |
| `billing`, `payment`, `credit` | E112 |
| `rate limit`, `too many requests` | E113 |
| `unauthorized`, `invalid api key` | E111 |
| `model.*not found` | E102 |
| `out of memory`, `oom` | E104 |

#### `formatErrorForUser()` - Format for Display

```typescript
import { formatErrorForUser } from './errors/index.js';

const error = createError('E101');

// For iMessage (concise)
formatErrorForUser(error, 'imessage');
// → "Error E101: Ollama service not running. Start Ollama with: ollama serve"

// For CLI (full format)
formatErrorForUser(error, 'cli');
// → "[E101] Ollama service not running\n→ Start Ollama with: ollama serve"

// For HTTP API (JSON)
formatErrorForUser(error, 'http');
// → '{"code":"E101","category":"Provider",...}'
```

#### Helper Functions

```typescript
import {
  isRecoverable,
  shouldRetry,
  getErrorDefinition,
  listErrorsByCategory
} from './errors/index.js';

// Check if error is just a warning
isRecoverable(error);  // true if severity === 'warning'

// Check if request should be retried
shouldRetry(error);    // true for E103, E113, E115, E302, E501

// Get error definition
getErrorDefinition('E101');
// → { code: 'E101', category: 'Provider', message: '...', ... }

// List all provider errors
listErrorsByCategory('Provider');
// → [E100, E101, E102, ...]
```

### Integration in Daemon

The iMessage daemon catches errors and converts them:

```typescript
// src/imessage/daemon.ts

import { wrapError, formatErrorForUser } from '../errors/index.js';

try {
  const response = await processMessage(message);
  sendMessage(sender, response);
} catch (error) {
  // Convert to CasterlyError
  const casterlyError = wrapError(error);

  // Log with full details
  safeLogger.error('Failed to generate response', {
    code: casterlyError.code,
    category: casterlyError.category,
    message: casterlyError.message,
    details: casterlyError.details,
  });

  // Send user-friendly message
  const errorMessage = formatErrorForUser(casterlyError, 'imessage');
  sendMessage(sender, errorMessage);
}
```

### Adding New Error Codes

1. Add to `src/errors/codes.ts`:

```typescript
export const ERROR_CODES: Record<string, ErrorDefinition> = {
  // ... existing codes ...

  E199: {
    code: 'E199',
    category: 'Provider',
    message: 'Your new error message',
    suggestion: 'How to fix it',
    severity: 'error',
  },
};
```

2. Optionally add auto-detection in `wrapError()`:

```typescript
if (message.includes('your pattern')) {
  return createError('E199', { originalMessage }, originalError);
}
```

3. Document in this file under the appropriate category.

---

## Quick Reference Card

### Most Common Errors

| Code | Issue | Quick Fix |
|------|-------|-----------|
| **E101** | Ollama not running | `ollama serve` |
| **E102** | Model not found | `ollama pull qwen3:14b` |
| **E103** | Timeout | Wait, retry, or use smaller model |
| **E104** | Out of memory | Close apps or use smaller model |
| **E112** | Claude billing | Check console.anthropic.com |
| **E113** | Rate limited | Wait 30-60 seconds |
| **E500** | Connection refused | Start the target service |
| **E600** | Command blocked | Command blocked for safety |

### Severity Levels

| Level | Meaning | User Impact |
|-------|---------|-------------|
| `warning` | Non-fatal, recovered | Request may have been modified |
| `error` | Failed but retryable | Request failed, can retry |
| `critical` | System unusable | Casterly cannot function |

### Log Locations

```
~/.casterly/logs/tyrion.log     # Main daemon log
~/.casterly/logs/update.log     # Self-update log
```

---

## Troubleshooting Flowchart

```
Error received
     │
     ├── E1xx (Provider)?
     │   ├── E101/E102 → Check Ollama
     │   ├── E110/E111 → Check API key
     │   └── E112/E113 → Check billing/limits
     │
     ├── E3xx (Tools)?
     │   ├── E300/E305 → Check command output
     │   └── E303 → Simplify task
     │
     ├── E5xx (Network)?
     │   ├── E500 → Start target service
     │   └── E501/E504 → Check network
     │
     └── E6xx (Security)?
         └── E600 → Command intentionally blocked
```
