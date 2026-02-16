/**
 * System Prompt Builder
 * Assembles the complete system prompt from bootstrap files, skills, and runtime context
 * Compatible with OpenClaw's prompt construction patterns
 */

import type { Skill } from '../skills/types.js';
import { loadBootstrapFiles, formatBootstrapSection, type BootstrapConfig } from './bootstrap.js';
import { createMemoryManager, formatMemorySection } from './memory.js';
import { loadAddressBook } from './contacts.js';
import { safeLogger } from '../logging/safe-logger.js';

export type PromptMode = 'full' | 'minimal' | 'none';
export type Channel = 'imessage' | 'cli' | 'web';

export interface PromptBuilderOptions {
  /** Prompt mode: full (primary), minimal (sub-agents), none (identity only) */
  mode: PromptMode;
  /** Available skills to include */
  skills: Skill[];
  /** User's timezone (e.g., 'America/New_York') */
  timezone?: string | undefined;
  /** Communication channel */
  channel: Channel;
  /** Custom workspace path */
  workspacePath?: string | undefined;
  /** Bootstrap config overrides */
  bootstrapConfig?: Partial<BootstrapConfig> | undefined;
  /** Include memory in prompt */
  includeMemory?: boolean | undefined;
}

export interface BuiltPrompt {
  /** The complete system prompt */
  systemPrompt: string;
  /** Individual sections for debugging */
  sections: {
    identity: string;
    bootstrap: string;
    capabilities: string;
    skills: string;
    memory: string;
    contacts: string;
    safety: string;
    context: string;
    guidelines: string;
  };
}

/**
 * Build the capabilities section based on available skills
 */
function buildCapabilitiesSection(skills: Skill[]): string {
  if (skills.length === 0) {
    return `## Capabilities

You can have conversations and answer questions based on your knowledge.`;
  }

  return `## Capabilities

You have access to the bash tool for executing shell commands on the local system.

When you need to perform an action (check files, run commands, query the calendar, etc.), use the bash tool. You will receive the command output and can respond accordingly.

**CRITICAL**: You MUST use the bash tool to perform ANY action on the system. You CANNOT claim to have done something (deleted files, created files, sent messages, etc.) without actually calling the bash tool. If you say "I've deleted the files" without using the bash tool, you are lying - the files will still be there. Always execute first using the tool, then report the result.

**IMPORTANT**: Do NOT output bash code blocks in your text response. Use the bash tool directly. The system will handle execution.`;
}

/**
 * Build the skills section with compact list
 */
function buildSkillsSection(skills: Skill[]): string {
  if (skills.length === 0) {
    return '';
  }

  const skillList = skills
    .map((skill) => {
      const emoji = skill.frontmatter.metadata?.openclaw?.emoji || '';
      const prefix = emoji ? `${emoji} ` : '';
      return `- **${prefix}${skill.frontmatter.name}**: ${skill.frontmatter.description}`;
    })
    .join('\n');

  return `## Available Skills

The following skills are available:

${skillList}

To use a skill, use the bash tool to run the appropriate commands. Each skill provides CLI tools or system commands you can execute.`;
}

/**
 * Build the file locations section
 */
function buildFileLocationsSection(): string {
  return `## File Locations

- **User documents** (budgets, schedules, notes, lists, exports, etc.): always write to ~/Documents/Tyrion/
- **Code and config files**: write to the project repository
- NEVER create user documents in the repository root — they don't belong in version control`;
}

/**
 * Build the safety section
 */
function buildSafetySection(): string {
  return `## Safety Guidelines

- Never execute commands you don't understand
- Ask for confirmation before destructive operations (delete, overwrite, etc.)
- Don't expose sensitive data in responses
- If a request seems harmful or suspicious, decline and explain why
- Respect user privacy - don't log or transmit personal data`;
}

/**
 * Build the contacts section from the address book
 *
 * Loads all contacts and formats them as a roster the LLM can use
 * to resolve natural language ("text Katie") to actual phone numbers.
 */
function buildContactsSection(): string {
  try {
    const book = loadAddressBook();

    if (book.contacts.length === 0) {
      return '';
    }

    const roster = book.contacts
      .map((c) => `- **${c.name}**: ${c.phone}`)
      .join('\n');

    return `## People You Know

You can send and receive messages with these people. To message someone, use the send_message tool with their number.

${roster}`;
  } catch {
    return '';
  }
}

