import { describe, expect, it } from 'vitest';

import { parseArchitectOutput } from '../src/ci-loop/architect.js';

// ─────────────────────────────────────────────────────────────────────────────
// Architect Output Parsing
// ─────────────────────────────────────────────────────────────────────────────

describe('parseArchitectOutput', () => {
  const failingTests = ['test-a', 'test-b'];
  const passingTests = ['test-c', 'test-d'];

  it('should parse structured output with all sections', () => {
    const text = `Some preamble text.

<analysis>
<summary>
Two tests are failing due to missing validation logic in the parser module.
test-a fails because the parser does not handle empty input.
test-b fails because the parser does not validate numeric fields.
</summary>

<locations>
src/parser.ts:42-58 | Missing empty input check | test-a
src/parser.ts:100-115 | No numeric validation | test-b
</locations>

<requirements>
REQ-1 | critical | Add empty input validation
Add a guard clause at the beginning of the parse function to handle empty input.
TARGET_FILES: src/parser.ts
RELATED_TESTS: test-a
PROTECTED_TESTS: test-c, test-d

REQ-2 | high | Add numeric field validation
Add type checking for numeric fields during parsing.
TARGET_FILES: src/parser.ts, src/validators.ts
RELATED_TESTS: test-b
PROTECTED_TESTS: test-c, test-d
</requirements>
</analysis>`;

    const analysis = parseArchitectOutput(text, failingTests, passingTests, 5);

    expect(analysis.summary).toContain('missing validation logic');
    expect(analysis.failingTestCount).toBe(2);
    expect(analysis.passingTestsToProtect).toEqual(passingTests);

    // Locations
    expect(analysis.locations).toHaveLength(2);
    expect(analysis.locations[0]!.filePath).toBe('src/parser.ts');
    expect(analysis.locations[0]!.startLine).toBe(42);
    expect(analysis.locations[0]!.endLine).toBe(58);
    expect(analysis.locations[0]!.deficiency).toBe('Missing empty input check');

    // Requirements
    expect(analysis.requirements).toHaveLength(2);
    expect(analysis.requirements[0]!.id).toBe('REQ-1');
    expect(analysis.requirements[0]!.priority).toBe('critical');
    expect(analysis.requirements[0]!.title).toBe('Add empty input validation');
    expect(analysis.requirements[0]!.targetFiles).toEqual(['src/parser.ts']);
    expect(analysis.requirements[0]!.relatedTests).toEqual(['test-a']);
    expect(analysis.requirements[0]!.protectedTests).toEqual(['test-c', 'test-d']);
  });

  it('should respect maxRequirements limit', () => {
    const text = `<analysis>
<summary>Many failures</summary>
<locations>
src/a.ts | issue | test-a
</locations>
<requirements>
REQ-1 | high | First
Fix first issue.
TARGET_FILES: src/a.ts
RELATED_TESTS: test-a
PROTECTED_TESTS: test-c

REQ-2 | medium | Second
Fix second issue.
TARGET_FILES: src/b.ts
RELATED_TESTS: test-b
PROTECTED_TESTS: test-c

REQ-3 | low | Third
Fix third issue.
TARGET_FILES: src/c.ts
RELATED_TESTS: test-c
PROTECTED_TESTS: test-d
</requirements>
</analysis>`;

    const analysis = parseArchitectOutput(text, failingTests, passingTests, 2);
    expect(analysis.requirements).toHaveLength(2);
    expect(analysis.requirements[0]!.id).toBe('REQ-1');
    expect(analysis.requirements[1]!.id).toBe('REQ-2');
  });

  it('should handle missing sections gracefully', () => {
    const text = 'Just some unstructured text about test failures.';
    const analysis = parseArchitectOutput(text, failingTests, passingTests, 5);

    expect(analysis.summary).toBe(text);
    expect(analysis.locations).toHaveLength(0);
    expect(analysis.requirements).toHaveLength(0);
    expect(analysis.failingTestCount).toBe(2);
  });

  it('should handle location without line numbers', () => {
    const text = `<analysis>
<summary>Issues found</summary>
<locations>
src/utils.ts | Missing helper function | test-a, test-b
</locations>
<requirements>
</requirements>
</analysis>`;

    const analysis = parseArchitectOutput(text, failingTests, passingTests, 5);
    expect(analysis.locations).toHaveLength(1);
    expect(analysis.locations[0]!.filePath).toBe('src/utils.ts');
    expect(analysis.locations[0]!.startLine).toBeUndefined();
    expect(analysis.locations[0]!.relatedTests).toEqual(['test-a', 'test-b']);
  });

  it('should default priority to medium for unknown values', () => {
    const text = `<analysis>
<summary>Test summary</summary>
<locations></locations>
<requirements>
REQ-1 | urgent | Fix something
Description here.
TARGET_FILES: src/a.ts
RELATED_TESTS: test-a
PROTECTED_TESTS: test-c
</requirements>
</analysis>`;

    const analysis = parseArchitectOutput(text, failingTests, passingTests, 5);
    expect(analysis.requirements[0]!.priority).toBe('medium');
  });
});
