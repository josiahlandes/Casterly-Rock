/**
 * Architect Agent
 *
 * Implements the SWE-CI Architect role using a 3-step analysis process:
 *   1. Summarize — review all failing tests, identify root causes
 *   2. Locate — examine source code, attribute failures to concrete deficiencies
 *   3. Design — produce max N incremental requirements per iteration
 *
 * The Architect uses the 27B dense reasoner (planning/review model) and
 * operates with read-only tools: it analyzes but does not modify code.
 *
 * Key insight from SWE-CI: the Architect must also consider currently
 * passing tests to prevent regressions, not just fix failing ones.
 *
 * Privacy: All inference is local via the reasoner model.
 */

import type { LlmProvider } from '../providers/base.js';
import type { ToolSchema, NativeToolCall, NativeToolResult } from '../tools/schemas/types.js';
import { createDelegateAgent, resultToMessage } from '../dual-loop/agent.js';
import type { AgentResult } from '../dual-loop/agent.js';
import type {
  TestRunResult,
  RegressionReport,
  ArchitectAnalysis,
  Requirement,
  CodeLocation,
} from './types.js';
import { formatRegressionReport, getFailingTests, getPassingTests } from './regression-guard.js';

// ─────────────────────────────────────────────────────────────────────────────
// Read-Only Tools for the Architect
// ─────────────────────────────────────────────────────────────────────────────

export const ARCHITECT_READ_FILE: ToolSchema = {
  name: 'read_file',
  description: 'Read the contents of a file to analyze its implementation.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative path to the file' },
    },
    required: ['path'],
  },
};

export const ARCHITECT_GREP: ToolSchema = {
  name: 'grep_files',
  description: 'Search for a pattern across files in the codebase.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      path: { type: 'string', description: 'Directory or file to search in' },
      glob: { type: 'string', description: 'File glob pattern (e.g., "*.ts")' },
    },
    required: ['pattern'],
  },
};

export const ARCHITECT_LIST_FILES: ToolSchema = {
  name: 'list_files',
  description: 'List files in a directory.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path to list' },
    },
    required: ['path'],
  },
};

/** Read-only tool set for the Architect */
export const ARCHITECT_TOOLS: ToolSchema[] = [
  ARCHITECT_READ_FILE,
  ARCHITECT_GREP,
  ARCHITECT_LIST_FILES,
];

// ─────────────────────────────────────────────────────────────────────────────
// Architect Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface ArchitectConfig {
  /** LLM provider (reasoner model) */
  provider: LlmProvider;

  /** Tool executor for read-only operations */
  executeTool: (call: NativeToolCall) => Promise<NativeToolResult>;

  /** Maximum requirements per iteration */
  maxRequirements: number;

  /** Maximum ReAct turns */
  maxTurns: number;

  /** Temperature */
  temperature: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// System Prompt
// ─────────────────────────────────────────────────────────────────────────────

