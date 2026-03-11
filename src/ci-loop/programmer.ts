/**
 * Programmer Agent
 *
 * Implements the SWE-CI Programmer role that receives requirements
 * from the Architect and modifies source code to address them.
 *
 * The Programmer uses the 80B-A3B MoE coder (tool-calling code generation)
 * and operates with read-write tools: it can read, edit, and create files.
 *
 * Key design: The Programmer receives explicit PROTECTED_TESTS from the
 * Architect and is instructed to consider regression impact before each change.
 *
 * Privacy: All inference is local via the coder model.
 */

import type { LlmProvider } from '../providers/base.js';
import type { ToolSchema, NativeToolCall, NativeToolResult } from '../tools/schemas/types.js';
import { createDelegateAgent } from '../dual-loop/agent.js';
import type { AgentResult, AgentMessage } from '../dual-loop/agent.js';
import { resultToMessage } from '../dual-loop/agent.js';
import type {
  ArchitectAnalysis,
  Requirement,
  ProgrammerResult,
  CodeModification,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Read-Write Tools for the Programmer
// ─────────────────────────────────────────────────────────────────────────────

export const PROGRAMMER_READ_FILE: ToolSchema = {
  name: 'read_file',
  description: 'Read the contents of a file.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to read' },
    },
    required: ['path'],
  },
};

export const PROGRAMMER_EDIT_FILE: ToolSchema = {
  name: 'edit_file',
  description: 'Edit a file by replacing a search string with a replacement string.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to edit' },
      search: { type: 'string', description: 'Exact text to find in the file' },
      replace: { type: 'string', description: 'Text to replace the search text with' },
    },
    required: ['path', 'search', 'replace'],
  },
};

export const PROGRAMMER_WRITE_FILE: ToolSchema = {
  name: 'write_file',
  description: 'Create or overwrite a file with the given content.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to write' },
      content: { type: 'string', description: 'Content to write to the file' },
    },
    required: ['path', 'content'],
  },
};

export const PROGRAMMER_GREP: ToolSchema = {
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

export const PROGRAMMER_LIST_FILES: ToolSchema = {
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

export const PROGRAMMER_BASH: ToolSchema = {
  name: 'bash',
  description: 'Run a shell command. Use for running tests, installing dependencies, etc.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
    },
    required: ['command'],
  },
};

/** Read-write tool set for the Programmer */
export const PROGRAMMER_TOOLS: ToolSchema[] = [
  PROGRAMMER_READ_FILE,
  PROGRAMMER_EDIT_FILE,
  PROGRAMMER_WRITE_FILE,
  PROGRAMMER_GREP,
  PROGRAMMER_LIST_FILES,
  PROGRAMMER_BASH,
];

// ─────────────────────────────────────────────────────────────────────────────
// Programmer Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface ProgrammerConfig {
  /** LLM provider (coder model) */
  provider: LlmProvider;

  /** Tool executor for read-write operations */
  executeTool: (call: NativeToolCall) => Promise<NativeToolResult>;

  /** Maximum ReAct turns */
  maxTurns: number;

  /** Temperature */
  temperature: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// System Prompt
// ─────────────────────────────────────────────────────────────────────────────

