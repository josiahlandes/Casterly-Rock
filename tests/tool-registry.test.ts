import { describe, expect, it } from 'vitest';

import {
  createToolRegistry,
  type AnthropicTool,
  type OllamaTool,
} from '../src/tools/schemas/registry.js';
import { CORE_TOOLS } from '../src/tools/schemas/core.js';
import type { ToolSchema } from '../src/tools/schemas/types.js';

// ─── Test helper ─────────────────────────────────────────────────────────────

function makeTool(name: string, description = `Tool: ${name}`): ToolSchema {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Input value' },
      },
      required: ['input'],
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// createToolRegistry — initialization
// ═══════════════════════════════════════════════════════════════════════════════

describe('createToolRegistry — initialization', () => {
  it('includes core tools by default', () => {
    const reg = createToolRegistry();
    const tools = reg.getTools();
    expect(tools.length).toBe(CORE_TOOLS.length);
  });

  it('includes all core tool names', () => {
    const reg = createToolRegistry();
    const names = reg.getTools().map((t) => t.name);
    for (const core of CORE_TOOLS) {
      expect(names).toContain(core.name);
    }
  });

  it('creates empty registry when includeCoreTools is false', () => {
    const reg = createToolRegistry(false);
    expect(reg.getTools()).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createToolRegistry — register
// ═══════════════════════════════════════════════════════════════════════════════

describe('createToolRegistry — register', () => {
  it('adds a new tool', () => {
    const reg = createToolRegistry(false);
    reg.register(makeTool('custom_tool'));

    expect(reg.getTools().length).toBe(1);
    expect(reg.getTool('custom_tool')).toBeDefined();
  });

  it('overwrites a tool with the same name', () => {
    const reg = createToolRegistry(false);
    reg.register(makeTool('my_tool', 'Version 1'));
    reg.register(makeTool('my_tool', 'Version 2'));

    expect(reg.getTools().length).toBe(1);
    expect(reg.getTool('my_tool')!.description).toBe('Version 2');
  });

  it('can register multiple tools', () => {
    const reg = createToolRegistry(false);
    reg.register(makeTool('tool_a'));
    reg.register(makeTool('tool_b'));
    reg.register(makeTool('tool_c'));

    expect(reg.getTools().length).toBe(3);
  });

  it('can override a core tool', () => {
    const reg = createToolRegistry(true);
    const coreName = CORE_TOOLS[0]!.name;
    reg.register(makeTool(coreName, 'Custom override'));

    const tool = reg.getTool(coreName);
    expect(tool!.description).toBe('Custom override');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createToolRegistry — getTool
// ═══════════════════════════════════════════════════════════════════════════════

describe('createToolRegistry — getTool', () => {
  it('returns undefined for non-existent tool', () => {
    const reg = createToolRegistry(false);
    expect(reg.getTool('nonexistent')).toBeUndefined();
  });

  it('returns matching tool by name', () => {
    const reg = createToolRegistry(false);
    const tool = makeTool('lookup_test', 'Searchable tool');
    reg.register(tool);

    const found = reg.getTool('lookup_test');
    expect(found).toBeDefined();
    expect(found!.name).toBe('lookup_test');
    expect(found!.description).toBe('Searchable tool');
  });

  it('finds core tools when included', () => {
    const reg = createToolRegistry(true);
    const bash = reg.getTool('bash');
    expect(bash).toBeDefined();
    expect(bash!.name).toBe('bash');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createToolRegistry — formatForAnthropic
// ═══════════════════════════════════════════════════════════════════════════════

describe('createToolRegistry — formatForAnthropic', () => {
  it('returns empty array for empty registry', () => {
    const reg = createToolRegistry(false);
    expect(reg.formatForAnthropic()).toEqual([]);
  });

  it('formats tool with name, description, input_schema', () => {
    const reg = createToolRegistry(false);
    reg.register(makeTool('anthropic_tool', 'Anthropic format test'));

    const formatted = reg.formatForAnthropic();
    expect(formatted.length).toBe(1);

    const t: AnthropicTool = formatted[0]!;
    expect(t.name).toBe('anthropic_tool');
    expect(t.description).toBe('Anthropic format test');
    expect(t.input_schema).toBeDefined();
    expect(t.input_schema.type).toBe('object');
    expect(t.input_schema.properties.input).toBeDefined();
  });

  it('maps inputSchema to input_schema (snake_case)', () => {
    const reg = createToolRegistry(false);
    const tool = makeTool('schema_test');
    reg.register(tool);

    const formatted = reg.formatForAnthropic()[0]!;
    expect(formatted.input_schema).toEqual(tool.inputSchema);
  });

  it('formats all registered tools', () => {
    const reg = createToolRegistry(false);
    reg.register(makeTool('a'));
    reg.register(makeTool('b'));
    reg.register(makeTool('c'));

    expect(reg.formatForAnthropic().length).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createToolRegistry — formatForOllama
// ═══════════════════════════════════════════════════════════════════════════════

describe('createToolRegistry — formatForOllama', () => {
  it('returns empty array for empty registry', () => {
    const reg = createToolRegistry(false);
    expect(reg.formatForOllama()).toEqual([]);
  });

  it('formats tool in OpenAI-compatible function calling format', () => {
    const reg = createToolRegistry(false);
    reg.register(makeTool('ollama_tool', 'Ollama format test'));

    const formatted = reg.formatForOllama();
    expect(formatted.length).toBe(1);

    const t: OllamaTool = formatted[0]!;
    expect(t.type).toBe('function');
    expect(t.function.name).toBe('ollama_tool');
    expect(t.function.description).toBe('Ollama format test');
    expect(t.function.parameters).toBeDefined();
    expect(t.function.parameters.type).toBe('object');
  });

  it('maps inputSchema to function.parameters', () => {
    const reg = createToolRegistry(false);
    const tool = makeTool('params_test');
    reg.register(tool);

    const formatted = reg.formatForOllama()[0]!;
    expect(formatted.function.parameters).toEqual(tool.inputSchema);
  });

  it('formats all registered tools', () => {
    const reg = createToolRegistry(false);
    reg.register(makeTool('x'));
    reg.register(makeTool('y'));

    expect(reg.formatForOllama().length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createToolRegistry — getTools isolation
// ═══════════════════════════════════════════════════════════════════════════════

describe('createToolRegistry — isolation', () => {
  it('separate registries are independent', () => {
    const reg1 = createToolRegistry(false);
    const reg2 = createToolRegistry(false);

    reg1.register(makeTool('only_in_reg1'));

    expect(reg1.getTool('only_in_reg1')).toBeDefined();
    expect(reg2.getTool('only_in_reg1')).toBeUndefined();
  });
});
