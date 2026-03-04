/**
 * Handoff — Structured cross-cycle context transfer.
 *
 * Provides XML serialization/deserialization for HandoffSnapshot, plus a
 * builder that extracts structured handoffs from task state (steps, artifacts,
 * manifest). Used by parkTask, warm-tier compression, and cycle boundaries.
 *
 * See roadmap §18 and docs/qwen-code-vs-deeploop.md §4.7.
 */

import type { HandoffSnapshot, PlanStep, TaskArtifact, FileOperation } from './task-board-types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Builder
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildHandoffInput {
  steps: PlanStep[];
  artifacts: TaskArtifact[];
  manifest: FileOperation[];
  /** Optional additional decisions/learnings extracted from step outputs */
  decisions?: { decision: string; rationale: string }[];
  blockers?: string[];
  keyLearnings?: string[];
}

/**
 * Build a HandoffSnapshot from task execution state.
 *
 * Extracts file operations from the manifest, infers test results from
 * artifacts, and counts completed steps. Decisions, blockers, and learnings
 * are passed explicitly (they require semantic understanding that the caller
 * — typically the LLM — provides).
 */
export function buildHandoffSnapshot(input: BuildHandoffInput): HandoffSnapshot {
  const { steps, artifacts, manifest, decisions = [], blockers = [], keyLearnings = [] } = input;

  const stepsCompleted = steps.filter((s) => s.status === 'done').length;
  const totalSteps = steps.length;

  // Extract file operations from manifest
  const filesModified = manifest.map((f) => ({
    path: f.path,
    operation: f.action === 'created' ? 'created' as const : 'modified' as const,
    summary: f.exports?.length
      ? `Exports: ${f.exports.join(', ')}`
      : `${f.lines ?? 0} lines`,
  }));

  // Extract test results from artifacts
  const testResults = artifacts
    .filter((a) => a.type === 'test_result')
    .map((a) => {
      const content = a.content ?? '';
      const passMatch = content.match(/(\d+)\s*pass/i);
      const failMatch = content.match(/(\d+)\s*fail/i);
      return {
        file: a.path ?? 'unknown',
        passed: passMatch ? parseInt(passMatch[1]!, 10) : 0,
        failed: failMatch ? parseInt(failMatch[1]!, 10) : 0,
        summary: content.slice(0, 200),
      };
    });

  // Derive next steps from pending plan steps
  const nextSteps = steps
    .filter((s) => s.status === 'pending')
    .map((s) => s.description);

  return {
    filesModified,
    decisionsMade: decisions,
    blockersEncountered: blockers,
    nextSteps,
    keyLearnings,
    testResults,
    stepsCompleted,
    totalSteps,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// XML Serialization
// ─────────────────────────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Serialize a HandoffSnapshot to XML `<state_snapshot>` format.
 *
 * The XML format is designed for model-parseability — structured fields
 * that can be consumed by the LLM without ambiguity.
 */
export function serializeHandoff(snapshot: HandoffSnapshot): string {
  const lines: string[] = ['<state_snapshot>'];

  lines.push(`  <progress completed="${snapshot.stepsCompleted}" total="${snapshot.totalSteps}" />`);

  if (snapshot.filesModified.length > 0) {
    lines.push('  <files_modified>');
    for (const f of snapshot.filesModified) {
      lines.push(`    <file path="${escapeXml(f.path)}" operation="${f.operation}">${escapeXml(f.summary)}</file>`);
    }
    lines.push('  </files_modified>');
  }

  if (snapshot.decisionsMade.length > 0) {
    lines.push('  <decisions>');
    for (const d of snapshot.decisionsMade) {
      lines.push(`    <decision rationale="${escapeXml(d.rationale)}">${escapeXml(d.decision)}</decision>`);
    }
    lines.push('  </decisions>');
  }

  if (snapshot.blockersEncountered.length > 0) {
    lines.push('  <blockers>');
    for (const b of snapshot.blockersEncountered) {
      lines.push(`    <blocker>${escapeXml(b)}</blocker>`);
    }
    lines.push('  </blockers>');
  }

  if (snapshot.nextSteps.length > 0) {
    lines.push('  <next_steps>');
    for (const n of snapshot.nextSteps) {
      lines.push(`    <step>${escapeXml(n)}</step>`);
    }
    lines.push('  </next_steps>');
  }

  if (snapshot.keyLearnings.length > 0) {
    lines.push('  <key_learnings>');
    for (const k of snapshot.keyLearnings) {
      lines.push(`    <learning>${escapeXml(k)}</learning>`);
    }
    lines.push('  </key_learnings>');
  }

  if (snapshot.testResults.length > 0) {
    lines.push('  <test_results>');
    for (const t of snapshot.testResults) {
      lines.push(`    <test file="${escapeXml(t.file)}" passed="${t.passed}" failed="${t.failed}">${escapeXml(t.summary)}</test>`);
    }
    lines.push('  </test_results>');
  }

  lines.push('</state_snapshot>');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// XML Deserialization (lightweight regex-based — no DOM parser needed)
// ─────────────────────────────────────────────────────────────────────────────

function unescapeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

/**
 * Parse an XML `<state_snapshot>` back into a HandoffSnapshot.
 *
 * Returns null if the input doesn't contain a valid state_snapshot.
 */
export function parseHandoff(xml: string): HandoffSnapshot | null {
  const snapshotMatch = xml.match(/<state_snapshot>([\s\S]*?)<\/state_snapshot>/);
  if (!snapshotMatch) return null;

  const body = snapshotMatch[1]!;

  // Progress
  const progressMatch = body.match(/<progress\s+completed="(\d+)"\s+total="(\d+)"/);
  const stepsCompleted = progressMatch ? parseInt(progressMatch[1]!, 10) : 0;
  const totalSteps = progressMatch ? parseInt(progressMatch[2]!, 10) : 0;

  // Files
  const filesModified: HandoffSnapshot['filesModified'] = [];
  const fileRegex = /<file\s+path="([^"]*)"\s+operation="([^"]*)">([\s\S]*?)<\/file>/g;
  let fileMatch;
  while ((fileMatch = fileRegex.exec(body)) !== null) {
    filesModified.push({
      path: unescapeXml(fileMatch[1]!),
      operation: fileMatch[2] as 'created' | 'modified' | 'deleted',
      summary: unescapeXml(fileMatch[3]!),
    });
  }

  // Decisions
  const decisionsMade: HandoffSnapshot['decisionsMade'] = [];
  const decisionRegex = /<decision\s+rationale="([^"]*)">([\s\S]*?)<\/decision>/g;
  let decisionMatch;
  while ((decisionMatch = decisionRegex.exec(body)) !== null) {
    decisionsMade.push({
      rationale: unescapeXml(decisionMatch[1]!),
      decision: unescapeXml(decisionMatch[2]!),
    });
  }

  // Blockers
  const blockersEncountered: string[] = [];
  const blockerRegex = /<blocker>([\s\S]*?)<\/blocker>/g;
  let blockerMatch;
  while ((blockerMatch = blockerRegex.exec(body)) !== null) {
    blockersEncountered.push(unescapeXml(blockerMatch[1]!));
  }

  // Next steps
  const nextSteps: string[] = [];
  const stepRegex = /<next_steps>[\s\S]*?<\/next_steps>/;
  const nextStepsBlock = body.match(stepRegex);
  if (nextStepsBlock) {
    const nsRegex = /<step>([\s\S]*?)<\/step>/g;
    let nsMatch;
    while ((nsMatch = nsRegex.exec(nextStepsBlock[0])) !== null) {
      nextSteps.push(unescapeXml(nsMatch[1]!));
    }
  }

  // Key learnings
  const keyLearnings: string[] = [];
  const learningRegex = /<learning>([\s\S]*?)<\/learning>/g;
  let learningMatch;
  while ((learningMatch = learningRegex.exec(body)) !== null) {
    keyLearnings.push(unescapeXml(learningMatch[1]!));
  }

  // Test results
  const testResults: HandoffSnapshot['testResults'] = [];
  const testRegex = /<test\s+file="([^"]*)"\s+passed="(\d+)"\s+failed="(\d+)">([\s\S]*?)<\/test>/g;
  let testMatch;
  while ((testMatch = testRegex.exec(body)) !== null) {
    testResults.push({
      file: unescapeXml(testMatch[1]!),
      passed: parseInt(testMatch[2]!, 10),
      failed: parseInt(testMatch[3]!, 10),
      summary: unescapeXml(testMatch[4]!),
    });
  }

  return {
    filesModified,
    decisionsMade,
    blockersEncountered,
    nextSteps,
    keyLearnings,
    testResults,
    stepsCompleted,
    totalSteps,
  };
}
