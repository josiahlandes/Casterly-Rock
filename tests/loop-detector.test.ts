import { describe, expect, it, beforeEach } from 'vitest';
import {
  LoopDetector,
  createLoopDetector,
  buildLoopBreakPrompt,
} from '../src/autonomous/loop-detector.js';
import type { LoopDetection } from '../src/autonomous/loop-detector.js';
import { initTracer, resetTracer } from '../src/autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetTracer();
  initTracer({ enabled: false });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1: Tool Call Hash Matching
// ─────────────────────────────────────────────────────────────────────────────

describe('LoopDetector — Layer 1 (Tool Call Hashing)', () => {
  it('detects consecutive identical tool calls', async () => {
    const detector = createLoopDetector({ toolCallRepeatThreshold: 3 });

    for (let i = 0; i < 3; i++) {
      detector.recordToolCall('read_file', { path: 'src/index.ts' });
      detector.recordTurn(`Turn ${i}`);
    }

    const result = await detector.check();
    expect(result.detected).toBe(true);
    expect(result.layer).toBe(1);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('does not trigger on varied tool calls', async () => {
    const detector = createLoopDetector({ toolCallRepeatThreshold: 5 });

    detector.recordToolCall('read_file', { path: 'a.ts' });
    detector.recordToolCall('read_file', { path: 'b.ts' });
    detector.recordToolCall('grep', { pattern: 'foo' });
    detector.recordToolCall('edit_file', { path: 'c.ts' });
    detector.recordToolCall('read_file', { path: 'd.ts' });

    for (let i = 0; i < 5; i++) detector.recordTurn(`Turn ${i}`);

    const result = await detector.check();
    expect(result.detected).toBe(false);
  });

  it('detects alternating A-B-A-B patterns', async () => {
    const detector = createLoopDetector({ toolCallRepeatThreshold: 3 });

    for (let i = 0; i < 6; i++) {
      if (i % 2 === 0) {
        detector.recordToolCall('read_file', { path: 'a.ts' });
      } else {
        detector.recordToolCall('edit_file', { path: 'a.ts', content: 'x' });
      }
      detector.recordTurn(`Turn ${i}`);
    }

    const result = await detector.check();
    expect(result.detected).toBe(true);
    expect(result.layer).toBe(1);
    expect(result.reason).toContain('Alternating');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2: Content Chanting
// ─────────────────────────────────────────────────────────────────────────────

describe('LoopDetector — Layer 2 (Content Chanting)', () => {
  it('detects repeated content patterns', async () => {
    const detector = createLoopDetector({
      contentChantThreshold: 5,
      chantChunkSize: 20,
    });

    const repeatedContent = 'I will try reading the file again to understand the issue. ';
    for (let i = 0; i < 10; i++) {
      detector.recordContent(repeatedContent);
      detector.recordTurn(`Turn ${i}`);
    }

    const result = await detector.check();
    expect(result.detected).toBe(true);
    expect(result.layer).toBe(2);
  });

  it('ignores code blocks to avoid false positives', async () => {
    const detector = createLoopDetector({
      contentChantThreshold: 5,
      chantChunkSize: 20,
    });

    // Same code block repeated should be stripped
    for (let i = 0; i < 10; i++) {
      detector.recordContent('```typescript\nconst x = 1;\nconst y = 2;\n```');
      detector.recordTurn(`Turn ${i}`);
    }

    const result = await detector.check();
    // After stripping code blocks, there's very little content left
    expect(result.detected).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3: Cognitive Assessment
// ─────────────────────────────────────────────────────────────────────────────

describe('LoopDetector — Layer 3 (Cognitive Assessment)', () => {
  it('triggers cognitive assessment after threshold turns', async () => {
    const detector = createLoopDetector({
      cognitiveAssessmentStartTurn: 5,
      cognitiveAssessmentInterval: 2,
      cognitiveStuckThreshold: 0.7,
    });

    let callCount = 0;
    detector.setCognitiveCallback(async () => {
      callCount++;
      return 0.85; // Stuck!
    });

    // Record enough turns to trigger
    for (let i = 0; i < 7; i++) {
      detector.recordTurn(`Turn ${i}: Did something`);
    }

    const result = await detector.check();
    expect(callCount).toBe(1);
    expect(result.detected).toBe(true);
    expect(result.layer).toBe(3);
    expect(result.confidence).toBe(0.85);
  });

  it('does not trigger before start turn', async () => {
    const detector = createLoopDetector({
      cognitiveAssessmentStartTurn: 15,
    });

    let called = false;
    detector.setCognitiveCallback(async () => {
      called = true;
      return 1.0;
    });

    for (let i = 0; i < 10; i++) {
      detector.recordTurn(`Turn ${i}`);
    }

    await detector.check();
    expect(called).toBe(false);
  });

  it('does not trigger when score is below threshold', async () => {
    const detector = createLoopDetector({
      cognitiveAssessmentStartTurn: 3,
      cognitiveAssessmentInterval: 1,
      cognitiveStuckThreshold: 0.7,
    });

    detector.setCognitiveCallback(async () => 0.3); // Not stuck

    for (let i = 0; i < 5; i++) {
      detector.recordTurn(`Turn ${i}`);
    }

    const result = await detector.check();
    expect(result.detected).toBe(false);
  });

  it('handles callback errors gracefully', async () => {
    const detector = createLoopDetector({
      cognitiveAssessmentStartTurn: 3,
      cognitiveAssessmentInterval: 1,
    });

    detector.setCognitiveCallback(async () => {
      throw new Error('LLM call failed');
    });

    for (let i = 0; i < 5; i++) {
      detector.recordTurn(`Turn ${i}`);
    }

    const result = await detector.check();
    expect(result.detected).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reset and Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe('LoopDetector — Lifecycle', () => {
  it('reset clears all state', async () => {
    const detector = createLoopDetector({ toolCallRepeatThreshold: 3 });

    for (let i = 0; i < 3; i++) {
      detector.recordToolCall('read_file', { path: 'a.ts' });
      detector.recordTurn(`Turn ${i}`);
    }

    // Should detect before reset
    let result = await detector.check();
    expect(result.detected).toBe(true);

    detector.reset();

    // Should not detect after reset
    result = await detector.check();
    expect(result.detected).toBe(false);
  });

  it('factory creates working instance', () => {
    const detector = createLoopDetector({ toolCallRepeatThreshold: 10 });
    expect(detector).toBeInstanceOf(LoopDetector);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Loop Break Prompt
// ─────────────────────────────────────────────────────────────────────────────

describe('buildLoopBreakPrompt', () => {
  it('includes detection details', () => {
    const detection: LoopDetection = {
      detected: true,
      layer: 1,
      reason: '5 consecutive identical tool calls detected',
      confidence: 0.95,
    };

    const prompt = buildLoopBreakPrompt(detection);

    expect(prompt).toContain('Layer 1');
    expect(prompt).toContain('95%');
    expect(prompt).toContain('identical tool calls');
    expect(prompt).toContain('different approach');
  });
});