function buildArchitectSystemPrompt(
  maxRequirements: number,
): string {
  return `You are the Architect agent in a Continuous Integration loop.

Your role is to analyze test failures and design requirements for the Programmer agent.
You must NOT modify any code — you only analyze and design.

## Your 3-Step Process

### Step 1: SUMMARIZE
Review all failing tests and identify root causes. For each failing test:
- What is the test expecting?
- Why is it failing?
- What is the underlying root cause (not just the symptom)?

### Step 2: LOCATE
Examine the source code to find concrete deficiencies:
- Which files contain the relevant implementation?
- What specific code is causing the failures?
- Are there missing functions, incorrect logic, or missing imports?

Use the read_file and grep_files tools to examine the codebase.

### Step 3: DESIGN
Produce up to ${maxRequirements} incremental requirements for the Programmer:
- Each requirement should address one or more related test failures
- Requirements should be ordered by priority (critical first)
- Each requirement must list the target files and related tests
- Each requirement must also list PROTECTED TESTS that must not regress

## CRITICAL: Regression Prevention

You MUST consider the impact on currently PASSING tests. When designing requirements:
- List all passing tests that could be affected by the proposed changes
- Explicitly mark them as protected in each requirement
- Design changes that are minimal and targeted to reduce regression risk
- Prefer additive changes over modifications to shared code paths

## Output Format

After your analysis, output your findings in a structured format with clear sections:

<analysis>
<summary>
[Your summary of all failing tests and root causes]
</summary>

<locations>
[List of code locations with deficiencies, one per line:
FILE_PATH:START_LINE-END_LINE | description | related_test_1, related_test_2]
</locations>

<requirements>
[List of requirements, each in this format:
REQ-N | priority | title
Description of what needs to change.
TARGET_FILES: file1.ts, file2.ts
RELATED_TESTS: test1, test2
PROTECTED_TESTS: test3, test4]
</requirements>
</analysis>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Architect Execution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the Architect agent to analyze test failures and produce requirements.
 *
 * @param config - Architect configuration
 * @param testResult - Current test results
 * @param regressionReport - Regression report from previous iteration (if any)
 * @param iterationIndex - Current iteration number
 * @returns ArchitectAnalysis with requirements for the Programmer
 */
export async function runArchitect(
  config: ArchitectConfig,
  testResult: TestRunResult,
  regressionReport: RegressionReport | undefined,
  iterationIndex: number,
): Promise<{ analysis: ArchitectAnalysis; agentResult: AgentResult }> {
  const failingTests = getFailingTests(testResult);
  const passingTests = getPassingTests(testResult);

  // Build the task prompt with test context
  const taskPrompt = buildArchitectTaskPrompt(
    testResult,
    failingTests,
    passingTests,
    regressionReport,
    iterationIndex,
  );

  // Create the Architect delegate agent
  const architect = createDelegateAgent({
    role: 'architect',
    provider: config.provider,
    systemPrompt: buildArchitectSystemPrompt(config.maxRequirements),
    tools: ARCHITECT_TOOLS,
    executeTool: config.executeTool,
    maxTurns: config.maxTurns,
  });

  // Execute
  const agentResult = await architect.execute({
    prompt: taskPrompt,
    temperature: config.temperature,
  });

  // Parse the structured output
  const analysis = parseArchitectOutput(
    agentResult.text,
    failingTests,
    passingTests,
    config.maxRequirements,
  );

  return { analysis, agentResult };
}

/**
 * Build the task prompt for the Architect with current test state.
 */
function buildArchitectTaskPrompt(
  testResult: TestRunResult,
  failingTests: string[],
  passingTests: string[],
  regressionReport: RegressionReport | undefined,
  iterationIndex: number,
): string {
  const sections: string[] = [];

  sections.push(`# CI Loop — Iteration ${iterationIndex}`);
  sections.push('');

  // Test overview
  sections.push(`## Current Test Status`);
  sections.push(`- Total: ${testResult.total}`);
  sections.push(`- Passing: ${testResult.passed}`);
  sections.push(`- Failing: ${testResult.failed}`);
  sections.push(`- Errored: ${testResult.errored}`);
  sections.push(`- Skipped: ${testResult.skipped}`);
  sections.push('');

  // Failing tests detail
  if (failingTests.length > 0) {
    sections.push('## Failing Tests');
    for (const test of testResult.tests) {
      if (test.status === 'failed' || test.status === 'error') {
        sections.push(`### ${test.name}`);
        sections.push(`Status: ${test.status}`);
        if (test.errorMessage) {
          sections.push(`Error: ${test.errorMessage}`);
        }
        sections.push('');
      }
    }
  }

  // Passing tests (for regression awareness)
  if (passingTests.length > 0) {
    sections.push('## Currently Passing Tests (MUST NOT REGRESS)');
    for (const name of passingTests) {
      sections.push(`- ${name}`);
    }
    sections.push('');
  }

  // Regression report from previous iteration
  if (regressionReport) {
    sections.push(formatRegressionReport(regressionReport));
    sections.push('');
  }

  sections.push('## Your Task');
  sections.push(
    'Analyze the failing tests using your 3-step process (Summarize → Locate → Design). ' +
    'Use the available tools to read source files and search the codebase. ' +
    'Design requirements that fix failing tests WITHOUT breaking passing ones.',
  );

  return sections.join('\n');
}

