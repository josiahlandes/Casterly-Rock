import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildAgentToolkit,
  THINK_SCHEMA,
  READ_FILE_SCHEMA,
  EDIT_FILE_SCHEMA,
  CREATE_FILE_SCHEMA,
  GREP_SCHEMA,
  GLOB_SCHEMA,
  BASH_SCHEMA,
  RUN_TESTS_SCHEMA,
  TYPECHECK_SCHEMA,
  LINT_SCHEMA,
  GIT_STATUS_SCHEMA,
  GIT_DIFF_SCHEMA,
  GIT_COMMIT_SCHEMA,
  GIT_LOG_SCHEMA,
  FILE_ISSUE_SCHEMA,
  CLOSE_ISSUE_SCHEMA,
  UPDATE_GOAL_SCHEMA,
  DELEGATE_SCHEMA,
  MESSAGE_USER_SCHEMA,
} from '../src/autonomous/agent-tools.js';
import type { AgentState, AgentToolkit, AgentToolkitConfig } from '../src/autonomous/agent-tools.js';
import { GoalStack } from '../src/autonomous/goal-stack.js';
import { IssueLog } from '../src/autonomous/issue-log.js';
import { WorldModel } from '../src/autonomous/world-model.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';
import type { NativeToolCall } from '../src/tools/schemas/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let tempDir: string;
let toolkit: AgentToolkit;
let state: AgentState;

