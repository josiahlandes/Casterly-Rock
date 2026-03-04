# Qwen Code vs Casterly DeepLoop — Coding Agent Comparison

> **Purpose:** Evaluate how Qwen's official coding agent (Qwen Code + Qwen3-Coder)
> handles context, task decomposition, and multi-step workflows, and identify
> techniques we can adopt or improve upon in our DeepLoop coding pipeline.
>
> **Date:** 2026-03-04

---

## 1. Origins & Architecture

| Dimension | Qwen Code | Casterly DeepLoop |
|---|---|---|
| **Lineage** | Fork of Gemini CLI, adapted with custom prompts and Qwen3-Coder function calling | Custom dual-loop built from scratch for local-first inference |
| **Model coupling** | Co-evolved with Qwen3-Coder; prompts + model trained together | Model-agnostic within Qwen family (currently qwen3.5:122b via Ollama) |
| **Architecture** | Single agentic loop with subagent delegation | Two-loop: FastLoop (35B triage) + DeepLoop (122B reasoning/coding) |
| **Execution** | Cloud API or local via vLLM/SGLang | Local-only via Ollama or MLX, always-hot in VRAM |

**Key insight:** Qwen Code benefits from model-agent co-training — the Qwen3-Coder model
was RL-trained specifically for multi-turn tool use with the exact tool schemas Qwen Code
presents. Our DeepLoop uses general-purpose Qwen3.5 models that weren't agentic-RL-trained.

---

## 2. Tool Calling Format

### Qwen3-Coder: Custom XML

Qwen3-Coder uses a **non-standard XML format** designed specifically for coding:

```xml
<tool_call>
<function=read_file>
<parameter=file_path>
src/main.ts
</parameter>
<parameter=offset>
0
</parameter>
</function>
</tool_call>
```

- Requires dedicated parsers in vLLM (`qwen3_coder` or `qwen3_xml`) and SGLang
- The 30B model can be unreliable — frequently omits the `<tool_call>` tag
- With 5+ tools, the model may emit XML in the content field instead of structured tool_calls
- **Non-thinking mode only** — no `<think></think>` blocks, optimized for direct action

### Casterly DeepLoop: Standard Ollama JSON

Our system uses Ollama's built-in function calling (OpenAI-compatible JSON):
- More portable across model versions
- Qwen3.5 uses Hermes-style JSON in `<tool_call>` tags
- Our OllamaProvider already handles XML retry (3 attempts with temperature bump)
- We support `think: true/false` toggle per-call

**Comparison:** Qwen3-Coder's custom XML was designed for the model's training distribution,
giving it higher reliability on the trained format. However, it's fragile outside that exact
format and breaks on many third-party platforms. Our JSON approach is more robust but
doesn't benefit from format-specific RL training.

---

## 3. Tool Set

| Tool | Qwen Code | Casterly DeepLoop |
|---|---|---|
| **Read file** | `read_file` (2000-line truncation, pagination, images, PDFs) | ReAct loop reads via Ollama tool calls |
| **Read many** | `read_many_files` (glob patterns, batch read) | Not yet — single file reads |
| **Write file** | `write_file` (with approval gate) | Tool call within ReAct loop |
| **Edit file** | `edit` (targeted modifications) | Tool call within ReAct loop |
| **Search content** | `grep_search` (pattern matching) | Tool call within ReAct loop |
| **Find files** | `glob` (file pattern matching) | Tool call within ReAct loop |
| **List directory** | `list_directory` | Tool call within ReAct loop |
| **Shell command** | `run_shell_command` (sandboxed) | Tool call within ReAct loop |
| **Web fetch** | `web_fetch` | Not available (local-first) |
| **Web search** | `web_search` | Not available (local-first) |
| **Memory** | `save_memory` (cross-session persistence) | MEMORY.md + dream cycles |
| **Todo/tasks** | `todo_write` → `.qwen/todo.md` | TaskBoard with ownership protocol |
| **Delegation** | `task` → subagent spawn | FastLoop ↔ DeepLoop handoff |
| **Plan exit** | `exit_plan_mode` | Not yet — no explicit plan mode |

### Notable Qwen Code tools we lack:

1. **`read_many_files`** — batch file reading with glob patterns. Our DeepLoop reads
   files one at a time, which wastes turns and context on individual tool calls.
2. **Explicit plan mode tools** — `exit_plan_mode` creates a formal gate between
   exploration (read-only) and implementation (write-enabled). We implicitly plan
   within the ReAct loop but don't enforce a read-only phase.
