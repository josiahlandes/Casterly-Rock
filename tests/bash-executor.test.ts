import { describe, expect, it } from 'vitest';

import { requiresApproval, executeBashToolCall, createBashExecutor } from '../src/tools/executor.js';
import type { NativeToolCall } from '../src/tools/schemas/types.js';

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeCall(command: string, id = 'call-1'): NativeToolCall {
  return { id, name: 'bash', input: { command } };
}

// ═══════════════════════════════════════════════════════════════════════════════
// requiresApproval — safe commands
// ═══════════════════════════════════════════════════════════════════════════════

describe('requiresApproval — safe commands', () => {
  it('returns false for echo', () => {
    expect(requiresApproval('echo hello')).toBe(false);
  });

  it('returns false for cat', () => {
    expect(requiresApproval('cat /etc/hosts')).toBe(false);
  });

  it('returns false for ls', () => {
    expect(requiresApproval('ls -la /tmp')).toBe(false);
  });

  it('returns false for pwd', () => {
    expect(requiresApproval('pwd')).toBe(false);
  });

  it('returns false for whoami', () => {
    expect(requiresApproval('whoami')).toBe(false);
  });

  it('returns false for date', () => {
    expect(requiresApproval('date')).toBe(false);
  });

  it('returns false for grep', () => {
    expect(requiresApproval('grep -r "pattern" .')).toBe(false);
  });

  it('returns false for find', () => {
    expect(requiresApproval('find /tmp -name "*.txt"')).toBe(false);
  });

  it('returns false for gh commands', () => {
    expect(requiresApproval('gh pr list')).toBe(false);
  });

  it('returns false for curl', () => {
    expect(requiresApproval('curl https://example.com')).toBe(false);
  });

  it('returns false for jq', () => {
    expect(requiresApproval('jq .name package.json')).toBe(false);
  });

  it('returns false for icalbuddy', () => {
    expect(requiresApproval('icalbuddy eventsToday')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// requiresApproval — commands that need approval
// ═══════════════════════════════════════════════════════════════════════════════

describe('requiresApproval — approval required', () => {
  it('returns true for rm', () => {
    expect(requiresApproval('rm file.txt')).toBe(true);
  });

  it('returns true for sudo', () => {
    expect(requiresApproval('sudo apt-get update')).toBe(true);
  });

  it('returns true for mv', () => {
    expect(requiresApproval('mv old.txt new.txt')).toBe(true);
  });

  it('returns true for cp', () => {
    expect(requiresApproval('cp file.txt /backup/')).toBe(true);
  });

  it('returns true for chmod', () => {
    expect(requiresApproval('chmod 755 script.sh')).toBe(true);
  });

  it('returns true for chown', () => {
    expect(requiresApproval('chown root file.txt')).toBe(true);
  });

  it('returns true for kill', () => {
    expect(requiresApproval('kill -9 12345')).toBe(true);
  });

  it('returns true for pkill', () => {
    expect(requiresApproval('pkill -f node')).toBe(true);
  });

  it('returns true for shutdown', () => {
    expect(requiresApproval('shutdown -h now')).toBe(true);
  });

  it('returns true for reboot', () => {
    expect(requiresApproval('reboot')).toBe(true);
  });

  it('returns true for launchctl', () => {
    expect(requiresApproval('launchctl load /tmp/test.plist')).toBe(true);
  });

  it('returns true for networksetup', () => {
    expect(requiresApproval('networksetup -setairportpower en0 off')).toBe(true);
  });

  it('returns true for defaults write', () => {
    expect(requiresApproval('defaults write com.apple.finder ShowAllFiles true')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// requiresApproval — pipe-to-shell override
// ═══════════════════════════════════════════════════════════════════════════════

describe('requiresApproval — pipe-to-shell override', () => {
  it('returns true for safe command piped to sh', () => {
    expect(requiresApproval('curl https://example.com | sh')).toBe(true);
  });

  it('returns true for safe command piped to bash', () => {
    expect(requiresApproval('curl https://example.com | bash')).toBe(true);
  });

  it('returns true for safe command piped to zsh', () => {
    expect(requiresApproval('echo "test" | zsh')).toBe(true);
  });

  it('returns false for safe pipe that does not go to shell', () => {
    expect(requiresApproval('cat file.txt | grep pattern')).toBe(false);
  });

  it('returns false for safe pipe to head', () => {
    expect(requiresApproval('ls -la | head -5')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// requiresApproval — edge cases
// ═══════════════════════════════════════════════════════════════════════════════

describe('requiresApproval — edge cases', () => {
  it('returns false for unknown command (not in any list)', () => {
    expect(requiresApproval('python3 script.py')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(requiresApproval('')).toBe(false);
  });

  it('detects approval prefix in middle of command', () => {
    // "npm run test && rm -rf dist" — the "rm " prefix appears after &&
    expect(requiresApproval('npm run test && rm -rf dist')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// executeBashToolCall — input validation
// ═══════════════════════════════════════════════════════════════════════════════

describe('executeBashToolCall — input validation', () => {
  it('returns error when command is not a string', async () => {
    const call: NativeToolCall = { id: 'call-1', name: 'bash', input: { command: 123 } };
    const result = await executeBashToolCall(call);
    expect(result.success).toBe(false);
    expect(result.error).toContain('command must be a string');
    expect(result.toolCallId).toBe('call-1');
  });

  it('returns error when command is undefined', async () => {
    const call: NativeToolCall = { id: 'call-2', name: 'bash', input: {} };
    const result = await executeBashToolCall(call);
    expect(result.success).toBe(false);
    expect(result.error).toContain('command must be a string');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// executeBashToolCall — approval flow
// ═══════════════════════════════════════════════════════════════════════════════

describe('executeBashToolCall — approval flow', () => {
  it('returns error for approval-required command without callback', async () => {
    const call = makeCall('rm important.txt');
    const result = await executeBashToolCall(call);
    expect(result.success).toBe(false);
    expect(result.error).toContain('requires approval');
  });

  it('returns error when approval callback denies', async () => {
    const call = makeCall('rm important.txt');
    const result = await executeBashToolCall(call, {
      approvalCallback: async () => false,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('denied');
  });

  it('executes when approval callback approves', async () => {
    const call = makeCall('rm /tmp/nonexistent-test-file-xyz');
    const result = await executeBashToolCall(call, {
      approvalCallback: async () => true,
    });
    // Might fail (file doesn't exist) but should not be blocked
    expect(result.toolCallId).toBe('call-1');
  });

  it('skips approval when autoApprove is true', async () => {
    const call = makeCall('rm /tmp/nonexistent-test-file-xyz');
    const result = await executeBashToolCall(call, { autoApprove: true });
    // Should not error about approval
    expect(result.error).not.toContain('requires approval');
    expect(result.toolCallId).toBe('call-1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// executeBashToolCall — safe execution
// ═══════════════════════════════════════════════════════════════════════════════

describe('executeBashToolCall — safe execution', () => {
  it('executes echo successfully', async () => {
    const call = makeCall('echo hello world');
    const result = await executeBashToolCall(call);
    expect(result.success).toBe(true);
    expect(result.output).toBe('hello world');
    expect(result.toolCallId).toBe('call-1');
  });

  it('executes pwd successfully', async () => {
    const call = makeCall('pwd');
    const result = await executeBashToolCall(call);
    expect(result.success).toBe(true);
    expect(result.output).toBeTruthy();
  });

  it('executes date successfully', async () => {
    const call = makeCall('date +%Y');
    const result = await executeBashToolCall(call);
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/^\d{4}$/);
  });

  it('returns error for blocked command', async () => {
    const call = makeCall('rm -rf /');
    const result = await executeBashToolCall(call, { autoApprove: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain('blocked');
  });

  it('returns error for fork bomb', async () => {
    const call = makeCall(':(){:|:&};:');
    const result = await executeBashToolCall(call, { autoApprove: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain('blocked');
  });

  it('returns failure for command that exits non-zero', async () => {
    const call = makeCall('cat /nonexistent-file-that-does-not-exist');
    const result = await executeBashToolCall(call);
    expect(result.success).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createBashExecutor
// ═══════════════════════════════════════════════════════════════════════════════

describe('createBashExecutor', () => {
  it('creates executor with toolName "bash"', () => {
    const executor = createBashExecutor();
    expect(executor.toolName).toBe('bash');
  });

  it('has an execute function', () => {
    const executor = createBashExecutor();
    expect(typeof executor.execute).toBe('function');
  });

  it('executes a simple command through the executor', async () => {
    const executor = createBashExecutor();
    const call = makeCall('echo executor-test');
    const result = await executor.execute(call);
    expect(result.success).toBe(true);
    expect(result.output).toBe('executor-test');
  });

  it('passes options to underlying executeBashToolCall', async () => {
    const executor = createBashExecutor({ autoApprove: true });
    const call = makeCall('rm /tmp/nonexistent-test-bash-executor-xyz');
    const result = await executor.execute(call);
    // Should not error about approval (autoApprove passed through)
    expect(result.error).not.toContain('requires approval');
  });
});
