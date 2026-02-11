# Mac Studio Refactor Plan

## Hardware Change

| Spec | Raspberry Pi | Mac Studio M4 Max |
|------|--------------|-------------------|
| CPU | ARM Cortex-A72 (4 cores) | M4 Max (14-16 cores) |
| RAM | 1-8 GB | 128 GB unified |
| GPU | None (VideoCore) | 40-core GPU + Neural Engine |
| Storage | SD card | NVMe SSD |
| Power | 5-15W | 75-220W |

**Impact:** Can run 70B+ parameter models locally with room to spare.

---

## Architecture Changes

### Remove: Routing System

The routing system (`src/router/`) exists to decide between local and cloud. With 128GB unified memory and no API usage, routing is unnecessary.

**Files to remove:**
```
src/router/
├── classifier.ts      # DELETE - no routing decisions needed
├── index.ts           # DELETE
└── types.ts           # DELETE

tests/router.test.ts   # DELETE
```

### Remove: Cloud Providers

No APIs will be used. Remove all cloud provider code.

**Files to remove:**
```
src/providers/
├── anthropic.ts       # DELETE - no Claude API
├── openai.ts          # DELETE - no OpenAI API (if exists)
└── index.ts           # MODIFY - export only local providers
```

**Config to remove:**
- `ANTHROPIC_API_KEY` references
- Cloud routing config
- API budget tracking

### Remove: Pi-Specific Code

The Raspberry Pi branch optimizations are no longer needed.

**Revert/Remove:**
- Temperature monitoring in `loop.ts`
- Memory limits (384MB → unlimited)
- Network connectivity checks for API
- Pi detection in daemon script

### Keep: Core Autonomous Framework

The self-improvement loop is still valuable, just powered by local models.

---

## New Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Mac Studio                            │
│  ┌─────────────────────────────────────────────────┐    │
│  │                   Ollama                         │    │
│  │  ┌─────────────┐  ┌─────────────┐              │    │
│  │  │ qwen3-coder │  │  primary    │  ... more    │    │
│  │  │   (coding)  │  │  (general)  │              │    │
│  │  └─────────────┘  └─────────────┘              │    │
│  └─────────────────────────────────────────────────┘    │
│                          │                               │
│  ┌─────────────────────────────────────────────────┐    │
│  │              Casterly (Simplified)               │    │
│  │  ┌─────────────┐  ┌─────────────────────────┐  │    │
│  │  │   Provider  │  │  Autonomous Loop        │  │    │
│  │  │   (Ollama)  │  │  (analyze→improve)      │  │    │
│  │  └─────────────┘  └─────────────────────────┘  │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

---

## Model Strategy

### Coding Tasks: `qwen3-coder-next`

Qwen3 Coder for all code generation, analysis, and refactoring.

**Ollama setup:**
```bash
ollama pull qwen3-coder:latest  # or specific version when available
```

**Config:**
```yaml
models:
  coding:
    name: qwen3-coder-next
    context_length: 32768  # or higher if supported
    temperature: 0.1       # low for code accuracy
```

### Primary/General Tasks: Hermes 3 70B

Selected `hermes3:70b` for all non-coding tasks:
- Natural language understanding
- Reasoning and analysis
- General assistance
- Architecture planning (Architect mode)
- Question answering (Ask mode)

**Ollama setup:**
```bash
ollama pull hermes3:70b
```

**Config:**
```yaml
models:
  primary:
    name: hermes3:70b
    context_length: 32768
    temperature: 0.7  # higher for creative reasoning
```

**Memory footprint:**
- ~40GB at Q4 quantization
- Fits alongside qwen3-coder-next with room to spare

---

## Evaluation Framework

### Benchmarks to Run

1. **Coding Benchmarks**
   - HumanEval
   - MBPP
   - Custom: Fix actual Casterly bugs

2. **Reasoning Benchmarks**
   - MMLU
   - GSM8K
   - Custom: Analyze Casterly architecture

3. **Latency Benchmarks**
   - Time to first token
   - Tokens per second
   - Memory usage under load

### Evaluation Script

Create `scripts/evaluate-models.ts`:
```typescript
interface ModelEvaluation {
  model: string;
  task: 'coding' | 'reasoning' | 'general';
  metrics: {
    accuracy: number;
    latency_ttft_ms: number;
    latency_tps: number;
    memory_gb: number;
  };
}
```

---

## Migration Steps

### Phase 1: Create Mac Studio Branch
```bash
git checkout main
git checkout -b mac-studio-local-only
```

### Phase 2: Remove Routing
1. Delete `src/router/` directory
2. Delete `tests/router.test.ts`
3. Update imports throughout codebase
4. Remove routing config from `config/`

### Phase 3: Simplify Providers
1. Remove cloud provider files
2. Update `src/providers/index.ts` to export only Ollama
3. Remove API key handling
4. Remove budget tracking

### Phase 4: Update Autonomous System
1. Revert Pi-specific changes in `loop.ts`
2. Update `provider.ts` to use Ollama only
3. Configure for Mac Studio resources:
   - No memory limits
   - No temperature checks
   - Parallel model loading

### Phase 5: Model Configuration
1. Create `config/models.yaml` for model routing
2. Set up Qwen3-coder for coding
3. Placeholder for primary model (pending evaluation)

### Phase 6: Validate Model Setup
1. Verify hermes3:70b and qwen3-coder-next work correctly
2. Run integration tests with both models
3. Tune context lengths and temperatures as needed

---

## New Config Structure

```yaml
# config/casterly.yaml (simplified)

models:
  coding:
    provider: ollama
    model: qwen3-coder-next
    context_length: 32768
    temperature: 0.1

  primary:
    provider: ollama
    model: hermes3:70b
    context_length: 32768
    temperature: 0.7

  autonomous:
    provider: ollama
    model: qwen3-coder-next  # For self-improvement

hardware:
  platform: mac-studio-m4-max
  memory_gb: 128
  max_concurrent_models: 2

# No routing config needed
# No API keys needed
# No budget tracking needed
```

---

## Questions to Resolve

1. **Qwen3-coder-next availability** - Is this in Ollama yet? Need to check latest models.

2. **Fallback strategy** - If Ollama is down, what happens? (No cloud fallback now)

3. **Context window** - What context length do we need for autonomous improvement?

4. **Quantization** - Run at FP16 for quality, or Q5/Q4 for fitting more models?

---

## Timeline Estimate

| Phase | Description | Effort |
|-------|-------------|--------|
| 1 | Create branch | Quick |
| 2 | Remove routing | Medium |
| 3 | Simplify providers | Medium |
| 4 | Update autonomous | Medium |
| 5 | Model config | Quick |
| 6 | Evaluation framework | Medium |
| 7 | Run evaluations | Depends on models |

---

## Next Steps

1. Check Ollama for `qwen3-coder-next` and `hermes3:70b` availability
2. Begin Phase 2 (routing removal) - branch already created
3. Test model performance on Mac Studio hardware
