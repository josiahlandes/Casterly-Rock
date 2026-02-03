/**
 * OpenClaw-compatible skill types
 * These mirror the OpenClaw SKILL.md frontmatter schema for compatibility
 */

export interface SkillInstallOption {
  id: string;
  kind: 'brew' | 'apt' | 'npm' | 'pip' | 'manual';
  formula?: string;      // For brew
  package?: string;      // For apt/npm/pip
  bins?: string[];       // Binaries this install provides
  label?: string;        // Human-readable install description
}

export interface SkillRequirements {
  bins?: string[];       // Required binaries on PATH
  envVars?: string[];    // Required environment variables
  os?: ('darwin' | 'linux' | 'win32')[];  // Supported operating systems
}

export interface SkillMetadata {
  openclaw?: {
    emoji?: string;
    os?: ('darwin' | 'linux' | 'win32')[];
    requires?: SkillRequirements;
    install?: SkillInstallOption[];
    skillKey?: string;   // Override key for config matching
  };
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  homepage?: string;
  metadata?: SkillMetadata;
}

export interface Skill {
  /** Unique skill identifier (directory name) */
  id: string;

  /** Parsed frontmatter from SKILL.md */
  frontmatter: SkillFrontmatter;

  /** Raw markdown content (instructions for the LLM) */
  instructions: string;

  /** Full path to the skill directory */
  path: string;

  /** Whether the skill's requirements are met on this system */
  available: boolean;

  /** Reason if not available */
  unavailableReason?: string | undefined;
}

export interface SkillRegistry {
  /** All loaded skills */
  skills: Map<string, Skill>;

  /** Get skill by ID */
  get(id: string): Skill | undefined;

  /** Get all available skills */
  getAvailable(): Skill[];

  /** Generate system prompt section listing all available skills (names only) */
  getPromptSection(): string;

  /** Find skills relevant to a user message and return their full instructions */
  getRelevantSkillInstructions(message: string): string;

  /** Reload skills from disk */
  reload(): Promise<void>;
}