3. **Cross-session memory** — `save_memory` persists insights for future sessions.
   We have MEMORY.md but it's dream-cycle driven, not agent-invocable mid-session.

---

## 4. Context Window Management

### Qwen Code

| Strategy | Details |
|---|---|
| **Native window** | 256K tokens (Qwen3-Coder-480B), extensible to 1M via YaRN |
| **Simple context folding** | Once cumulative tool response length hits a threshold, earlier tool responses are pruned |
| **`/compress` command** | User-triggered conversation history compression |
| **SubAgent isolation** | Each subagent gets its own context window; only a summary returns to the main conversation |
| **File references** | `@filename` syntax loads file contents on demand rather than pre-loading |
| **Recommended minimum** | 128K tokens to preserve thinking capabilities |

### Casterly DeepLoop

| Strategy | Details |
|---|---|
| **Native window** | 262K tokens (qwen3.5:122b via Ollama) |
| **Three-tier allocation** | compact (8K) / standard (24K) / extended (262K) per task complexity |
| **Context pressure monitoring** | Soft warning at 70%, prompt compression at 80%, hard warning at 85% |
| **Prompt compression** | Drops middle conversation sections, preserving first 2 + last 3 turns |
| **Measurement-based sizing** | Coder dispatch measures actual char count + response buffer to select tier |
| **FastLoop isolation** | Triage runs in compact (4K) context, separate from DeepLoop's window |

### Comparison

Qwen Code takes a **reactive** approach — use the full 256K window, prune when it fills up.
Our system takes a **proactive** approach — pre-allocate context based on task complexity,
monitor pressure continuously, and compress before hitting limits.

**Qwen Code advantages:**
- Larger effective window (256K–1M) since they target cloud APIs
- SubAgent context isolation is more flexible than our two-loop split
- On-demand file loading (`@filename`) is more efficient than pre-loading

**Casterly advantages:**
- Proactive tier selection prevents context waste on simple tasks
- Pressure monitoring catches runaway context before it degrades output quality
- Measurement-based coder tier selection is more precise than fixed thresholds

**What we should adopt:**
- Batch file reading (read_many_files equivalent) to reduce turn count
- On-demand file references to avoid unnecessary context loading
- More granular subagent spawning for focused subtasks (beyond just FastLoop/DeepLoop)

---

## 5. Task Decomposition & Planning

### Qwen Code: Formal Plan Mode

```
┌──────────────────────────────────────────────────┐
│  PLAN MODE (read-only tools only)                │
│                                                  │
│  1. Explore codebase (read_file, grep, glob)     │
│  2. Analyze structure and dependencies           │
│  3. Design implementation plan                   │
│  4. Write plan to .qwen/todo.md                  │
│  5. Call exit_plan_mode → present plan to user    │
│                                                  │
├──────────────────────────────────────────────────┤
│  USER APPROVAL GATE                              │
├──────────────────────────────────────────────────┤
│  IMPLEMENTATION MODE (full tool access)          │
│                                                  │
│  1. Execute plan steps sequentially              │
│  2. Update todo.md progress in real-time         │
│  3. Use task tool for dynamic task management    │
│  4. Delegate subtasks to subagents               │
│                                                  │
└──────────────────────────────────────────────────┘
```

- Enforced read-only phase prevents premature writes
- Automatic for untrusted folders
- Todo items persist in `.qwen/todo.md` for visibility
- Dynamic task updates during execution

### Casterly DeepLoop: Implicit Planning in ReAct

```
┌──────────────────────────────────────────────────┐
│  TRIAGE (FastLoop, 35B, compact context)         │
│                                                  │
│  1. Parse user intent                            │
│  2. Classify complexity                          │
│  3. Route to DeepLoop if complex                 │
│                                                  │
├──────────────────────────────────────────────────┤
│  DEEPLOOP ReAct (122B, extended context)         │
│                                                  │
│  1. Plan within first ReAct turns                │
│  2. Implement via tool calls                     │
│  3. Self-review (verification cascade)           │
│     - Pass 0: correctness review                 │
│     - Pass 1: security/robustness (if complex)   │
│  4. Dispatch to coder model if needed            │
│                                                  │
└──────────────────────────────────────────────────┘
```

- No enforced read-only phase — planning and implementation are interleaved
- Self-review happens after implementation, not before
- Verification cascade (2-pass for complex tasks) is unique to our system
- No persistent todo file — task state lives in TaskBoard memory

### Comparison

