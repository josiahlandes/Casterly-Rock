/**
 * Change Applier for Autoresearch
 *
 * Creates a ChangeApplier that uses an LLM provider with tool-use to
 * implement hypothesis changes via search-replace edits on source files.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { LlmProvider, PreviousAssistantMessage } from '../../providers/base.js';
import type {
  ToolSchema,
  ToolResultMessage,
  NativeToolCall,
} from '../../tools/schemas/types.js';
import type { Hypothesis, ChangeApplier, ChangeResult } from './autoresearch.js';
import { getTracer } from '../debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_TURNS = 10;
const MAX_TOKENS = 8192;

// ─────────────────────────────────────────────────────────────────────────────
// Tool Schemas
// ─────────────────────────────────────────────────────────────────────────────

const READ_FILE_TOOL: ToolSchema = {
  name: 'read_file',
  description: 'Read the contents of a file from the project.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative path to the file from the project root.',
      },
    },
    required: ['path'],
  },
};

const EDIT_FILE_TOOL: ToolSchema = {
  name: 'edit_file',
  description:
    'Apply a search-and-replace edit to a file. The old_string must match exactly ' +
    '(including whitespace/indentation). Provide enough surrounding context to make ' +
    'old_string unique in the file.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative path to the file from the project root.',
      },
      old_string: {
        type: 'string',
        description: 'The exact text to find and replace.',
      },
      new_string: {
        type: 'string',
        description: 'The replacement text.',
      },
    },
    required: ['path', 'old_string', 'new_string'],
  },
};

const TOOLS: ToolSchema[] = [READ_FILE_TOOL, EDIT_FILE_TOOL];

// ─────────────────────────────────────────────────────────────────────────────
// Path Validation
// ─────────────────────────────────────────────────────────────────────────────

function validatePath(filePath: string, workingDir: string): string | null {
  const resolved = path.resolve(workingDir, filePath);
  if (!resolved.startsWith(workingDir + path.sep) && resolved !== workingDir) {
    return null;
  }
  return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Executors
// ─────────────────────────────────────────────────────────────────────────────

async function executeReadFile(
  input: Record<string, unknown>,
  workingDir: string,
): Promise<{ result: string; isError: boolean }> {
  const filePath = String(input.path ?? '');
  const resolved = validatePath(filePath, workingDir);
  if (!resolved) {
    return { result: `Error: path "${filePath}" escapes working directory.`, isError: true };
  }
  try {
    const content = await fs.readFile(resolved, 'utf-8');
    return { result: content, isError: false };
  } catch (err) {
    return { result: `Error reading file: ${(err as Error).message}`, isError: true };
  }
}

async function executeEditFile(
  input: Record<string, unknown>,
  workingDir: string,
  modifiedFiles: Set<string>,
): Promise<{ result: string; isError: boolean }> {
  const filePath = String(input.path ?? '');
  const oldString = String(input.old_string ?? '');
  const newString = String(input.new_string ?? '');

  const resolved = validatePath(filePath, workingDir);
  if (!resolved) {
    return { result: `Error: path "${filePath}" escapes working directory.`, isError: true };
  }

  try {
    const content = await fs.readFile(resolved, 'utf-8');
    const idx = content.indexOf(oldString);
    if (idx === -1) {
      return {
        result: `Error: old_string not found in "${filePath}". Ensure exact whitespace/indentation match.`,
        isError: true,
      };
    }
    // Check uniqueness
    const secondIdx = content.indexOf(oldString, idx + 1);
    if (secondIdx !== -1) {
      return {
        result: `Error: old_string matches multiple locations in "${filePath}". Add more surrounding context to make it unique.`,
        isError: true,
      };
    }

    const updated = content.slice(0, idx) + newString + content.slice(idx + oldString.length);
    await fs.writeFile(resolved, updated, 'utf-8');
    modifiedFiles.add(filePath);
    return { result: `Successfully edited "${filePath}".`, isError: false };
  } catch (err) {
    return { result: `Error editing file: ${(err as Error).message}`, isError: true };
  }
}

async function executeTool(
  call: NativeToolCall,
  workingDir: string,
  modifiedFiles: Set<string>,
): Promise<{ result: string; isError: boolean }> {
  switch (call.name) {
    case 'read_file':
      return executeReadFile(call.input, workingDir);
    case 'edit_file':
      return executeEditFile(call.input, workingDir, modifiedFiles);
    default:
      return { result: `Unknown tool: ${call.name}`, isError: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// System Prompt
// ─────────────────────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return [
    'You are a precise code editor. Your job is to implement a specific change to the codebase.',
    '',
    'Rules:',
    '1. Read the target files first to understand current code.',
    '2. Make minimal, surgical edits using edit_file. Do NOT rewrite entire files.',
    '3. Preserve existing code style, indentation, and conventions.',
    '4. old_string must be an exact match — copy from read_file output verbatim.',
    '5. Include enough context in old_string to make it unique in the file.',
    '6. Only modify files relevant to the hypothesis.',
    '7. When done, respond with a brief summary of changes made.',
  ].join('\n');
}

function buildUserPrompt(hypothesis: Hypothesis, fileContents: string): string {
  return [
    `## Hypothesis: ${hypothesis.title}`,
    '',
    hypothesis.description,
    '',
    `**Expected outcome:** ${hypothesis.expectedOutcome}`,
    '',
    `**Target files:** ${hypothesis.targetFiles.join(', ')}`,
    '',
    '## Current File Contents',
    '',
    fileContents,
    '',
    'Implement the change described above using edit_file. Read additional files if needed.',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a ChangeApplier that uses an LLM provider to implement hypothesis
 * changes via a multi-turn tool-use loop.
 *
 * The engine handles git snapshot/revert — this function only applies edits.
 */
