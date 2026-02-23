/**
 * Tool Synthesizer — LLM-authored tools (Vision Tier 2)
 *
 * When the LLM notices it repeatedly performs the same multi-step
 * operation, it can synthesize a new tool that wraps the workflow.
 * The tool definition is stored on disk and loaded at session start.
 *
 * Safety model:
 *   - Synthesized tools run inside the same sandbox as all other tools
 *   - They cannot bypass path guards, redaction, or command blockers
 *   - The create_tool meta-tool validates the implementation before
 *     registration via a security pattern check
 *   - Failed tools are logged with the error
 *
 * Storage: ~/.casterly/tools/ as JSON definition files.
 *
 * Part of Vision Tier 2: Tool Synthesis.
 */

import { readFile, writeFile, readdir, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { getTracer } from '../autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A synthesized tool definition.
 */
export interface SynthesizedTool {
  /** Unique tool name (must not conflict with built-in tools) */
  name: string;

  /** Human-readable description */
  description: string;

  /** JSON Schema for parameters */
  inputSchema: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
    }>;
    required: string[];
  };

  /** The implementation body — a sequence of bash commands or tool calls */
  implementation: ToolImplementation;

  /** When this tool was created */
  createdAt: string;

  /** Notes from the creator (the LLM) */
  authorNotes: string;

  /** Number of times this tool has been invoked */
  usageCount: number;

  /** Last time this tool was used */
  lastUsed: string;

  /** Status */
  status: 'active' | 'archived';

  /** Version number */
  version: number;
}

/**
 * Tool implementation — a template of steps to execute.
 *
 * Implementation is a series of steps, each being either a bash command
 * template or a description of tool calls. Parameters are substituted
 * using {{param_name}} syntax.
 */
export interface ToolImplementation {
  /** The type of implementation */
  type: 'bash_template';

  /** The bash command template with {{param}} placeholders */
  template: string;

  /** Working directory (relative to project root, or 'project_root') */
  cwd: 'project_root';
}

/**
 * Result of a tool creation attempt.
 */
export interface CreateToolResult {
  success: boolean;
  name?: string;
  error?: string;
  securityViolations?: string[];
}

/**
 * Configuration for the tool synthesizer.
 */
export interface ToolSynthesizerConfig {
  /** Directory to store synthesized tool definitions */
  toolsDirectory: string;

  /** Maximum number of synthesized tools */
  maxTools: number;

  /** Maximum template body length in characters */
  maxTemplateLength: number;

  /** Days before unused tools are flagged */
  unusedDaysThreshold: number;