function makeCall(name: string, input: Record<string, unknown>): NativeToolCall {
  return { id: `call-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name, input };
}

async function setupToolkit(configOverrides?: Partial<AgentToolkitConfig>): Promise<void> {
  const goalStack = new GoalStack({ path: join(tempDir, 'goals.yaml') });
  const issueLog = new IssueLog({ path: join(tempDir, 'issues.yaml') });
  const worldModel = new WorldModel({ path: join(tempDir, 'world-model.yaml'), projectRoot: tempDir });

  state = { goalStack, issueLog, worldModel };

  toolkit = buildAgentToolkit(
    {
      projectRoot: tempDir,
      maxOutputChars: 5000,
      commandTimeoutMs: 10_000,
      allowedDirectories: ['src/', 'tests/', 'scripts/'],
      forbiddenPatterns: ['**/*.env*', '**/secrets*'],
      delegationEnabled: false,
      userMessagingEnabled: false,
      ...configOverrides,
    },
    state,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup / Teardown
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  resetTracer();
  initTracer({ enabled: false });
  tempDir = await mkdtemp(join(tmpdir(), 'casterly-agent-tools-'));

  // Create project structure in temp dir
  await mkdir(join(tempDir, 'src'), { recursive: true });
  await mkdir(join(tempDir, 'tests'), { recursive: true });
  await mkdir(join(tempDir, 'scripts'), { recursive: true });

  await setupToolkit();
});

afterEach(async () => {
  resetTracer();
  await rm(tempDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('AgentToolkit — Schema Validation', () => {
  it('exposes all 66 tool schemas', () => {
    expect(toolkit.schemas).toHaveLength(66);
    expect(toolkit.toolNames).toHaveLength(66);
  });

  it('includes all expected tool names', () => {
    const names = toolkit.toolNames;
    const expected = [
      'think', 'read_file', 'edit_file', 'create_file',
      'grep', 'glob', 'bash',
      'run_tests', 'typecheck', 'lint',
      'git_status', 'git_diff', 'git_commit', 'git_log',
      'file_issue', 'close_issue', 'update_goal',
      'delegate', 'message_user',
      'recall', 'archive',
      'adversarial_test', 'update_world_model',
      'recall_journal', 'consolidate',
      // Vision Tier 1
      'crystallize', 'dissolve', 'list_crystals',
      'create_rule', 'update_rule', 'list_rules',
      'replay', 'compare_traces', 'search_traces',
      // Vision Tier 2
      'edit_prompt', 'revert_prompt', 'get_prompt',
      'shadow', 'list_shadows',
      'create_tool', 'manage_tools', 'list_custom_tools',
      // Vision Tier 3
      'run_challenges', 'challenge_history', 'evolve_prompt',
      'evolution_status', 'extract_training_data', 'list_adapters',
      'load_adapter',
      // Roadmap Phases 1-5 + Supporting
      'meta',
      'classify', 'plan', 'verify',
      'peek_queue', 'check_budget', 'list_context', 'review_steps', 'assess_self',
      'load_context', 'evict_context', 'set_budget',
      'schedule', 'list_schedules', 'cancel_schedule',
      'semantic_recall', 'parallel_reason',
    ];
    for (const name of expected) {
      expect(names).toContain(name);
    }
  });

  it('all schemas have required fields', () => {
    for (const schema of toolkit.schemas) {
      expect(schema.name).toBeTruthy();
      expect(schema.description).toBeTruthy();
      expect(schema.inputSchema).toBeTruthy();
      expect(schema.inputSchema.type).toBe('object');
      expect(schema.inputSchema.properties).toBeTruthy();
      expect(schema.inputSchema.required).toBeDefined();
    }
  });

  it('all schemas are individually exported', () => {
    expect(THINK_SCHEMA.name).toBe('think');
    expect(READ_FILE_SCHEMA.name).toBe('read_file');
    expect(EDIT_FILE_SCHEMA.name).toBe('edit_file');
    expect(CREATE_FILE_SCHEMA.name).toBe('create_file');
    expect(GREP_SCHEMA.name).toBe('grep');
    expect(GLOB_SCHEMA.name).toBe('glob');
    expect(BASH_SCHEMA.name).toBe('bash');
    expect(RUN_TESTS_SCHEMA.name).toBe('run_tests');
    expect(TYPECHECK_SCHEMA.name).toBe('typecheck');
    expect(LINT_SCHEMA.name).toBe('lint');
    expect(GIT_STATUS_SCHEMA.name).toBe('git_status');
    expect(GIT_DIFF_SCHEMA.name).toBe('git_diff');
    expect(GIT_COMMIT_SCHEMA.name).toBe('git_commit');
    expect(GIT_LOG_SCHEMA.name).toBe('git_log');
    expect(FILE_ISSUE_SCHEMA.name).toBe('file_issue');
    expect(CLOSE_ISSUE_SCHEMA.name).toBe('close_issue');
    expect(UPDATE_GOAL_SCHEMA.name).toBe('update_goal');
    expect(DELEGATE_SCHEMA.name).toBe('delegate');
    expect(MESSAGE_USER_SCHEMA.name).toBe('message_user');
  });
});

describe('AgentToolkit — think', () => {
  it('returns success with reasoning logged', async () => {
    const result = await toolkit.execute(makeCall('think', {
      reasoning: 'I need to check the test coverage before making changes.',
    }));

    expect(result.success).toBe(true);
    expect(result.output).toContain('Reasoning recorded');
  });

  it('fails if reasoning is missing', async () => {
    const result = await toolkit.execute(makeCall('think', {}));
    expect(result.success).toBe(false);
    expect(result.error).toContain('reasoning');
  });
});

describe('AgentToolkit — read_file', () => {
  it('reads a file with line numbers', async () => {
    await writeFile(join(tempDir, 'src/test-file.ts'), 'line 1\nline 2\nline 3\n', 'utf8');

    const result = await toolkit.execute(makeCall('read_file', { path: 'src/test-file.ts' }));

    expect(result.success).toBe(true);
    expect(result.output).toContain('line 1');
    expect(result.output).toContain('line 2');
    expect(result.output).toContain('line 3');
    expect(result.output).toContain('lines total');
  });

  it('supports max_lines', async () => {
    await writeFile(join(tempDir, 'src/big.ts'), 'a\nb\nc\nd\ne\nf\n', 'utf8');

    const result = await toolkit.execute(makeCall('read_file', { path: 'src/big.ts', max_lines: 2 }));

    expect(result.success).toBe(true);
    expect(result.output).toContain('showing 1-2');
  });

  it('supports offset', async () => {
    await writeFile(join(tempDir, 'src/offset.ts'), 'a\nb\nc\nd\ne\n', 'utf8');

    const result = await toolkit.execute(makeCall('read_file', { path: 'src/offset.ts', offset: 3, max_lines: 2 }));

    expect(result.success).toBe(true);
    expect(result.output).toContain('showing 3-4');
  });

  it('fails on nonexistent file', async () => {
    const result = await toolkit.execute(makeCall('read_file', { path: 'src/nonexistent.ts' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to read');
  });

  it('fails if path is missing', async () => {
    const result = await toolkit.execute(makeCall('read_file', {}));
    expect(result.success).toBe(false);
    expect(result.error).toContain('path');
  });
});

describe('AgentToolkit — edit_file', () => {
  it('replaces text in a file', async () => {
    const filePath = join(tempDir, 'src/editable.ts');
    await writeFile(filePath, 'const x = 1;\nconst y = 2;\n', 'utf8');

    const result = await toolkit.execute(makeCall('edit_file', {
      path: 'src/editable.ts',
      old_string: 'const x = 1;',
      new_string: 'const x = 42;',
    }));

    expect(result.success).toBe(true);
    expect(result.output).toContain('Successfully edited');

    const content = await readFile(filePath, 'utf8');
    expect(content).toContain('const x = 42;');
    expect(content).toContain('const y = 2;');
  });

  it('fails if old_string not found', async () => {
    await writeFile(join(tempDir, 'src/nomatch.ts'), 'hello world\n', 'utf8');

    const result = await toolkit.execute(makeCall('edit_file', {
      path: 'src/nomatch.ts',
      old_string: 'not in file',
      new_string: 'replacement',
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('fails if old_string appears multiple times', async () => {
    await writeFile(join(tempDir, 'src/dupes.ts'), 'a\na\n', 'utf8');

    const result = await toolkit.execute(makeCall('edit_file', {
      path: 'src/dupes.ts',
      old_string: 'a',
      new_string: 'b',
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('2 times');
  });

  it('rejects forbidden paths', async () => {
    const result = await toolkit.execute(makeCall('edit_file', {
      path: '.env.local',
      old_string: 'KEY=val',
      new_string: 'KEY=new',
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed');
  });
});

describe('AgentToolkit — create_file', () => {
  it('creates a new file', async () => {
    const result = await toolkit.execute(makeCall('create_file', {
      path: 'src/new-file.ts',
      content: 'export const hello = "world";\n',
    }));

    expect(result.success).toBe(true);
    expect(result.output).toContain('Created');

    const content = await readFile(join(tempDir, 'src/new-file.ts'), 'utf8');
    expect(content).toContain('hello');
  });

  it('creates parent directories', async () => {
    const result = await toolkit.execute(makeCall('create_file', {
      path: 'src/deep/nested/file.ts',
      content: 'export {};\n',
    }));

    expect(result.success).toBe(true);
    const content = await readFile(join(tempDir, 'src/deep/nested/file.ts'), 'utf8');
    expect(content).toContain('export');
  });

  it('fails if file already exists', async () => {
    await writeFile(join(tempDir, 'src/existing.ts'), 'original\n', 'utf8');

    const result = await toolkit.execute(makeCall('create_file', {
      path: 'src/existing.ts',
      content: 'new content',
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists');
  });

  it('rejects forbidden paths', async () => {
    const result = await toolkit.execute(makeCall('create_file', {
      path: '.env.production',
      content: 'SECRET=123',
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed');
  });
});

describe('AgentToolkit — bash', () => {
  it('executes a simple command', async () => {
    const result = await toolkit.execute(makeCall('bash', { command: 'echo hello' }));
    expect(result.success).toBe(true);
    expect(result.output).toContain('hello');
  });

  it('returns exit code on failure', async () => {
    const result = await toolkit.execute(makeCall('bash', { command: 'exit 42' }));
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(42);
  });

  it('blocks destructive commands', async () => {
    const result = await toolkit.execute(makeCall('bash', { command: 'rm -rf /' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked');
  });

  it('blocks git force push', async () => {
    const result = await toolkit.execute(makeCall('bash', { command: 'git push origin main --force' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked');
  });

  it('blocks git reset --hard', async () => {
    const result = await toolkit.execute(makeCall('bash', { command: 'git reset --hard HEAD~1' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked');
  });
});

describe('AgentToolkit — grep', () => {
  it('finds pattern matches', async () => {
    await writeFile(join(tempDir, 'src/searchable.ts'), 'const foo = 1;\nconst bar = 2;\nconst foobar = 3;\n', 'utf8');

    const result = await toolkit.execute(makeCall('grep', {
      pattern: 'foo',
      path: 'src/',
    }));

    expect(result.success).toBe(true);
    expect(result.output).toContain('foo');
  });

  it('returns no matches gracefully', async () => {
    await writeFile(join(tempDir, 'src/empty-search.ts'), 'nothing here\n', 'utf8');

    const result = await toolkit.execute(makeCall('grep', {
      pattern: 'nonexistentpattern12345',
      path: 'src/',
    }));

    expect(result.success).toBe(true);
    expect(result.output).toContain('No matches');
  });
});

describe('AgentToolkit — file_issue', () => {
  it('creates a new issue', async () => {
    const result = await toolkit.execute(makeCall('file_issue', {
      title: 'Test failure in detector',
      description: 'Regex edge case fails on Unicode input',
      priority: 'high',
      related_files: ['src/security/detector.ts'],
      tags: ['test', 'regex'],
      next_idea: 'Try using Unicode-aware regex flag',
    }));

    expect(result.success).toBe(true);
    expect(result.output).toContain('ISS-001');
    expect(result.output).toContain('high');
  });

  it('updates existing issue with same title', async () => {
    await toolkit.execute(makeCall('file_issue', {
      title: 'Duplicate issue',
      description: 'First filing',
      priority: 'low',
    }));

    const result = await toolkit.execute(makeCall('file_issue', {
      title: 'Duplicate issue',
      description: 'Second filing with more info',
      priority: 'high',
    }));

    expect(result.success).toBe(true);
    // Should return the same issue ID (ISS-001), not ISS-002
    expect(result.output).toContain('ISS-001');
  });

  it('fails with invalid priority', async () => {
    const result = await toolkit.execute(makeCall('file_issue', {
      title: 'Bad priority',
      description: 'Test',
      priority: 'ultra',
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid priority');
  });
});

describe('AgentToolkit — close_issue', () => {
  it('closes an existing issue', async () => {
    // File an issue first
    await toolkit.execute(makeCall('file_issue', {
      title: 'Closable issue',
      description: 'Will be closed',
      priority: 'medium',
    }));

    const result = await toolkit.execute(makeCall('close_issue', {
      issue_id: 'ISS-001',
      resolution: 'Fixed by adjusting regex',
    }));

    expect(result.success).toBe(true);
    expect(result.output).toContain('resolved');
  });

  it('fails for nonexistent issue', async () => {
    const result = await toolkit.execute(makeCall('close_issue', {
      issue_id: 'ISS-999',
      resolution: 'Not real',
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

describe('AgentToolkit — update_goal', () => {
  it('updates goal status', async () => {
    state.goalStack.addGoal({
      source: 'user',
      description: 'Refactor tool system',
    });

    const result = await toolkit.execute(makeCall('update_goal', {
      goal_id: 'goal-001',
      status: 'in_progress',
      notes: 'Started reading the orchestrator',
    }));

    expect(result.success).toBe(true);
    expect(result.output).toContain('in_progress');
  });

  it('completes a goal', async () => {
    state.goalStack.addGoal({
      source: 'self',
      description: 'Fix type errors',
    });

    const result = await toolkit.execute(makeCall('update_goal', {
      goal_id: 'goal-001',
      status: 'done',
      notes: 'All type errors fixed',
    }));

    expect(result.success).toBe(true);
    expect(result.output).toContain('done');
  });

  it('fails for nonexistent goal', async () => {
    const result = await toolkit.execute(makeCall('update_goal', {
      goal_id: 'goal-999',
      status: 'done',
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('fails without status or notes', async () => {
    state.goalStack.addGoal({
      source: 'self',
      description: 'Some goal',
    });

    const result = await toolkit.execute(makeCall('update_goal', {
      goal_id: 'goal-001',
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('at least one');
  });
});

describe('AgentToolkit — delegate', () => {
  it('fails when delegation is disabled', async () => {
    const result = await toolkit.execute(makeCall('delegate', {
      model: 'hermes3:70b',
      task: 'Analyze this code',
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('disabled');
  });
});

describe('AgentToolkit — message_user', () => {
  it('fails when messaging is disabled', async () => {
    const result = await toolkit.execute(makeCall('message_user', {
      message: 'Tests are passing!',
      urgency: 'low',
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('not yet enabled');
  });
});

describe('AgentToolkit — unknown tool', () => {
  it('returns error for unknown tool names', async () => {
    const result = await toolkit.execute(makeCall('nonexistent_tool', {}));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown tool');
    expect(result.error).toContain('Available tools');
  });
});

describe('AgentToolkit — output truncation', () => {
  it('truncates large outputs', async () => {
    // Create a large file
    const largeContent = 'x'.repeat(20_000);
    await writeFile(join(tempDir, 'src/large.ts'), largeContent, 'utf8');

    const result = await toolkit.execute(makeCall('read_file', { path: 'src/large.ts' }));

    expect(result.success).toBe(true);
    // maxOutputChars is 5000 in our test config
    expect(result.output!.length).toBeLessThanOrEqual(5100); // some overhead for header
    expect(result.output).toContain('truncated');
  });
});
