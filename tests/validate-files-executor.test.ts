import { describe, expect, it } from 'vitest';

import { createValidateFilesExecutor } from '../src/tools/executors/validate-files.js';

function makeCall(input: Record<string, unknown>) {
  return { id: 'call-1', name: 'validate_files', input };
}

// ═══════════════════════════════════════════════════════════════════════════════
// createValidateFilesExecutor — structure
// ═══════════════════════════════════════════════════════════════════════════════

describe('createValidateFilesExecutor — structure', () => {
  it('returns executor with correct toolName', () => {
    const executor = createValidateFilesExecutor();
    expect(executor.toolName).toBe('validate_files');
  });

  it('has execute function', () => {
    const executor = createValidateFilesExecutor();
    expect(typeof executor.execute).toBe('function');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createValidateFilesExecutor — input validation
// ═══════════════════════════════════════════════════════════════════════════════

describe('createValidateFilesExecutor — input validation', () => {
  it('fails for empty files array', async () => {
    const executor = createValidateFilesExecutor();
    const result = await executor.execute(makeCall({ files: [] }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('non-empty array');
  });

  it('fails for non-array files', async () => {
    const executor = createValidateFilesExecutor();
    const result = await executor.execute(makeCall({ files: 'not-an-array' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('non-empty array');
  });

  it('fails when all paths are empty strings', async () => {
    const executor = createValidateFilesExecutor();
    const result = await executor.execute(makeCall({ files: ['', '  ', ''] }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('no valid file paths');
  });

  it('fails for undefined files', async () => {
    const executor = createValidateFilesExecutor();
    const result = await executor.execute(makeCall({}));
    expect(result.success).toBe(false);
    expect(result.error).toContain('non-empty array');
  });

  it('returns toolCallId', async () => {
    const executor = createValidateFilesExecutor();
    const result = await executor.execute(makeCall({ files: [] }));
    expect(result.toolCallId).toBe('call-1');
  });
});
