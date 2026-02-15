import { describe, expect, it } from 'vitest';

import { createSendMessageExecutor } from '../src/tools/executors/send-message.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCall(input: Record<string, unknown>) {
  return { id: 'call-1', name: 'send_message', input };
}

// ═══════════════════════════════════════════════════════════════════════════════
// createSendMessageExecutor — structure
// ═══════════════════════════════════════════════════════════════════════════════

describe('createSendMessageExecutor — structure', () => {
  it('returns executor with correct toolName', () => {
    const executor = createSendMessageExecutor();
    expect(executor.toolName).toBe('send_message');
  });

  it('has execute function', () => {
    const executor = createSendMessageExecutor();
    expect(typeof executor.execute).toBe('function');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createSendMessageExecutor — input validation
// ═══════════════════════════════════════════════════════════════════════════════

describe('createSendMessageExecutor — input validation', () => {
  it('fails for empty recipient', async () => {
    const executor = createSendMessageExecutor();
    const result = await executor.execute(
      makeCall({ recipient: '', text: 'Hello' })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('recipient');
  });

  it('fails for empty text', async () => {
    const executor = createSendMessageExecutor();
    const result = await executor.execute(
      makeCall({ recipient: '+15551234567', text: '' })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('text');
  });

  it('fails for invalid recipient format', async () => {
    const executor = createSendMessageExecutor();
    const result = await executor.execute(
      makeCall({ recipient: 'not-a-phone-or-email', text: 'Hello' })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid recipient');
  });

  it('fails for too-long message', async () => {
    const executor = createSendMessageExecutor();
    const result = await executor.execute(
      makeCall({ recipient: '+15551234567', text: 'x'.repeat(5001) })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('too long');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createSendMessageExecutor — recipient validation
// ═══════════════════════════════════════════════════════════════════════════════

describe('createSendMessageExecutor — recipient validation', () => {
  it('rejects plain text', async () => {
    const executor = createSendMessageExecutor();
    const result = await executor.execute(
      makeCall({ recipient: 'John', text: 'Hi' })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid recipient');
  });

  it('rejects short phone number', async () => {
    const executor = createSendMessageExecutor();
    const result = await executor.execute(
      makeCall({ recipient: '+123', text: 'Hi' })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid recipient');
  });

  it('rejects email without domain', async () => {
    const executor = createSendMessageExecutor();
    const result = await executor.execute(
      makeCall({ recipient: 'user@', text: 'Hi' })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid recipient');
  });
});
