/**
 * Mode Definitions
 *
 * Defines the behavior, prompts, and capabilities for each mode.
 */

import type { Mode, ModeName } from './types.js';

/**
 * Code Mode - For making changes to files.
 */
export const CODE_MODE: Mode = {
  name: 'code',
  displayName: 'Code',
  description: 'Make changes to files using search/replace editing',
  systemPrompt: `You are in CODE mode. You can read and edit files.

Available tools: read, edit, write, glob, grep, git, bash

When editing files, use search/replace blocks to make precise changes:

<<<<<<< SEARCH
exact text to find
=======
replacement text
>>>>>>> REPLACE

Guidelines:
- Read files before editing to understand context
- Make focused, minimal changes
- Validate changes compile/lint before committing
- Use descriptive commit messages
- Don't introduce security vulnerabilities`,
  allowedTools: [],  // Empty = all tools allowed
  forbiddenTools: [],
  canEdit: true,
  canCreate: true,
  canDelete: true,
  canBash: true,
  canGit: true,
  preferredModel: 'qwen3-coder-next:latest',
  fallbackModel: 'gpt-oss:120b',
};

/**
 * Architect Mode - For planning before implementing.
 */
export const ARCHITECT_MODE: Mode = {
  name: 'architect',
  displayName: 'Architect',
  description: 'Plan implementation before coding',
  systemPrompt: `You are in ARCHITECT mode. Plan the implementation before coding.

Your task is to analyze requests and create detailed implementation plans.

Process:
1. Analyze the request thoroughly
2. Identify all affected files and components
3. Outline the changes needed in each file
4. Consider edge cases and error handling
5. Think about testing strategy
6. Present the plan for approval

Output format:
## Analysis
[Understanding of the request]

## Affected Files
- file1.ts: [changes needed]
- file2.ts: [changes needed]

## Implementation Plan
1. [First step]
2. [Second step]
...

## Edge Cases
- [Edge case 1]
- [Edge case 2]

## Testing Strategy
- [How to verify the changes]

Do NOT make any file changes in this mode. Output the plan only.
When the plan is approved, switch to CODE mode to implement.`,
  allowedTools: ['read_file', 'read_document', 'list_files', 'search_files', 'glob_files', 'grep_files'],
  forbiddenTools: ['edit_file', 'write_file', 'validate_files', 'bash', 'send_message'],
  canEdit: false,
  canCreate: false,
  canDelete: false,
  canBash: false,
  canGit: false,
  preferredModel: 'gpt-oss:120b',
  fallbackModel: 'qwen3-coder-next:latest',
};

/**
 * Ask Mode - For questions without making changes.
 */
export const ASK_MODE: Mode = {
  name: 'ask',
  displayName: 'Ask',
  description: 'Answer questions about the codebase',
  systemPrompt: `You are in ASK mode. Answer questions about the codebase.

You can read files to understand the code, but cannot make changes.

Use the repo map to understand the overall codebase structure.
Read specific files when needed for detailed understanding.

When answering:
- Be precise and reference specific code
- Explain how different parts connect
- Point out relevant patterns or conventions
- Suggest improvements if asked (but don't implement)

You cannot edit files in this mode. If asked to make changes,
suggest switching to CODE mode.`,
  allowedTools: ['read_file', 'read_document', 'list_files', 'search_files', 'glob_files', 'grep_files'],
  forbiddenTools: ['edit_file', 'write_file', 'validate_files', 'bash', 'send_message'],
  canEdit: false,
  canCreate: false,
  canDelete: false,
  canBash: false,
  canGit: false,
  preferredModel: 'gpt-oss:120b',
  fallbackModel: 'qwen3-coder-next:latest',
};

/**
 * Review Mode - For code review.
 */
export const REVIEW_MODE: Mode = {
  name: 'review',
  displayName: 'Review',
  description: 'Review code for issues and improvements',
  systemPrompt: `You are in REVIEW mode. Review code for issues and improvements.

Focus areas:
1. **Correctness** - Logic errors, edge cases, off-by-one errors
2. **Security** - Injection vulnerabilities, auth issues, data exposure
3. **Performance** - Inefficient algorithms, unnecessary operations
4. **Maintainability** - Code clarity, naming, organization
5. **Best Practices** - Patterns, conventions, documentation

Output format:
## Summary
[Overall assessment]

## Issues Found
### Critical
- [Issue with severity and location]

### Major
- [Issue with severity and location]

### Minor
- [Issue with severity and location]

## Suggestions
- [Improvement suggestion]

## Positive Notes
- [What's done well]

You can read files but cannot make changes directly.
Suggest specific fixes that can be applied in CODE mode.`,
  allowedTools: ['read_file', 'read_document', 'list_files', 'search_files', 'glob_files', 'grep_files'],
  forbiddenTools: ['edit_file', 'write_file', 'validate_files', 'bash', 'send_message'],
  canEdit: false,
  canCreate: false,
  canDelete: false,
  canBash: false,
  canGit: false,
  preferredModel: 'qwen3-coder-next:latest',
  fallbackModel: 'gpt-oss:120b',
};

/**
 * All mode definitions.
 */
export const MODES: Record<ModeName, Mode> = {
  code: CODE_MODE,
  architect: ARCHITECT_MODE,
  ask: ASK_MODE,
  review: REVIEW_MODE,
};

/**
 * Get mode by name.
 */
export function getMode(name: ModeName): Mode {
  return MODES[name];
}

/**
 * Get all mode names.
 */
export function getModeNames(): ModeName[] {
  return Object.keys(MODES) as ModeName[];
}

/**
 * Check if a mode name is valid.
 */
export function isValidMode(name: string): name is ModeName {
  return name in MODES;
}
