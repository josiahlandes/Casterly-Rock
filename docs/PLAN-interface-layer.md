# Interface Layer Implementation Plan

## Overview

This document outlines the plan to implement an OpenClaw-compatible interface layer for Casterly. The interface layer sits between raw user input and the LLM prompt, handling context assembly, session management, and prompt construction.

## Research Summary: How OpenClaw Does It

### 1. Bootstrap Files (Injected into System Prompt)

OpenClaw automatically injects these workspace files at the start of each session:

| File | Purpose |
|------|---------|
| `SOUL.md` | Personality definition and behavioral boundaries |
| `AGENTS.md` | Operational guidelines and persistent memory cues |
| `TOOLS.md` | User guidance on tool usage preferences |
| `IDENTITY.md` | Agent name and character details |
| `USER.md` | User profile information |
| `BOOTSTRAP.md` | First-run setup ritual (one-time) |
| `HEARTBEAT.md` | Periodic reminders during long sessions |

Files are trimmed to a configurable limit (default 20,000 characters) and blank files are skipped.

### 2. System Prompt Assembly

OpenClaw builds the system prompt from these sections (in order):

1. **Tooling** - Available tools with descriptions
2. **Safety** - Guardrail reminders
3. **Skills** - Compact list with paths (loaded on-demand)
4. **Self-Update** - How to update the system
5. **Workspace** - Working directory reference
6. **Documentation** - Local docs path
7. **Sandbox Config** - Runtime environment info
8. **Date & Time** - Timezone and time format
9. **Reply Tags** - Provider-specific formatting
10. **Runtime Info** - Host, OS, node version, model

Three prompt modes: `full` (primary), `minimal` (sub-agents), `none` (identity only).

### 3. Message Processing Pipeline

```
Inbound message
  → Deduplication/Debouncing
  → Body Preparation (add sender name for groups)
  → Session Key Resolution
  → Queue (if agent run active)
  → Context Assembly
  → LLM Inference
  → Response Shaping
  → Outbound reply
```

### 4. Context Management

- **Context** = everything sent to model (bounded by token limit)
- **Memory** = persistent files on disk
- Automatic compaction when context fills up
- Memory flush before compaction to preserve important info

### 5. Session Isolation

- DMs can share main session or isolate per-peer
- Groups always get isolated sessions
- Sessions reset daily (configurable) or on idle timeout

---

## Implementation Plan for Casterly

### Phase 1: Bootstrap Files System

Create support for workspace files that get injected into the system prompt.

**Files to create:**
- `src/interface/bootstrap.ts` - Load and trim bootstrap files
- `~/.casterly/workspace/SOUL.md` - Default personality
- `~/.casterly/workspace/TOOLS.md` - Tool usage guidelines

**Behavior:**
```typescript
interface BootstrapConfig {
  maxFileSize: number;  // Default 20000 characters
  files: string[];      // ['SOUL.md', 'TOOLS.md', 'IDENTITY.md', 'USER.md']
}

function loadBootstrapFiles(workspacePath: string, config: BootstrapConfig): string
```

### Phase 2: System Prompt Builder

Create a structured prompt builder that assembles all sections.

**File to create:**
- `src/interface/prompt-builder.ts`

**Sections to include:**
1. Identity (from IDENTITY.md or config)
2. Personality (from SOUL.md)
3. Capabilities (what Tyrion can do)
4. Tools (from TOOLS.md + skill list)
5. Skills (compact list with load instructions)
6. Safety (guardrails)
7. Context (date, time, timezone)
8. Guidelines (response formatting for iMessage)

**Interface:**
```typescript
interface PromptBuilderOptions {
  mode: 'full' | 'minimal' | 'none';
  skills: Skill[];
  timezone?: string;
  channel: 'imessage' | 'cli' | 'web';
}

function buildSystemPrompt(options: PromptBuilderOptions): string
```

### Phase 3: Session Management