function buildProgrammerSystemPrompt(): string {
  return `You are the Programmer agent in a Continuous Integration loop.

Your role is to implement code changes based on requirements from the Architect.
You modify source code to fix failing tests while preserving passing tests.

## Your Workflow

1. **Read** the requirements from the Architect carefully
2. **Plan** your implementation approach for each requirement
3. **Read** the target files to understand current implementation
4. **Implement** changes using edit_file or write_file
5. **Verify** your changes make sense (read the modified files back)

## CRITICAL RULES

### Regression Prevention
- Before modifying any file, consider which passing tests depend on it
- Make MINIMAL, TARGETED changes — avoid large refactors
- Prefer ADDITIVE changes (new functions, new branches) over modifications to existing code
- If a requirement lists PROTECTED_TESTS, ensure your changes cannot break them
- When modifying shared code, add new code paths rather than changing existing ones

### Code Quality
- Write clean, readable code
- Maintain existing code style and conventions
- Add comments only where logic is non-obvious
- Do not introduce security vulnerabilities

### Change Tracking
After completing all modifications, provide a summary listing:
- Each file modified and what was changed
- Which requirements were addressed
- Which requirements were skipped and why
- Any concerns about potential regressions

## Output Format

After making all changes, output a structured summary:

<modifications>
[One per line: FILE_PATH | requirement_id | description | success/failure]
</modifications>

<addressed>
[Comma-separated list of addressed requirement IDs]
</addressed>

<skipped>
[One per line: requirement_id | reason]
</skipped>

<summary>
[Brief summary of all changes made]
</summary>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Programmer Execution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the Programmer agent to implement requirements from the Architect.
 *
 * @param config - Programmer configuration
 * @param analysis - Architect's analysis with requirements
 * @param architectContext - Agent message from the Architect (for perspective-shifted handoff)
 * @returns ProgrammerResult with all modifications made
 */
export async function runProgrammer(
  config: ProgrammerConfig,
  analysis: ArchitectAnalysis,
  architectContext?: AgentMessage,
): Promise<{ result: ProgrammerResult; agentResult: AgentResult }> {
  const taskPrompt = buildProgrammerTaskPrompt(analysis);

  // Create the Programmer delegate agent
  const programmer = createDelegateAgent({
    role: 'programmer',
    provider: config.provider,
    systemPrompt: buildProgrammerSystemPrompt(),
    tools: PROGRAMMER_TOOLS,
    executeTool: config.executeTool,
    maxTurns: config.maxTurns,
  });

  // Execute with Architect's context for perspective-shifted handoff
  const agentResult = await programmer.execute({
    prompt: taskPrompt,
    temperature: config.temperature,
    ...(architectContext ? { priorContext: [architectContext] } : {}),
  });

  // Parse the structured output
  const result = parseProgrammerOutput(agentResult.text, analysis.requirements);

  return { result, agentResult };
}

/**
 * Build the task prompt for the Programmer with Architect's requirements.
 */
function buildProgrammerTaskPrompt(analysis: ArchitectAnalysis): string {
  const sections: string[] = [];

  sections.push('# Implementation Requirements');
  sections.push('');
  sections.push(`The Architect has analyzed ${analysis.failingTestCount} failing test(s) and produced the following requirements.`);
  sections.push('');

  // Requirements
  for (const req of analysis.requirements) {
    sections.push(`## ${req.id}: ${req.title} [${req.priority}]`);
    sections.push('');
    sections.push(req.description);
    sections.push('');
    if (req.targetFiles.length > 0) {
      sections.push(`**Target files:** ${req.targetFiles.join(', ')}`);
    }
    if (req.relatedTests.length > 0) {
      sections.push(`**Tests to fix:** ${req.relatedTests.join(', ')}`);
    }
    if (req.protectedTests.length > 0) {
      sections.push(`**PROTECTED (must not break):** ${req.protectedTests.join(', ')}`);
    }
    sections.push('');
  }

  // Code locations from Architect
  if (analysis.locations.length > 0) {
    sections.push('## Code Locations Identified');
    for (const loc of analysis.locations) {
      const lineInfo = loc.startLine
        ? `:${loc.startLine}${loc.endLine ? `-${loc.endLine}` : ''}`
        : '';
      sections.push(`- **${loc.filePath}${lineInfo}**: ${loc.deficiency}`);
    }
    sections.push('');
  }

  // Protected tests warning
  if (analysis.passingTestsToProtect.length > 0) {
    sections.push('## Protected Tests (DO NOT BREAK)');
    sections.push('');
    sections.push(`There are ${analysis.passingTestsToProtect.length} currently passing test(s). ` +
      'Your changes MUST NOT cause any of these to fail.');
    sections.push('');
  }

  sections.push('## Instructions');
  sections.push('Implement all requirements in priority order. Read target files before modifying them. ' +
    'After all changes, provide your structured summary.');

  return sections.join('\n');
}

/**
 * Parse the Programmer's structured output into a ProgrammerResult.
 */
export function parseProgrammerOutput(
  text: string,
  requirements: Requirement[],
): ProgrammerResult {
  const modificationsRaw = extractSection(text, 'modifications') || '';
  const addressedRaw = extractSection(text, 'addressed') || '';
  const skippedRaw = extractSection(text, 'skipped') || '';
  const summary = extractSection(text, 'summary') || text;

  const modifications = parseModifications(modificationsRaw);
  const addressedIds = addressedRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const skippedRequirements = parseSkipped(skippedRaw);

  return {
    modifications,
    addressedRequirements: addressedIds,
    skippedRequirements,
    summary,
  };
}

function extractSection(text: string, tag: string): string | undefined {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
  const match = text.match(regex);
  return match?.[1]?.trim();
}

function parseModifications(raw: string): CodeModification[] {
  if (!raw) return [];
  const mods: CodeModification[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split('|').map((p) => p.trim());
    if (parts.length < 3) continue;

    const isFailure = parts[3]?.toLowerCase() === 'failure';
    const mod: CodeModification = {
      filePath: parts[0]!,
      requirementId: parts[1]!,
      description: parts[2]!,
      success: !isFailure,
    };
    if (isFailure) mod.error = parts[2]!;
    mods.push(mod);
  }

  return mods;
}

function parseSkipped(raw: string): Array<{ id: string; reason: string }> {
  if (!raw) return [];
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split('|').map((p) => p.trim());
    if (parts.length < 2) continue;

    skipped.push({
      id: parts[0]!,
      reason: parts[1]!,
    });
  }

  return skipped;
}
