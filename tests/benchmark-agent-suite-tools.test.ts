import { describe, expect, it } from 'vitest';

import {
  AGENT_TOOL_SCHEMAS,
  getAgentToolNames,
} from '../src/benchmark/agent-suite-tools.js';

describe('AGENT_TOOL_SCHEMAS', () => {
  it('contains at least 15 tools', () => {
    expect(AGENT_TOOL_SCHEMAS.length).toBeGreaterThanOrEqual(15);
  });

  it('every schema has correct structure', () => {
    for (const schema of AGENT_TOOL_SCHEMAS) {
      expect(schema.type).toBe('function');
      expect(schema.function.name).toBeTruthy();
      expect(schema.function.description).toBeTruthy();
      expect(schema.function.parameters).toBeDefined();
      expect(schema.function.parameters.type).toBe('object');
    }
  });

  it('every schema has a unique name', () => {
    const names = AGENT_TOOL_SCHEMAS.map((s) => s.function.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('includes core agent tools', () => {
    const names = getAgentToolNames();
    expect(names).toContain('think');
    expect(names).toContain('read_file');
    expect(names).toContain('edit_file');
    expect(names).toContain('grep');
    expect(names).toContain('glob');
    expect(names).toContain('bash');
    expect(names).toContain('delegate');
    expect(names).toContain('run_tests');
    expect(names).toContain('git_status');
  });

  it('includes quality tools', () => {
    const names = getAgentToolNames();
    expect(names).toContain('typecheck');
    expect(names).toContain('lint');
  });

  it('includes state tools', () => {
    const names = getAgentToolNames();
    expect(names).toContain('file_issue');
    expect(names).toContain('update_goal');
  });
});

describe('getAgentToolNames', () => {
  it('returns string array matching schema count', () => {
    const names = getAgentToolNames();
    expect(names).toHaveLength(AGENT_TOOL_SCHEMAS.length);
    for (const name of names) {
      expect(typeof name).toBe('string');
    }
  });
});