/**
 * Parse the Architect's structured output into an ArchitectAnalysis.
 */
export function parseArchitectOutput(
  text: string,
  failingTests: string[],
  passingTests: string[],
  maxRequirements: number,
): ArchitectAnalysis {
  const summary = extractSection(text, 'summary') || text;
  const locationsRaw = extractSection(text, 'locations') || '';
  const requirementsRaw = extractSection(text, 'requirements') || '';

  const locations = parseLocations(locationsRaw);
  const requirements = parseRequirements(requirementsRaw, maxRequirements);

  return {
    summary,
    locations,
    requirements,
    passingTestsToProtect: passingTests,
    failingTestCount: failingTests.length,
  };
}

/**
 * Extract content between XML-style tags.
 */
function extractSection(text: string, tag: string): string | undefined {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
  const match = text.match(regex);
  return match?.[1]?.trim();
}

/**
 * Parse code locations from the Architect's output.
 */
function parseLocations(raw: string): CodeLocation[] {
  if (!raw) return [];

  const locations: CodeLocation[] = [];
  const lines = raw.split('\n').filter((l) => l.trim());

  for (const line of lines) {
    // Format: FILE_PATH:START-END | description | tests
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length < 2) continue;

    const fileSpec = parts[0]!;
    const description = parts[1] ?? '';
    const tests = parts[2]?.split(',').map((t) => t.trim()) ?? [];

    // Parse file path and optional line range
    const fileMatch = fileSpec.match(/^(.+?)(?::(\d+)(?:-(\d+))?)?$/);
    if (!fileMatch) continue;

    const loc: CodeLocation = {
      filePath: fileMatch[1]!.trim(),
      deficiency: description,
      relatedTests: tests,
    };
    if (fileMatch[2]) loc.startLine = parseInt(fileMatch[2], 10);
    if (fileMatch[3]) loc.endLine = parseInt(fileMatch[3], 10);
    locations.push(loc);
  }

  return locations;
}

/**
 * Parse requirements from the Architect's output.
 */
function parseRequirements(raw: string, maxRequirements: number): Requirement[] {
  if (!raw) return [];

  const requirements: Requirement[] = [];
  // Split on requirement headers: REQ-N | priority | title
  const reqBlocks = raw.split(/(?=REQ-\d+)/);

  for (const block of reqBlocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // Parse header: REQ-N | priority | title
    const headerMatch = trimmed.match(/^(REQ-\d+)\s*\|\s*(\w+)\s*\|\s*(.+)/);
    if (!headerMatch) continue;

    const id = headerMatch[1]!;
    const priorityRaw = headerMatch[2]!.toLowerCase();
    const title = headerMatch[3]!.trim();

    // Parse body lines
    const bodyLines = trimmed.split('\n').slice(1);
    const description: string[] = [];
    let targetFiles: string[] = [];
    let relatedTests: string[] = [];
    let protectedTests: string[] = [];

    for (const line of bodyLines) {
      const trimLine = line.trim();
      if (trimLine.startsWith('TARGET_FILES:')) {
        targetFiles = trimLine.replace('TARGET_FILES:', '').split(',').map((f) => f.trim()).filter(Boolean);
      } else if (trimLine.startsWith('RELATED_TESTS:')) {
        relatedTests = trimLine.replace('RELATED_TESTS:', '').split(',').map((t) => t.trim()).filter(Boolean);
      } else if (trimLine.startsWith('PROTECTED_TESTS:')) {
        protectedTests = trimLine.replace('PROTECTED_TESTS:', '').split(',').map((t) => t.trim()).filter(Boolean);
      } else if (trimLine) {
        description.push(trimLine);
      }
    }

    const priority = (['critical', 'high', 'medium', 'low'] as const).includes(
      priorityRaw as 'critical' | 'high' | 'medium' | 'low',
    )
      ? (priorityRaw as 'critical' | 'high' | 'medium' | 'low')
      : 'medium';

    requirements.push({
      id,
      title,
      description: description.join('\n'),
      priority,
      targetFiles,
      relatedTests,
      protectedTests,
    });

    if (requirements.length >= maxRequirements) break;
  }

  return requirements;
}
