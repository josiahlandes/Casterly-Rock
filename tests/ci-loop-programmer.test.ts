import { describe, expect, it } from 'vitest';

import { parseProgrammerOutput } from '../src/ci-loop/programmer.js';
import type { Requirement } from '../src/ci-loop/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Programmer Output Parsing
// ─────────────────────────────────────────────────────────────────────────────

describe('parseProgrammerOutput', () => {
  const requirements: Requirement[] = [
    {
      id: 'REQ-1',
      title: 'Add validation',
      description: 'Add input validation',
      priority: 'high',
      targetFiles: ['src/parser.ts'],
      relatedTests: ['test-a'],
      protectedTests: ['test-c'],
    },
    {
      id: 'REQ-2',
      title: 'Fix parsing',
      description: 'Fix numeric parsing',
      priority: 'medium',
      targetFiles: ['src/parser.ts'],
      relatedTests: ['test-b'],
      protectedTests: ['test-c'],
    },
  ];

  it('should parse structured output with all sections', () => {
    const text = `I've implemented the required changes.

<modifications>
src/parser.ts | REQ-1 | Added empty input guard clause | success
src/parser.ts | REQ-2 | Added numeric type validation | success
src/validators.ts | REQ-2 | Created isNumeric helper | success
</modifications>

<addressed>
REQ-1, REQ-2
</addressed>

<skipped>
</skipped>

<summary>
Added input validation and numeric type checking to the parser module.
Created a reusable isNumeric helper in validators.
</summary>`;

    const result = parseProgrammerOutput(text, requirements);

    expect(result.modifications).toHaveLength(3);
    expect(result.modifications[0]).toEqual({
      filePath: 'src/parser.ts',
      requirementId: 'REQ-1',
      description: 'Added empty input guard clause',
      success: true,
      error: undefined,
    });

    expect(result.addressedRequirements).toEqual(['REQ-1', 'REQ-2']);
    expect(result.skippedRequirements).toHaveLength(0);
    expect(result.summary).toContain('input validation');
  });

  it('should parse output with skipped requirements', () => {
    const text = `
<modifications>
src/parser.ts | REQ-1 | Added guard clause | success
</modifications>

<addressed>
REQ-1
</addressed>

<skipped>
REQ-2 | Cannot modify validators without breaking other modules
</skipped>

<summary>
Implemented REQ-1 only. REQ-2 was skipped due to risk.
</summary>`;

    const result = parseProgrammerOutput(text, requirements);
    expect(result.addressedRequirements).toEqual(['REQ-1']);
    expect(result.skippedRequirements).toHaveLength(1);
    expect(result.skippedRequirements[0]).toEqual({
      id: 'REQ-2',
      reason: 'Cannot modify validators without breaking other modules',
    });
  });

  it('should handle failed modifications', () => {
    const text = `
<modifications>
src/parser.ts | REQ-1 | Could not find the search string | failure
</modifications>

<addressed>
</addressed>

<skipped>
REQ-1 | Edit failed
REQ-2 | Dependent on REQ-1
</skipped>

<summary>
Failed to implement changes.
</summary>`;

    const result = parseProgrammerOutput(text, requirements);
    expect(result.modifications).toHaveLength(1);
    expect(result.modifications[0]!.success).toBe(false);
    expect(result.modifications[0]!.error).toBe('Could not find the search string');
  });

  it('should handle missing sections gracefully', () => {
    const text = 'I made some changes to the code but did not use the structured format.';
    const result = parseProgrammerOutput(text, requirements);

    expect(result.modifications).toHaveLength(0);
    expect(result.addressedRequirements).toHaveLength(0);
    expect(result.skippedRequirements).toHaveLength(0);
    expect(result.summary).toBe(text);
  });
});
