/**
 * Loop Detector — 3-layer detection for stuck agent loops
 *
 * Detects when the agent is stuck in semantic loops — doing the same thing
 * repeatedly with slight variations. Three independent detection layers:
 *
 *   Layer 1: Tool call hash matching — exact repeat detection
 *   Layer 2: Content chanting — repeated output pattern detection
 *   Layer 3: LLM cognitive assessment — asks the fast model if stuck
 *
 * See roadmap §16 and docs/qwen-code-vs-deeploop.md §4.2.
 */

import { createHash } from 'node:crypto';
import { getTracer } from './debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface LoopDetectorConfig {
  /** Layer 1: consecutive identical tool call hashes to trigger detection */
  toolCallRepeatThreshold: number;
  /** Layer 2: identical content chunks in sliding window to trigger detection */
  contentChantThreshold: number;
  /** Layer 2: chunk size for content hashing */
  chantChunkSize: number;
  /** Layer 3: turn count before cognitive assessment starts */
  cognitiveAssessmentStartTurn: number;
  /** Layer 3: turns between cognitive assessments (dynamically adjusted) */
  cognitiveAssessmentInterval: number;
  /** Layer 3: stuck score threshold (0.0–1.0) */
  cognitiveStuckThreshold: number;
}

export interface LoopDetection {
  detected: boolean;
  layer: 0 | 1 | 2 | 3;  // 0 = no detection
  reason: string;
  confidence: number;     // 0.0–1.0
}

/**
 * Callback for Layer 3 cognitive assessment.
 * Receives recent turn summaries and returns a stuck score (0.0–1.0).
 */
export type CognitiveAssessCallback = (
  recentTurns: string[],
) => Promise<number>;

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: LoopDetectorConfig = {
  toolCallRepeatThreshold: 5,
  contentChantThreshold: 10,
  chantChunkSize: 50,
  cognitiveAssessmentStartTurn: 15,
  cognitiveAssessmentInterval: 5,
  cognitiveStuckThreshold: 0.7,
};

// ─────────────────────────────────────────────────────────────────────────────
// Loop Detector
// ─────────────────────────────────────────────────────────────────────────────

export class LoopDetector {
  private readonly config: LoopDetectorConfig;

  // Layer 1 state
  private toolCallHashes: string[] = [];

  // Layer 2 state
  private contentChunks: Map<string, number> = new Map(); // hash → count

  // Layer 3 state
  private cognitiveCallback: CognitiveAssessCallback | null = null;
  private turnsSinceLastAssessment: number = 0;
  private lastCognitiveScore: number = 0;
  private currentInterval: number;

  // Turn tracking
  private turnSummaries: string[] = [];
  private currentTurn: number = 0;

  constructor(config?: Partial<LoopDetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.currentInterval = this.config.cognitiveAssessmentInterval;
  }

  /**
   * Set the cognitive assessment callback (Layer 3).
   */
  setCognitiveCallback(cb: CognitiveAssessCallback): void {
    this.cognitiveCallback = cb;
  }

  /**
   * Record a tool call for Layer 1 detection.
   */
  recordToolCall(toolName: string, input: Record<string, unknown>): void {
    const hash = createHash('sha256')
      .update(JSON.stringify({ toolName, input }))
      .digest('hex')
      .slice(0, 16);

    this.toolCallHashes.push(hash);

    // Keep only recent hashes to bound memory
    if (this.toolCallHashes.length > 100) {
      this.toolCallHashes = this.toolCallHashes.slice(-50);
    }
  }