Add persistent session storage and history management.

**Files to create:**
- `src/interface/session.ts` - Session state management
- `src/interface/history.ts` - Conversation history

**Session storage:**
```
~/.casterly/sessions/
  imessage/
    <chat-id>.jsonl     # Conversation transcript
  cli/
    main.jsonl
```

**Features:**
- Per-chat session isolation for iMessage
- History trimming when context fills
- Daily session reset option
- Memory flush before compaction

### Phase 4: Context Assembly

Combine all pieces into the final context sent to the LLM.

**File to create:**
- `src/interface/context.ts`

**Context structure:**
```
[System Prompt]
  - Identity
  - Personality (SOUL.md)
  - Capabilities
  - Tools & Skills
  - Safety
  - Runtime info

[Conversation History]
  - Previous messages (trimmed to fit)

[Current Message]
  - User input (with sender name for group chats)
```

### Phase 5: Message Processing Pipeline

Update the daemon to use the new interface layer.

**Changes to `src/imessage/daemon.ts`:**
1. Load bootstrap files on startup
2. Resolve session for each incoming message
3. Build context using prompt builder
4. Trim history if needed
5. Execute agent loop
6. Save response to session transcript

---

## Default SOUL.md for Tyrion

```markdown
# Tyrion

You are Tyrion, a helpful AI assistant running locally on a Mac Mini.

## Personality
- Concise and conversational - this is a text message, not an essay
- Direct and practical, never verbose
- Helpful but not sycophantic
- Honest about limitations

## Communication Style
- Keep responses brief for simple questions
- For tasks, explain what you're doing concisely
- If unsure, say so rather than guessing

## Privacy
You run locally. Sensitive data (calendar, finances, health) stays on device.

## Safety
- If a command might be destructive, ask for confirmation
- Never execute commands you don't understand
- Respect the user's data and privacy
```

---

## File Structure After Implementation

```
src/
  interface/
    index.ts           # Public exports
    bootstrap.ts       # Bootstrap file loader
    prompt-builder.ts  # System prompt assembly
    session.ts         # Session management
    history.ts         # Conversation history
    context.ts         # Context assembly

~/.casterly/
  workspace/
    SOUL.md            # Personality
    TOOLS.md           # Tool guidelines
    IDENTITY.md        # Agent identity
    USER.md            # User info
  sessions/
    imessage/
      <chat-id>.jsonl
```

---

## Migration Path

1. **Phase 1-2**: Can be implemented without breaking existing daemon
2. **Phase 3-5**: Requires updating daemon.ts to use new interface
3. **Backwards compatible**: Old system prompt in daemon still works during transition

---

## Questions for Review

1. **Session isolation**: Should each iMessage chat have its own session, or share one main session?
   - OpenClaw default: DMs share main session
   - Recommendation: Start with shared, add per-chat option later

2. **Memory persistence**: Do we want the memory flush before compaction?
   - This would require implementing `memory/YYYY-MM-DD.md` files
   - Can defer to later if not needed immediately

3. **Bootstrap file locations**:
   - OpenClaw uses `~/.openclaw/workspace/`
   - Should we use `~/.casterly/workspace/` or somewhere else?

4. **Session reset policy**:
   - Daily reset at 4 AM?
   - Idle timeout?
   - Manual only via command?

---

## Estimated Scope

| Phase | Files | Complexity |
|-------|-------|------------|
| 1 | 2-3 | Low |
| 2 | 1-2 | Medium |
| 3 | 2-3 | Medium |
| 4 | 1-2 | Low |
| 5 | 1 (modify) | Medium |

Total: ~8-10 new files, 1 modified file

---

## Next Steps

After approval:
1. Implement Phase 1 (bootstrap files)
2. Create default SOUL.md
3. Implement Phase 2 (prompt builder)
4. Test with existing daemon
5. Implement Phases 3-5
6. Update daemon to use new interface
7. Test end-to-end
