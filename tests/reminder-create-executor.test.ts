import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createReminderCreateExecutor } from '../src/tools/executors/reminder-create.js';
import type { NativeToolCall } from '../src/tools/schemas/types.js';

// Mock child_process.execSync
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

// Mock safeLogger
vi.mock('../src/logging/safe-logger.js', () => ({
  safeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { execSync } from 'node:child_process';

const mockExecSync = vi.mocked(execSync);

function makeCall(input: Record<string, unknown>): NativeToolCall {
  return { id: 'test-call-1', name: 'reminder_create', input };
}

describe('createReminderCreateExecutor', () => {
  let executor: ReturnType<typeof createReminderCreateExecutor>;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = createReminderCreateExecutor();
  });

  it('has the correct toolName', () => {
    expect(executor.toolName).toBe('reminder_create');
  });

  it('creates a reminder successfully', async () => {
    const response = {
      id: 'reminder-123',
      name: 'Buy groceries',
      list: 'Reminders',
      dueDate: '2026-02-16T09:00:00.000Z',
      priority: 0,
    };
    mockExecSync.mockReturnValue(JSON.stringify(response));

    const result = await executor.execute(makeCall({
      title: 'Buy groceries',
      dueDate: 'tomorrow',
    }));

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!);
    expect(output.created).toBe(true);
    expect(output.name).toBe('Buy groceries');
    expect(output.list).toBe('Reminders');
  });

  it('rejects empty title', async () => {
    const result = await executor.execute(makeCall({ title: '' }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('title must be a non-empty string');
  });

  it('rejects missing title', async () => {
    const result = await executor.execute(makeCall({}));

    expect(result.success).toBe(false);
    expect(result.error).toContain('title must be a non-empty string');
  });

  it('rejects title over 500 characters', async () => {
    const result = await executor.execute(makeCall({ title: 'x'.repeat(501) }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Title too long');
  });

  it('rejects notes over 2000 characters', async () => {
    const result = await executor.execute(makeCall({
      title: 'Test',
      notes: 'x'.repeat(2001),
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Notes too long');
  });

  it('passes list name to script', async () => {
    mockExecSync.mockReturnValue(JSON.stringify({
      id: 'r1', name: 'Task', list: 'Work', dueDate: null, priority: 0,
    }));

    await executor.execute(makeCall({ title: 'Task', list: 'Work' }));

    const scriptArg = mockExecSync.mock.calls[0]![0] as string;
    expect(scriptArg).toContain('Work');
  });

  it('accepts +Nd due date offset', async () => {
    mockExecSync.mockReturnValue(JSON.stringify({
      id: 'r1', name: 'Review PR', list: 'Reminders', dueDate: null, priority: 0,
    }));

    const result = await executor.execute(makeCall({
      title: 'Review PR',
      dueDate: '+3d',
    }));

    expect(result.success).toBe(true);
  });

  it('accepts +Nh due date offset', async () => {
    mockExecSync.mockReturnValue(JSON.stringify({
      id: 'r1', name: 'Follow up', list: 'Reminders', dueDate: null, priority: 0,
    }));

    const result = await executor.execute(makeCall({
      title: 'Follow up',
      dueDate: '+2h',
    }));

    expect(result.success).toBe(true);
  });

  it('rejects invalid due date', async () => {
    const result = await executor.execute(makeCall({
      title: 'Test',
      dueDate: 'not-a-date',
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot parse due date');
  });

  it('maps priority 1-3 to high (1)', async () => {
    mockExecSync.mockReturnValue(JSON.stringify({
      id: 'r1', name: 'Urgent', list: 'Reminders', dueDate: null, priority: 1,
    }));

    await executor.execute(makeCall({ title: 'Urgent', priority: 2 }));

    const scriptArg = mockExecSync.mock.calls[0]![0] as string;
    // Apple priority 1 = high
    expect(scriptArg).toContain('props.priority = 1');
  });

  it('maps priority 4-6 to medium (5)', async () => {
    mockExecSync.mockReturnValue(JSON.stringify({
      id: 'r1', name: 'Normal', list: 'Reminders', dueDate: null, priority: 5,
    }));

    await executor.execute(makeCall({ title: 'Normal', priority: 5 }));

    const scriptArg = mockExecSync.mock.calls[0]![0] as string;
    expect(scriptArg).toContain('props.priority = 5');
  });

  it('maps priority 7-9 to low (9)', async () => {
    mockExecSync.mockReturnValue(JSON.stringify({
      id: 'r1', name: 'Low', list: 'Reminders', dueDate: null, priority: 9,
    }));

    await executor.execute(makeCall({ title: 'Low', priority: 8 }));

    const scriptArg = mockExecSync.mock.calls[0]![0] as string;
    expect(scriptArg).toContain('props.priority = 9');
  });

  it('handles permission error', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not allowed to send Apple events');
    });

    const result = await executor.execute(makeCall({ title: 'Test' }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Reminders access denied');
    expect(result.error).toContain('Automation');
  });

  it('handles invalid JSON response', async () => {
    mockExecSync.mockReturnValue('not json');

    const result = await executor.execute(makeCall({ title: 'Test' }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to parse Reminders response');
  });

  it('handles general execution error', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('Reminders.app crashed');
    });

    const result = await executor.execute(makeCall({ title: 'Test' }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Reminder creation failed');
  });

  it('creates reminder without due date', async () => {
    mockExecSync.mockReturnValue(JSON.stringify({
      id: 'r1', name: 'Quick note', list: 'Reminders', dueDate: null, priority: 0,
    }));

    const result = await executor.execute(makeCall({ title: 'Quick note' }));

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!);
    expect(output.dueDate).toBeNull();
  });

  it('accepts "today" as due date', async () => {
    mockExecSync.mockReturnValue(JSON.stringify({
      id: 'r1', name: 'EOD task', list: 'Reminders', dueDate: null, priority: 0,
    }));

    const result = await executor.execute(makeCall({
      title: 'EOD task',
      dueDate: 'today',
    }));

    expect(result.success).toBe(true);
  });
});