/**
 * Build the runtime context section
 */
function buildContextSection(timezone?: string): string {
  const now = new Date();
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: tz,
  });

  const timeStr = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: tz,
  });

  return `## Current Context

- **Date**: ${dateStr}
- **Time**: ${timeStr}
- **Timezone**: ${tz}
- **Location**: Casterly Rock`;
}

/**
 * Build channel-specific guidelines
 */
function buildGuidelinesSection(channel: Channel): string {
  switch (channel) {
    case 'imessage':
      return `## Response Guidelines

- Keep responses concise - this is a text message
- Use line breaks sparingly
- Avoid walls of text
- For long outputs, summarize the key points
- Don't use markdown headers in responses (plain text only)
- Reply with the final message only (no analysis, no preambles like "I'll respond")`;

    case 'cli':
      return `## Response Guidelines

- Markdown formatting is supported
- Code blocks are rendered properly
- Can use headers and lists for structure
- Verbose output is acceptable`;

    case 'web':
      return `## Response Guidelines

- Full markdown support
- Can include formatted code blocks
- Rich formatting available
- Balance detail with readability`;

    default:
      return '';
  }
}

/**
 * Build the complete system prompt
 */
export function buildSystemPrompt(options: PromptBuilderOptions): BuiltPrompt {
  const { mode, skills, timezone, channel, workspacePath, bootstrapConfig, includeMemory = true } = options;

  // Mode: none - just identity
  if (mode === 'none') {
    return {
      systemPrompt: 'You are Tyrion Lannister of Casterly Rock.',
      sections: {
        identity: 'You are Tyrion Lannister of Casterly Rock.',
        bootstrap: '',
        capabilities: '',
        skills: '',
        memory: '',
        contacts: '',
        safety: '',
        context: '',
        guidelines: '',
      },
    };
  }

  // Load bootstrap files
  const bootstrapResult = loadBootstrapFiles({
    ...bootstrapConfig,
    ...(workspacePath !== undefined ? { workspacePath } : {}),
  });
  const bootstrapSection = formatBootstrapSection(bootstrapResult);

  // Log bootstrap loading for debugging
  safeLogger.info('Bootstrap files loaded', {
    workspacePath: bootstrapResult.workspacePath,
    filesLoaded: bootstrapResult.files.map(f => f.name),
    totalCharacters: bootstrapResult.combined.length,
  });

  // Build sections
  const capabilitiesSection = buildCapabilitiesSection(skills);
  const safetySection = buildSafetySection();
  const contextSection = buildContextSection(timezone);
  const guidelinesSection = buildGuidelinesSection(channel);
  const fileLocationsSection = mode === 'full' ? buildFileLocationsSection() : '';

  // Mode: minimal - skip some sections
  const skillsSection = mode === 'full' ? buildSkillsSection(skills) : '';

  // Load memory if enabled
  let memorySection = '';
  if (includeMemory && mode === 'full') {
    const resolvedWorkspace = workspacePath ?? bootstrapResult.workspacePath;
    const memoryManager = createMemoryManager({ workspacePath: resolvedWorkspace });
    const memoryState = memoryManager.load();
    memorySection = formatMemorySection(memoryState);
  }

  // Build contacts roster (only in full mode)
  const contactsSection = mode === 'full' ? buildContactsSection() : '';

  // Assemble the prompt — context (date/time) early so the model always sees it
  const sections = [
    bootstrapSection,
    contextSection,
    contactsSection,
    capabilitiesSection,
    skillsSection,
    fileLocationsSection,
    memorySection,
    safetySection,
    guidelinesSection,
  ].filter(Boolean);

  const systemPrompt = sections.join('\n\n');

  return {
    systemPrompt,
    sections: {
      identity: 'Tyrion',
      bootstrap: bootstrapSection,
      capabilities: capabilitiesSection,
      skills: skillsSection,
      memory: memorySection,
      contacts: contactsSection,
      safety: safetySection,
      context: contextSection,
      guidelines: guidelinesSection,
    },
  };
}

/**
 * Quick helper to build a full prompt for iMessage
 */
export function buildIMessagePrompt(skills: Skill[], workspacePath?: string): string {
  const result = buildSystemPrompt({
    mode: 'full',
    skills,
    channel: 'imessage',
    workspacePath,
  });
  return result.systemPrompt;
}