**Qwen Code advantages:**
- **Enforced separation** between exploration and implementation reduces premature/incorrect writes
- **Visible plan artifacts** (todo.md) give the user a reviewable plan before any changes
- **User approval gate** ensures the human agrees with the approach

**Casterly advantages:**
- **Self-review with verification cascade** catches correctness + security issues post-implementation
- **Triage pre-routing** (FastLoop) avoids wasting the 122B on simple tasks
- **Integrated planning** avoids the overhead of a separate phase for straightforward tasks

**What we should adopt:**
- An explicit plan mode for complex/unfamiliar codebases (3+ files, new features)
- Read-only tool restriction during the planning phase
- Persistent plan artifacts (todo.md or TaskBoard extension) for user visibility
- An approval gate before implementation begins on high-stakes changes

---

## 6. Agent Training & Model Optimization

### Qwen3-Coder: Agent RL

The most significant technical advantage Qwen Code has:

- **GSPO (Group Sequence Policy Optimization)** — modified GRPO for long-horizon RL
- **20,000 parallel environments** — massive scale execution-driven training
- **"Hard to Solve, Easy to Verify"** — all coding tasks are naturally RL-trainable
- **Training on tool interaction trajectories** — the model learned optimal tool use patterns
  directly from environment feedback across thousands of coding tasks
- **Recovery from failures** — RL training included scenarios where tool calls fail,
  teaching the model to adapt and retry

### Casterly DeepLoop: No Agent-Specific Training

Our system uses **off-the-shelf Qwen3.5:122b** without any agentic fine-tuning:
- Model follows tool schemas via standard instruction following
- No RL training on our specific tool set
- Relies on prompt engineering + structured output (JSON schema) for reliability
- OllamaProvider XML retry loop (3 attempts) compensates for format errors

### What This Means

Qwen3-Coder was literally trained to use the exact tools that Qwen Code provides.
It knows the optimal patterns for:
- When to read vs. search vs. grep
- How many files to read before writing
- When to delegate to a subagent
- How to recover when a shell command fails

Our DeepLoop model has none of this training. We compensate with:
- Careful prompt engineering
- Structured output schemas
- Verification cascade (catch mistakes after the fact)
- Context tier selection (prevent context exhaustion)

**Potential path forward:**
- Fine-tune on our specific tool call traces (SPIN/DPO on collected trajectories)
- This is partially captured in config/autonomous.yaml's SPIN self-improvement pipeline
- The `specialist` model slot in config/models.yaml is reserved for exactly this purpose

---

## 7. SubAgent Architecture

### Qwen Code SubAgents

- Configured via markdown files with YAML frontmatter
- Each subagent has: focused system prompt, own conversation history, controlled tool set
- Created via `/agents create` wizard or manually
- The main agent automatically delegates to the appropriate subagent
- Real-time progress feedback during subagent execution
- Context isolation — subagent work doesn't pollute the main conversation

### Casterly DeepLoop

- Two-loop design: FastLoop (triage) and DeepLoop (reasoning/coding)
- DeepLoop can dispatch to a coder model via ConcurrentProvider
- No user-configurable subagents
- Task ownership protocol (FastLoop vs DeepLoop) prevents conflicts

### Comparison

Qwen Code's subagent system is more flexible — users can define arbitrary specialized agents
for different domains (frontend, backend, testing, etc.). Our system is more opinionated
with exactly two loops but tighter coordination.

**What we should consider:**
- Configurable subagents for domain-specific work (security review, test writing, etc.)
- This aligns with our existing subagent flow in docs/subagents.md
- SubAgent context isolation would help with our context pressure issues

---

## 8. Workflow Comparison: End-to-End Task

### Scenario: "Add input validation to the user registration API"

#### Qwen Code Workflow

```
Turn 1:  [PLAN MODE] grep_search("registration", "src/")
Turn 2:  [PLAN MODE] read_file("src/api/registration.ts")
Turn 3:  [PLAN MODE] read_file("src/types/user.ts")
Turn 4:  [PLAN MODE] read_file("tests/registration.test.ts")
Turn 5:  [PLAN MODE] todo_write([
           "Add Zod schema for registration input",
           "Add validation middleware to registration route",
           "Add error response types",
           "Update tests for validation cases"
         ])
Turn 6:  [PLAN MODE] exit_plan_mode → user reviews plan
         ─── USER APPROVES ───
Turn 7:  edit("src/types/user.ts", add Zod schema)
Turn 8:  edit("src/api/registration.ts", add validation)
Turn 9:  edit("tests/registration.test.ts", add test cases)
Turn 10: run_shell_command("npm test")
Turn 11: [fix any failures]
Turn 12: Summary to user
```