  /** Built-in tool names that cannot be overridden */
  reservedNames: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ToolSynthesizerConfig = {
  toolsDirectory: '~/.casterly/tools',
  maxTools: 20,
  maxTemplateLength: 2000,
  unusedDaysThreshold: 30,
  reservedNames: [
    'think', 'read_file', 'edit_file', 'create_file', 'grep', 'glob',
    'bash', 'run_tests', 'typecheck', 'lint', 'git_status', 'git_diff',
    'git_commit', 'git_log', 'file_issue', 'close_issue', 'update_goal',
    'delegate', 'message_user', 'recall', 'archive', 'recall_journal',
    'consolidate', 'crystallize', 'dissolve', 'list_crystals',
    'create_rule', 'update_rule', 'list_rules', 'replay',
    'compare_traces', 'search_traces', 'adversarial_test',
    'update_world_model', 'save_note',
    // Tier 2 tools
    'edit_prompt', 'revert_prompt', 'get_prompt', 'shadow',
    'list_shadows', 'create_tool', 'manage_tools', 'list_custom_tools',
  ],
};

/**
 * Patterns that are never allowed in tool implementations.
 */
const DANGEROUS_PATTERNS = [
  /rm\s+-rf?\s+[/~]/,          // rm -rf /
  /process\.exit/,              // process.exit
  /eval\s*\(/,                  // eval()
  /Function\s*\(/,              // Function constructor
  /require\s*\(\s*['"]child_process['"]\)/, // require('child_process')
  /\.env\b/,                    // .env access
  /credentials/i,               // credentials
  /secret/i,                    // secrets
  /curl.*-X\s*(POST|PUT|DELETE)/i, // Mutating HTTP requests
  /wget/,                       // wget
  /ssh\s/,                      // ssh commands
  /scp\s/,                      // scp commands
  />\s*\/etc\//,                // Writing to /etc
  />\s*\/usr\//,                // Writing to /usr
  /chmod\s+[0-7]*7/,           // Making files world-writable
];

function resolvePath(filePath: string): string {
  if (filePath.startsWith('~')) {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
    return filePath.replace('~', home);
  }
  return filePath;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Synthesizer
// ─────────────────────────────────────────────────────────────────────────────

export class ToolSynthesizer {
  private readonly config: ToolSynthesizerConfig;
  private tools: Map<string, SynthesizedTool> = new Map();
  private loaded: boolean = false;

  constructor(config?: Partial<ToolSynthesizerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  /**
   * Load all synthesized tools from the tools directory.
   */
  async load(): Promise<void> {
    const tracer = getTracer();
    const resolvedDir = resolvePath(this.config.toolsDirectory);

    try {
      await mkdir(resolvedDir, { recursive: true });
      const files = await readdir(resolvedDir);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        try {
          const content = await readFile(join(resolvedDir, file), 'utf8');
          const tool = JSON.parse(content) as SynthesizedTool;

          if (tool.name && tool.status === 'active') {
            this.tools.set(tool.name, tool);
          }
        } catch (err) {
          tracer.log('agent-loop', 'warn', `Failed to load synthesized tool: ${file}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        tracer.log('agent-loop', 'warn', 'Failed to load synthesized tools directory', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.loaded = true;
    tracer.log('agent-loop', 'debug', `Tool synthesizer loaded: ${this.tools.size} active tools`);
  }

  /**
   * Save a single tool definition to disk.
   */
  private async saveTool(tool: SynthesizedTool): Promise<void> {
    const resolvedDir = resolvePath(this.config.toolsDirectory);
    await mkdir(resolvedDir, { recursive: true });
    const filePath = join(resolvedDir, `${tool.name}.json`);
    await writeFile(filePath, JSON.stringify(tool, null, 2), 'utf8');
  }

  // ── Tool Creation ────────────────────────────────────────────────────────

  /**
   * Create a new synthesized tool. Validates the name, schema, and
   * implementation for security before accepting.
   */
  createTool(params: {
    name: string;
    description: string;
    inputSchema: SynthesizedTool['inputSchema'];
    template: string;
    authorNotes: string;
  }): CreateToolResult {
    const tracer = getTracer();

    // Validate name
    const nameError = this.validateName(params.name);
    if (nameError) {
      return { success: false, error: nameError };
    }

    // Validate template length
    if (params.template.length > this.config.maxTemplateLength) {
      return {
        success: false,
        error: `Template too long: ${params.template.length} chars (max: ${this.config.maxTemplateLength}).`,
      };
    }

    // Security scan
    const violations = this.scanForDangerousPatterns(params.template);
    if (violations.length > 0) {
      tracer.log('agent-loop', 'warn', `Tool creation rejected: ${params.name}`, {
        violations,
      });
      return {
        success: false,
        error: 'Security scan failed.',
        securityViolations: violations,
      };
    }

    // Check capacity
    const activeTools = Array.from(this.tools.values())
      .filter((t) => t.status === 'active');
    if (activeTools.length >= this.config.maxTools) {
      return {
        success: false,
        error: `Tool limit reached (${this.config.maxTools}). Archive unused tools first.`,
      };
    }

    // Create the tool
    const tool: SynthesizedTool = {
      name: params.name,
      description: params.description,
      inputSchema: params.inputSchema,
      implementation: {
        type: 'bash_template',
        template: params.template,
        cwd: 'project_root',
      },
      createdAt: new Date().toISOString(),
      authorNotes: params.authorNotes,
      usageCount: 0,
      lastUsed: '',
      status: 'active',
      version: 1,
    };

    this.tools.set(tool.name, tool);

    tracer.log('agent-loop', 'info', `Synthesized tool created: ${tool.name}`, {
      description: tool.description.slice(0, 80),
    });

    return { success: true, name: tool.name };
  }

  /**
   * Record a usage of a synthesized tool.
   */
  recordUsage(toolName: string): boolean {
    const tool = this.tools.get(toolName);
    if (!tool) return false;

    tool.usageCount++;
    tool.lastUsed = new Date().toISOString();
    return true;
  }

  /**
   * Archive a tool (deactivate but preserve).
   */
  archiveTool(toolName: string): boolean {
    const tool = this.tools.get(toolName);
    if (!tool) return false;

    tool.status = 'archived';
    return true;
  }

  /**
   * Reactivate an archived tool.
   */
  reactivateTool(toolName: string): boolean {
    const tool = this.tools.get(toolName);
    if (!tool || tool.status !== 'archived') return false;

    tool.status = 'active';
    return true;
  }

  /**
   * Delete a tool permanently.
   */
  async deleteTool(toolName: string): Promise<boolean> {
    const tool = this.tools.get(toolName);
    if (!tool) return false;

    this.tools.delete(toolName);

    // Remove from disk
    const resolvedDir = resolvePath(this.config.toolsDirectory);
    try {
      await unlink(join(resolvedDir, `${toolName}.json`));
    } catch {
      // File may not exist on disk
    }

    return true;
  }

  /**
   * Save all tools to disk.
   */
  async save(): Promise<void> {
    for (const tool of this.tools.values()) {
      await this.saveTool(tool);
    }
    getTracer().log('agent-loop', 'debug', `Tool synthesizer saved: ${this.tools.size} tools`);
  }

  // ── Template Execution ───────────────────────────────────────────────────

  /**
   * Render a tool's bash template with parameter substitution.
   * Re-scans the rendered output for dangerous patterns to prevent
   * bypass via crafted parameter values.
   */
  renderTemplate(
    toolName: string,
    params: Record<string, string>,
  ): string | null {
    const tool = this.tools.get(toolName);
    if (!tool || tool.status !== 'active') return null;

    let rendered = tool.implementation.template;

    for (const [key, value] of Object.entries(params)) {
      // Escape single quotes in values for shell safety
      const safeValue = value.replace(/'/g, "'\\''");
      rendered = rendered.replace(
        new RegExp(`\\{\\{${key}\\}\\}`, 'g'),
        safeValue,
      );
    }

    // Re-scan after substitution to catch dangerous patterns injected via params
    const violations = this.scanForDangerousPatterns(rendered);
    if (violations.length > 0) {
      getTracer().log('agent-loop', 'warn', `Rendered template rejected: ${toolName}`, {
        violations,
      });
      return null;
    }

    return rendered;
  }

  // ── Query ────────────────────────────────────────────────────────────────

  /**
   * Get a tool by name.
   */
  getTool(name: string): SynthesizedTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all active tools.
   */
  getActiveTools(): SynthesizedTool[] {
    return Array.from(this.tools.values()).filter((t) => t.status === 'active');
  }

  /**
   * Get all tools (including archived).
   */
  getAllTools(): SynthesizedTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tools that haven't been used within the threshold.
   */
  getUnusedTools(): SynthesizedTool[] {
    const cutoff = Date.now() - this.config.unusedDaysThreshold * 24 * 60 * 60 * 1000;

    return Array.from(this.tools.values()).filter((t) => {
      if (t.status !== 'active') return false;
      if (!t.lastUsed) return true; // Never used
      return new Date(t.lastUsed).getTime() < cutoff;
    });
  }

  /**
   * Count of active tools.
   */
  activeCount(): number {
    return Array.from(this.tools.values()).filter((t) => t.status === 'active').length;
  }

  /**
   * Count of all tools.
   */
  totalCount(): number {
    return this.tools.size;
  }

  /**
   * Check if loaded.
   */
  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Build a list summary for the LLM.
   */
  buildToolList(): string {
    const active = this.getActiveTools();
    if (active.length === 0) return 'No custom tools.';

    const lines: string[] = [];
    for (const t of active) {
      const lastUsed = t.lastUsed
        ? new Date(t.lastUsed).toISOString().split('T')[0]
        : 'never';
      lines.push(
        `- **${t.name}**: ${t.description} (used ${t.usageCount}x, last: ${lastUsed})`,
      );
    }

    const archived = Array.from(this.tools.values())
      .filter((t) => t.status === 'archived');
    if (archived.length > 0) {
      lines.push(`\n${archived.length} archived tools.`);
    }

    return lines.join('\n');
  }

  // ── Validation ───────────────────────────────────────────────────────────

  /**
   * Validate a tool name.
   */
  private validateName(name: string): string | null {
    if (!name || name.length === 0) {
      return 'Tool name is required.';
    }

    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      return 'Tool name must be lowercase alphanumeric with underscores, starting with a letter.';
    }

    if (name.length > 40) {
      return 'Tool name must be 40 characters or fewer.';
    }

    if (this.config.reservedNames.includes(name)) {
      return `Tool name "${name}" is reserved (conflicts with a built-in tool).`;
    }

    if (this.tools.has(name) && this.tools.get(name)!.status === 'active') {
      return `Tool "${name}" already exists. Archive or delete it first.`;
    }

    return null;
  }

  /**
   * Scan a template for dangerous patterns.
   */
  private scanForDangerousPatterns(template: string): string[] {
    const violations: string[] = [];

    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(template)) {
        violations.push(`Matches dangerous pattern: ${pattern.source}`);
      }
    }

    return violations;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createToolSynthesizer(
  config?: Partial<ToolSynthesizerConfig>,
): ToolSynthesizer {
  return new ToolSynthesizer(config);
}