export function createChangeApplier(
  provider: LlmProvider,
  workingDir: string,
): ChangeApplier {
  const tracer = getTracer();

  return async (hypothesis: Hypothesis): Promise<ChangeResult> => {
    const modifiedFiles = new Set<string>();

    try {
      // Pre-read target files so the model has context in the first turn
      const fileContentParts: string[] = [];
      for (const relPath of hypothesis.targetFiles) {
        const resolved = validatePath(relPath, workingDir);
        if (!resolved) continue;
        try {
          const content = await fs.readFile(resolved, 'utf-8');
          fileContentParts.push(`### ${relPath}\n\`\`\`\n${content}\n\`\`\``);
        } catch {
          fileContentParts.push(`### ${relPath}\n(file not found — will be created)`);
        }
      }

      const userPrompt = buildUserPrompt(hypothesis, fileContentParts.join('\n\n'));

      // Multi-turn tool-use loop
      const conversationHistory: PreviousAssistantMessage[] = [];
      const allToolResults: ToolResultMessage[] = [];

      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const response = await provider.generateWithTools(
          {
            prompt: userPrompt,
            systemPrompt: buildSystemPrompt(),
            maxTokens: MAX_TOKENS,
            temperature: 0,
            providerOptions: { think: false },
            ...(conversationHistory.length > 0
              ? { previousAssistantMessages: conversationHistory }
              : {}),
          },
          TOOLS,
          allToolResults.length > 0 ? allToolResults : undefined,
        );

        // No tool calls → model is done
        if (!response.toolCalls || response.toolCalls.length === 0) {
          tracer.log('dream', 'debug',
            `Turn ${turn + 1}: model finished — ${modifiedFiles.size} file(s) modified`,
          );
          break;
        }

        tracer.log('dream', 'debug',
          `Turn ${turn + 1}: ${response.toolCalls.length} tool call(s): ${response.toolCalls.map((c) => c.name).join(', ')}`,
        );

        // Record assistant turn
        conversationHistory.push({
          text: response.text,
          toolCalls: response.toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.input),
          })),
        });

        // Execute tools and accumulate results
        for (const call of response.toolCalls) {
          const { result, isError } = await executeTool(call, workingDir, modifiedFiles);
          allToolResults.push({
            callId: call.id,
            result,
            ...(isError ? { isError: true } : {}),
          });
        }
      }

      if (modifiedFiles.size === 0) {
        return {
          success: false,
          modifiedFiles: [],
          error: 'LLM did not modify any files.',
        };
      }

      tracer.log('dream', 'info',
        `Applied hypothesis "${hypothesis.title}" — modified: ${[...modifiedFiles].join(', ')}`,
      );

      return {
        success: true,
        modifiedFiles: [...modifiedFiles],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tracer.log('dream', 'error',
        `Failed to apply hypothesis "${hypothesis.title}": ${msg}`,
      );
      return {
        success: false,
        modifiedFiles: [...modifiedFiles],
        error: msg,
      };
    }
  };
}
