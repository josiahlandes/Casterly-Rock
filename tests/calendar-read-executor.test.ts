import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createCalendarReadExecutor } from '../src/tools/executors/calendar-read.js';
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
  return { id: 'test-call-1', name: 'calendar_read', input };
}

describe('createCalendarReadExecutor', () => {
  let executor: ReturnType<typeof createCalendarReadExecutor>;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = createCalendarReadExecutor();
  });

  it('has the correct toolName', () => {
    expect(executor.toolName).toBe('calendar_read');
  });

  it('returns events from Calendar.app', async () => {
    const events = [
      {
        title: 'Team Standup',
        startDate: '2026-02-15T09:00:00.000Z',
        endDate: '2026-02-15T09:30:00.000Z',
        isAllDay: false,
        location: 'Zoom',
        notes: '',
        calendar: 'Work',
      },
    ];
    mockExecSync.mockReturnValue(JSON.stringify(events));

    const result = await executor.execute(makeCall({ from: 'today', to: 'tomorrow' }));

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!);
    expect(output.count).toBe(1);
    expect(output.events[0].title).toBe('Team Standup');
    expect(output.events[0].calendar).toBe('Work');
  });

  it('defaults to today if no dates provided', async () => {
    mockExecSync.mockReturnValue('[]');

    const result = await executor.execute(makeCall({}));

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!);
    expect(output.count).toBe(0);
    expect(output.calendar).toBe('all');
  });

  it('passes calendar filter to script', async () => {
    mockExecSync.mockReturnValue('[]');

    await executor.execute(makeCall({ calendar: 'Personal' }));

    const scriptArg = mockExecSync.mock.calls[0]![0] as string;
    expect(scriptArg).toContain('Personal');
  });

  it('sorts events by start date', async () => {
    const events = [
      {
        title: 'Late Meeting',
        startDate: '2026-02-15T15:00:00.000Z',
        endDate: '2026-02-15T16:00:00.000Z',
        isAllDay: false,
        location: '',
        notes: '',
        calendar: 'Work',
      },
      {
        title: 'Early Meeting',
        startDate: '2026-02-15T08:00:00.000Z',
        endDate: '2026-02-15T09:00:00.000Z',
        isAllDay: false,
        location: '',
        notes: '',
        calendar: 'Work',
      },
    ];
    mockExecSync.mockReturnValue(JSON.stringify(events));

    const result = await executor.execute(makeCall({}));
    const output = JSON.parse(result.output!);

    expect(output.events[0].title).toBe('Early Meeting');
    expect(output.events[1].title).toBe('Late Meeting');
  });

  it('handles permission error', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not allowed to send Apple events');
    });

    const result = await executor.execute(makeCall({}));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Calendar access denied');
    expect(result.error).toContain('Automation');
  });

  it('handles invalid from date', async () => {
    const result = await executor.execute(makeCall({ from: 'not-a-date' }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot parse date');
  });

  it('handles JXA script returning invalid JSON', async () => {
    mockExecSync.mockReturnValue('not json at all');

    const result = await executor.execute(makeCall({}));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to parse Calendar response');
  });

  it('handles general execution error', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('Calendar.app not running');
    });

    const result = await executor.execute(makeCall({}));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Calendar read failed');
  });

  it('caps limit at 200', async () => {
    mockExecSync.mockReturnValue('[]');

    await executor.execute(makeCall({ limit: 500 }));

    const scriptArg = mockExecSync.mock.calls[0]![0] as string;
    expect(scriptArg).toContain('200');
  });

  it('accepts +Nd offset dates', async () => {
    mockExecSync.mockReturnValue('[]');

    const result = await executor.execute(makeCall({ from: 'today', to: '+3d' }));

    expect(result.success).toBe(true);
  });

  it('accepts "this week" as date range', async () => {
    mockExecSync.mockReturnValue('[]');

    const result = await executor.execute(makeCall({ from: 'this week', to: 'this week' }));

    expect(result.success).toBe(true);
  });

  it('accepts ISO date strings', async () => {
    mockExecSync.mockReturnValue('[]');

    const result = await executor.execute(makeCall({
      from: '2026-03-01T00:00:00Z',
      to: '2026-03-07T00:00:00Z',
    }));

    expect(result.success).toBe(true);
  });
});