**Characteristics:**
- Formal exploration → plan → approval → implement → test
- 5-6 turns of read-only exploration before any writes
- User sees and approves the plan
- Single agentic loop handles everything

#### Casterly DeepLoop Workflow

```
Turn 1:  [FASTLOOP] Triage → complexity: high → route to DeepLoop
Turn 2:  [DEEPLOOP] Read src/api/registration.ts (implicit planning)
Turn 3:  [DEEPLOOP] Read src/types/user.ts
Turn 4:  [DEEPLOOP] Implement validation in registration.ts
Turn 5:  [DEEPLOOP] Implement Zod schema in user.ts
Turn 6:  [DEEPLOOP] Update tests
Turn 7:  [DEEPLOOP] Run tests via tool call
Turn 8:  [DEEPLOOP] Self-review pass 0: correctness ✓
Turn 9:  [DEEPLOOP] Self-review pass 1: security ✓ (if complex)
Turn 10: [DEEPLOOP] Return result to user
```

**Characteristics:**
- Triage pre-routing saves context on simple tasks
- No formal plan phase — reads and writes are interleaved
- Self-review after implementation catches issues
- No user approval gate before writes

---

## 9. Recommendations for Casterly

### High Priority

1. **Batch file reading tool** — Add a `read_many_files` equivalent to reduce turn count.
   Currently each file read is a separate ReAct turn. A batch read could cut exploration
   turns by 60-70%.

2. **Explicit plan mode for complex tasks** — When the DeepLoop detects a complex task
   (3+ files, new feature, unfamiliar codebase), enforce a read-only exploration phase
   before any writes. Present the plan via TaskBoard for user review.

3. **On-demand file references** — Allow `@filename` syntax in user messages to
   pre-load specific files into context without using a tool turn.

### Medium Priority

4. **Configurable subagents** — Extend beyond FastLoop/DeepLoop to allow domain-specific
   agents (test writer, security reviewer, documentation). This aligns with docs/subagents.md.

5. **Agent-specific fine-tuning** — Collect tool call traces from successful DeepLoop sessions
   and fine-tune via the SPIN pipeline. The `specialist` model slot is reserved for this.

6. **Persistent plan artifacts** — Write plans to a file (like .qwen/todo.md) so users
   can review and reference them across sessions.

### Lower Priority

7. **Context folding for tool responses** — Implement Qwen Code's approach of pruning
   old tool responses when cumulative length exceeds a threshold. This complements our
   existing prompt compression (which drops middle conversation sections).

8. **Approval gates** — Add configurable approval gates before destructive operations
   in the DeepLoop, similar to Qwen Code's approval modes.

---

## 10. Key Takeaways

1. **Qwen Code's biggest advantage is model-agent co-training.** The RL-trained model
   knows the optimal tool use patterns. We can partially close this gap with trajectory
   fine-tuning via SPIN.

2. **Our biggest advantage is the two-loop architecture.** Triage routing + self-review
   cascade is more sophisticated than Qwen Code's single loop. We should keep this.

3. **Plan mode is the highest-value feature to adopt.** Enforced read-only exploration
   before implementation would reduce premature writes and give users visibility.

4. **Batch file reading is the highest-value tool to add.** It directly reduces turn
   count and context waste.

5. **Context management approaches are complementary.** We should combine our proactive
   tier selection with Qwen Code's reactive context folding for defense in depth.

---

## Sources

- [QwenLM/qwen-code GitHub](https://github.com/QwenLM/qwen-code)
- [Qwen3-Coder Blog](https://qwenlm.github.io/blog/qwen3-coder/)
- [Qwen Code Documentation](https://qwenlm.github.io/qwen-code-docs/)
- [Qwen3-Coder-Next on Hugging Face](https://huggingface.co/Qwen/Qwen3-Coder-Next)
- [DeepWiki: QwenLM/qwen-code Architecture](https://deepwiki.com/QwenLM/qwen-code)
- [DeepWiki: Plan Mode](https://deepwiki.com/QwenLM/qwen-code/8.7-plan-mode-and-task-management)
- [vLLM Qwen3-Coder Usage Guide](https://docs.vllm.ai/projects/recipes/en/latest/Qwen/Qwen3-Coder-480B-A35B.html)
- [DataCamp: Qwen Code Guide](https://www.datacamp.com/tutorial/qwen-code)
