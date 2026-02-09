import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { safeLogger } from '../logging/safe-logger.js';
import type { Skill, SkillFrontmatter, SkillRegistry } from './types.js';
import type { ToolSchema } from '../tools/schemas/types.js';

const NOTES_SKILL_IDS = new Set(['apple-notes', 'bear-notes']);
const PREFERRED_NOTES_SKILL_ID = 'apple-notes';

const SKILL_DIRS = [
  join(homedir(), '.casterly', 'skills'),           // User workspace skills (highest priority)
  join(homedir(), 'Casterly', 'skills'),            // Project skills
  join(process.cwd(), 'skills'),                     // Current directory skills
];

/**
 * Parse YAML-ish frontmatter from SKILL.md
 * Supports both YAML and JSON frontmatter formats (OpenClaw uses both)
 */
function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } | null {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);

  if (!frontmatterMatch) {
    return null;
  }

  const [, frontmatterRaw, body] = frontmatterMatch;

  if (!frontmatterRaw || body === undefined) {
    return null;
  }

  try {
    // Try parsing as simple YAML (key: value format)
    const frontmatter: Record<string, unknown> = {};
    const lines = frontmatterRaw.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Handle JSON-style metadata block
      if (trimmed.startsWith('metadata:')) {
        // Look for JSON object on same line or following lines
        const jsonMatch = frontmatterRaw.match(/metadata:\s*(\{[\s\S]*?\})\s*(?:\n[a-z]|$)/);
        if (jsonMatch?.[1]) {
          try {
            frontmatter['metadata'] = JSON.parse(jsonMatch[1].replace(/,\s*}/g, '}').replace(/,\s*]/g, ']'));
          } catch {
            // JSON parse failed, skip metadata
          }
        }
        continue;
      }

      // Handle JSON-style tools block
      if (trimmed.startsWith('tools:')) {
        // Look for JSON array on same line or following lines
        const toolsMatch = frontmatterRaw.match(/tools:\s*(\[[\s\S]*?\])\s*(?:\n[a-z]|$)/);
        if (toolsMatch?.[1]) {
          try {
            frontmatter['tools'] = JSON.parse(toolsMatch[1].replace(/,\s*]/g, ']'));
          } catch {
            // JSON parse failed, skip tools
          }
        }
        continue;
      }

      // Simple key: value parsing
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 0) {
        const key = trimmed.slice(0, colonIdx).trim();
        let value: string | undefined = trimmed.slice(colonIdx + 1).trim();

        // Remove quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }

        if (key && value) {
          frontmatter[key] = value;
        }
      }
    }

    if (!frontmatter['name'] || !frontmatter['description']) {
      return null;
    }

    return {
      frontmatter: frontmatter as unknown as SkillFrontmatter,
      body: body.trim(),
    };
  } catch (error) {
    safeLogger.warn('Failed to parse SKILL.md frontmatter', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Check if a binary exists on PATH
 */
function binaryExists(bin: string): boolean {
  try {
    execSync(`which "${bin}"`, { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a skill's requirements are met
 */
function checkRequirements(skill: SkillFrontmatter): { available: boolean; reason?: string } {
  const meta = skill.metadata?.openclaw;

  if (!meta) {
    return { available: true };
  }

  // Check OS requirement
  if (meta.os && meta.os.length > 0) {
    const currentOS = platform();
    if (!meta.os.includes(currentOS as 'darwin' | 'linux' | 'win32')) {
      return { available: false, reason: `Requires OS: ${meta.os.join(', ')} (current: ${currentOS})` };
    }
  }

  // Check required binaries
  const requires = meta.requires;
  if (requires?.bins) {
    for (const bin of requires.bins) {
      if (!binaryExists(bin)) {
        return { available: false, reason: `Missing required binary: ${bin}` };
      }
    }
  }

  // Check required environment variables
  if (requires?.envVars) {
    for (const envVar of requires.envVars) {
      if (!process.env[envVar]) {
        return { available: false, reason: `Missing required env var: ${envVar}` };
      }
    }
  }

  return { available: true };
}

/**
 * Load a single skill from a directory
 */
function loadSkill(skillDir: string, skillId: string): Skill | null {
  const skillMdPath = join(skillDir, 'SKILL.md');

  if (!existsSync(skillMdPath)) {
    return null;
  }

  try {
    const content = readFileSync(skillMdPath, 'utf-8');
    const parsed = parseFrontmatter(content);

    if (!parsed) {
      safeLogger.warn('Invalid SKILL.md format', { skillId });
      return null;
    }

    const { available, reason } = checkRequirements(parsed.frontmatter);

    return {
      id: skillId,
      frontmatter: parsed.frontmatter,
      instructions: parsed.body,
      path: skillDir,
      available,
      unavailableReason: reason,
      tools: parsed.frontmatter.tools ?? [],
    };
  } catch (error) {
    safeLogger.warn('Failed to load skill', {
      skillId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Load all skills from configured directories
 */
export function loadSkills(): Map<string, Skill> {
  const skills = new Map<string, Skill>();

  for (const dir of SKILL_DIRS) {
    if (!existsSync(dir)) {
      continue;
    }

    try {
      const entries = readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillId = entry.name;

        // Skip if already loaded (higher priority dir wins)
        if (skills.has(skillId)) {
          continue;
        }

        const skill = loadSkill(join(dir, skillId), skillId);
        if (skill) {
          skills.set(skillId, skill);
          safeLogger.info('Loaded skill', {
            id: skillId,
            available: skill.available,
            reason: skill.unavailableReason,
          });
        }
      }
    } catch (error) {
      safeLogger.warn('Failed to read skill directory', {
        dir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return skills;
}

export function filterSkillsForNotes(skills: Skill[]): Skill[] {
  const hasPreferred = skills.some((skill) => skill.id === PREFERRED_NOTES_SKILL_ID);

  if (!hasPreferred) {
    return skills;
  }

  return skills.filter((skill) => {
    if (!NOTES_SKILL_IDS.has(skill.id)) {
      return true;
    }
    return skill.id === PREFERRED_NOTES_SKILL_ID;
  });
}

/**
 * Create a skill registry
 */
export function createSkillRegistry(): SkillRegistry {
  let skills = loadSkills();

  return {
    skills,

    get(id: string): Skill | undefined {
      return skills.get(id);
    },

    getAvailable(): Skill[] {
      const available = Array.from(skills.values()).filter((s) => s.available);
      return filterSkillsForNotes(available);
    },

    getPromptSection(): string {
      const available = this.getAvailable();

      if (available.length === 0) {
        return '';
      }

      // Only include skill names and descriptions - NOT the full instructions
      // The full instructions contain example bash blocks that the LLM incorrectly executes
      const skillList = available.map((skill) => {
        const emoji = skill.frontmatter.metadata?.openclaw?.emoji ?? '🔧';
        return `- ${emoji} **${skill.frontmatter.name}**: ${skill.frontmatter.description}`;
      });

      return `## Available Skills

You have these skills available. Only use them when the user explicitly asks for related functionality.

${skillList.join('\n')}

IMPORTANT: Do NOT run commands unless the user asks for something specific. Ask clarifying questions if unsure.`;
    },

    getTools(): ToolSchema[] {
      const available = this.getAvailable();
      const tools: ToolSchema[] = [];

      for (const skill of available) {
        if (skill.tools.length > 0) {
          tools.push(...skill.tools);
        }
      }

      return tools;
    },

    getRelevantSkillInstructions(message: string): string {
      const available = this.getAvailable();
      if (available.length === 0) {
        return '';
      }

      const lowerMessage = message.toLowerCase();
      const relevantSkills: Skill[] = [];

      // Keyword mappings for common intents to skill IDs
      const intentMappings: Record<string, string[]> = {
        // Notes & Lists
        'note': ['apple-notes'],
        'notes': ['apple-notes'],
        'grocery': ['apple-notes', 'apple-reminders'],
        'shopping list': ['apple-notes', 'apple-reminders'],
        'list': ['apple-notes', 'apple-reminders'],
        'reminder': ['apple-reminders'],
        'remind': ['apple-reminders'],
        'todo': ['apple-reminders'],
        // Calendar
        'calendar': ['apple-calendar'],
        'event': ['apple-calendar'],
        'meeting': ['apple-calendar'],
        'schedule': ['apple-calendar'],
        'appointment': ['apple-calendar'],
        // Weather
        'weather': ['weather'],
        'forecast': ['weather'],
        'temperature': ['weather'],
        'rain': ['weather'],
        // Communication
        'text': ['imessage-send', 'imsg'],
        'message': ['imessage-send', 'imsg'],
        'send': ['imessage-send', 'imsg'],
        'email': ['himalaya'],
        'mail': ['himalaya'],
        // Media
        'spotify': ['spotify-player'],
        'music': ['spotify-player'],
        'play': ['spotify-player'],
        'song': ['spotify-player'],
        // Camera
        'photo': ['camsnap'],
        'picture': ['camsnap'],
        'camera': ['camsnap'],
        'snap': ['camsnap'],
        // System
        'volume': ['system-control'],
        'brightness': ['system-control'],
        'screenshot': ['system-control'],
        // Code
        'code': ['coding-agent'],
        'github': ['github'],
        'repo': ['github'],
        'pull request': ['github'],
        'pr': ['github'],
      };

      // Check for matching intents
      for (const [keyword, skillIds] of Object.entries(intentMappings)) {
        if (lowerMessage.includes(keyword)) {
          for (const skillId of skillIds) {
            const skill = skills.get(skillId);
            if (skill && skill.available && !relevantSkills.includes(skill)) {
              relevantSkills.push(skill);
            }
          }
        }
      }

      // Also match by skill name or description
      for (const skill of available) {
        if (relevantSkills.includes(skill)) continue;

        const nameMatch = lowerMessage.includes(skill.frontmatter.name.toLowerCase());
        const descWords = skill.frontmatter.description.toLowerCase().split(/\s+/);
        const descMatch = descWords.some(word => word.length > 4 && lowerMessage.includes(word));

        if (nameMatch || descMatch) {
          relevantSkills.push(skill);
        }
      }

      if (relevantSkills.length === 0) {
        return '';
      }

      // Build instructions section for relevant skills only
      const sections = relevantSkills.map((skill) => {
        const emoji = skill.frontmatter.metadata?.openclaw?.emoji ?? '🔧';
        return `### ${emoji} ${skill.frontmatter.name}

${skill.instructions}`;
      });

      return `## Skill Instructions

The following skill documentation shows you how to use the relevant tools.

CRITICAL: The documentation below contains EXAMPLE commands for reference. Do NOT execute every example!
- Read the documentation to understand the command syntax
- Choose ONLY the ONE command that matches what the user asked for
- Execute that single command, not the examples

${sections.join('\n\n---\n\n')}`;
    },

    async reload(): Promise<void> {
      skills = loadSkills();
    },
  };
}