  /**
   * Record response content for Layer 2 detection.
   */
  recordContent(content: string): void {
    // Strip code blocks and markdown tables to avoid false positives
    const stripped = content
      .replace(/```[\s\S]*?```/g, '')
      .replace(/\|[^\n]*\|/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Chunk the content and hash each chunk
    for (let i = 0; i <= stripped.length - this.config.chantChunkSize; i += Math.floor(this.config.chantChunkSize / 2)) {
      const chunk = stripped.slice(i, i + this.config.chantChunkSize);
      const hash = createHash('sha256').update(chunk).digest('hex').slice(0, 12);
      this.contentChunks.set(hash, (this.contentChunks.get(hash) ?? 0) + 1);
    }

    // Bound memory
    if (this.contentChunks.size > 1000) {
      const entries = Array.from(this.contentChunks.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 500);
      this.contentChunks = new Map(entries);
    }
  }

  /**
   * Record a turn summary for Layer 3 cognitive assessment.
   */
  recordTurn(summary: string): void {
    this.currentTurn++;
    this.turnsSinceLastAssessment++;
    this.turnSummaries.push(summary);

    // Keep last 20 summaries
    if (this.turnSummaries.length > 20) {
      this.turnSummaries = this.turnSummaries.slice(-20);
    }
  }

  /**
   * Check all three layers for loop detection.
   *
   * Call this after each turn. Returns the first triggered detection
   * or a no-detection result.
   */
  async check(): Promise<LoopDetection> {
    const tracer = getTracer();

    // Layer 1: Tool call hash matching
    const layer1 = this.checkToolCallRepeats();
    if (layer1.detected) {
      tracer.log('loop-detector', 'warn', `Layer 1 loop detected: ${layer1.reason}`);
      return layer1;
    }

    // Layer 2: Content chanting
    const layer2 = this.checkContentChanting();
    if (layer2.detected) {
      tracer.log('loop-detector', 'warn', `Layer 2 loop detected: ${layer2.reason}`);
      return layer2;
    }

    // Layer 3: LLM cognitive assessment
    const layer3 = await this.checkCognitiveAssessment();
    if (layer3.detected) {
      tracer.log('loop-detector', 'warn', `Layer 3 loop detected: ${layer3.reason}`, {
        score: layer3.confidence,
      });
      return layer3;
    }

    return { detected: false, layer: 0, reason: '', confidence: 0 };
  }

  /**
   * Reset all state (call between cycles/tasks).
   */
  reset(): void {
    this.toolCallHashes = [];
    this.contentChunks.clear();
    this.turnSummaries = [];
    this.currentTurn = 0;
    this.turnsSinceLastAssessment = 0;
    this.lastCognitiveScore = 0;
    this.currentInterval = this.config.cognitiveAssessmentInterval;
  }

  // ── Layer 1: Tool Call Hash Matching ─────────────────────────────────────

  private checkToolCallRepeats(): LoopDetection {
    const threshold = this.config.toolCallRepeatThreshold;
    const hashes = this.toolCallHashes;

    if (hashes.length < threshold) {
      return { detected: false, layer: 0, reason: '', confidence: 0 };
    }

    // Check the last N hashes for identical consecutive calls
    const recent = hashes.slice(-threshold);
    const allSame = recent.every((h) => h === recent[0]);

    if (allSame) {
      return {
        detected: true,
        layer: 1,
        reason: `${threshold} consecutive identical tool calls detected`,
        confidence: 0.95,
      };
    }

    // Check for alternating pattern (A-B-A-B-A-B)
    if (hashes.length >= threshold * 2) {
      const recent2 = hashes.slice(-threshold * 2);
      let isAlternating = true;
      for (let i = 2; i < recent2.length; i++) {
        if (recent2[i] !== recent2[i % 2]) {
          isAlternating = false;
          break;
        }
      }
      if (isAlternating && recent2[0] !== recent2[1]) {
        return {
          detected: true,
          layer: 1,
          reason: `Alternating tool call pattern detected over ${threshold * 2} calls`,
          confidence: 0.85,
        };
      }
    }

    return { detected: false, layer: 0, reason: '', confidence: 0 };
  }

  // ── Layer 2: Content Chanting ────────────────────────────────────────────

  private checkContentChanting(): LoopDetection {
    const threshold = this.config.contentChantThreshold;

    let maxCount = 0;
    for (const count of this.contentChunks.values()) {
      if (count > maxCount) maxCount = count;
    }

    if (maxCount >= threshold) {
      return {
        detected: true,
        layer: 2,
        reason: `Content chunk repeated ${maxCount} times (threshold: ${threshold})`,
        confidence: Math.min(0.9, 0.5 + (maxCount - threshold) * 0.05),
      };
    }

    return { detected: false, layer: 0, reason: '', confidence: 0 };
  }

  // ── Layer 3: LLM Cognitive Assessment ────────────────────────────────────

  private async checkCognitiveAssessment(): Promise<LoopDetection> {
    // Only start after minimum turns
    if (this.currentTurn < this.config.cognitiveAssessmentStartTurn) {
      return { detected: false, layer: 0, reason: '', confidence: 0 };
    }

    // Respect interval between checks
    if (this.turnsSinceLastAssessment < this.currentInterval) {
      return { detected: false, layer: 0, reason: '', confidence: 0 };
    }

    // Requires a callback
    if (!this.cognitiveCallback) {
      return { detected: false, layer: 0, reason: '', confidence: 0 };
    }

    this.turnsSinceLastAssessment = 0;

    try {
      const score = await this.cognitiveCallback(this.turnSummaries);
      this.lastCognitiveScore = score;

      // Dynamically adjust check interval based on score
      // High scores → check more frequently (3 turns min)
      // Low scores → check less frequently (8 turns max)
      this.currentInterval = Math.round(
        this.config.cognitiveAssessmentInterval * (1.5 - score),
      );
      this.currentInterval = Math.max(3, Math.min(8, this.currentInterval));

      if (score >= this.config.cognitiveStuckThreshold) {
        return {
          detected: true,
          layer: 3,
          reason: `LLM assessment: conversation appears stuck (score: ${score.toFixed(2)})`,
          confidence: score,
        };
      }
    } catch {
      // Assessment failure is non-fatal — skip this check
    }

    return { detected: false, layer: 0, reason: '', confidence: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createLoopDetector(
  config?: Partial<LoopDetectorConfig>,
): LoopDetector {
  return new LoopDetector(config);
}

/**
 * Build a meta-prompt to inject when a loop is detected.
 */
export function buildLoopBreakPrompt(detection: LoopDetection): string {
  return [
    `⚠️ LOOP DETECTED (Layer ${detection.layer}, confidence: ${(detection.confidence * 100).toFixed(0)}%)`,
    `Reason: ${detection.reason}`,
    '',
    'You appear to be repeating actions without making progress. Please:',
    '1. Summarize what you have tried so far and why it is not working.',
    '2. Consider a fundamentally different approach.',
    '3. If you are blocked, explain the blocker clearly.',
    '4. Do NOT retry the same action that just failed.',
  ].join('\n');
}
