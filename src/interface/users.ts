/**
 * Multi-User Management
 * Maps phone numbers to user profiles with isolated workspaces
 *
 * Each user gets:
 * - Isolated workspace with their own IDENTITY.md, SOUL.md, USER.md, TOOLS.md
 * - Isolated memory (MEMORY.md and daily logs)
 * - Isolated session history
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface UserProfile {
  /** Unique user identifier (e.g., 'josiah', 'user2') */
  id: string;
  /** Display name for logging */
  name: string;
  /** Phone number(s) for this user - normalized format */
  phoneNumbers: string[];
  /** Path to this user's workspace */
  workspacePath: string;
  /** Whether this user is enabled */
  enabled: boolean;
}

export interface UsersConfig {
  /** List of configured users */
  users: UserProfile[];
}

/**
 * Normalize a phone number for comparison
 * Removes spaces, dashes, parentheses, dots
 * Converts to lowercase for email addresses
 */
export function normalizePhoneNumber(phone: string): string {
  return phone.replace(/[\s\-\(\)\.]/g, '').toLowerCase();
}

/**
 * Get the default users config path
 */
export function getUsersConfigPath(): string {
  return join(homedir(), '.casterly', 'users.json');
}

/**
 * Get the default base path for user workspaces
 */
export function getUserWorkspaceBasePath(): string {
  return join(homedir(), '.casterly', 'users');
}

/**
 * Load users configuration
 */
export function loadUsersConfig(): UsersConfig {
  const configPath = getUsersConfigPath();

  if (!existsSync(configPath)) {
    return { users: [] };
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content) as UsersConfig;
  } catch {
    return { users: [] };
  }
}

/**
 * Save users configuration
 */
export function saveUsersConfig(config: UsersConfig): void {
  const configPath = getUsersConfigPath();
  const dir = join(homedir(), '.casterly');

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Find a user by phone number
 */
export function findUserByPhone(phone: string, config?: UsersConfig): UserProfile | undefined {
  const usersConfig = config ?? loadUsersConfig();
  const normalizedPhone = normalizePhoneNumber(phone);

  for (const user of usersConfig.users) {
    if (!user.enabled) continue;

    for (const userPhone of user.phoneNumbers) {
      const normalizedUserPhone = normalizePhoneNumber(userPhone);
      // Check for match (handles partial matches like country code variations)
      if (normalizedPhone.includes(normalizedUserPhone) ||
          normalizedUserPhone.includes(normalizedPhone)) {
        return user;
      }
    }
  }

  return undefined;
}

/**
 * Get list of all allowed phone numbers (for daemon allowlist)
 */
export function getAllowedPhoneNumbers(config?: UsersConfig): string[] {
  const usersConfig = config ?? loadUsersConfig();
  const phones: string[] = [];

  for (const user of usersConfig.users) {
    if (user.enabled) {
      phones.push(...user.phoneNumbers);
    }
  }

  return phones;
}

/**
 * Create user workspace directory structure
 */
export function ensureUserWorkspace(user: UserProfile): void {
  const workspacePath = user.workspacePath;

  // Create workspace directory
  if (!existsSync(workspacePath)) {
    mkdirSync(workspacePath, { recursive: true });
  }

  // Create memory subdirectory
  const memoryDir = join(workspacePath, 'memory');
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }

  // Create skills directory (symlink to shared skills)
  const skillsDir = join(workspacePath, 'skills');
  if (!existsSync(skillsDir)) {
    // For now, just create the directory - skills can be shared or per-user
    mkdirSync(skillsDir, { recursive: true });
  }
}

/**
 * Create default bootstrap files for a new user
 */
export function createDefaultBootstrapFiles(user: UserProfile): void {
  ensureUserWorkspace(user);

  // IDENTITY.md
  const identityPath = join(user.workspacePath, 'IDENTITY.md');
  if (!existsSync(identityPath)) {
    writeFileSync(identityPath, `# Identity

You are Casterly, a helpful AI assistant communicating via iMessage with ${user.name}.

## Core Identity
- Name: Casterly
- Primary user: ${user.name}
- Communication channel: iMessage

## Interaction Style
- Concise and helpful
- Friendly but professional
- Respect user privacy
`);
  }

  // SOUL.md
  const soulPath = join(user.workspacePath, 'SOUL.md');
  if (!existsSync(soulPath)) {
    writeFileSync(soulPath, `# Soul

## Personality
- Helpful and attentive
- Direct and efficient in responses
- Remembers context from previous conversations

## Boundaries
- Never share information between different users
- Keep conversations private and confidential
- Respect user preferences and time

## Guidelines
- Keep iMessage responses concise (mobile-friendly)
- Use tools when needed to help the user
- Ask clarifying questions when instructions are ambiguous
`);
  }

  // USER.md
  const userPath = join(user.workspacePath, 'USER.md');
  if (!existsSync(userPath)) {
    writeFileSync(userPath, `# User Profile

## About ${user.name}

<!-- Add user-specific information here -->
- Name: ${user.name}
- User ID: ${user.id}

## Preferences

<!-- Add preferences as you learn them -->

## Important Notes

<!-- Add important context about this user -->
`);
  }

  // TOOLS.md
  const toolsPath = join(user.workspacePath, 'TOOLS.md');
  if (!existsSync(toolsPath)) {
    writeFileSync(toolsPath, `# Tools Guide

## Available Capabilities

You have access to various skills and tools. Use them to help ${user.name} with:

- System control (opening apps, volume, etc.)
- Weather information
- Calendar and reminders
- iMessage communication
- And more...

## Usage Guidelines

- Always confirm before taking irreversible actions
- Explain what you're doing when using tools
- Report errors clearly
`);
  }

  // MEMORY.md
  const memoryPath = join(user.workspacePath, 'MEMORY.md');
  if (!existsSync(memoryPath)) {
    writeFileSync(memoryPath, `# Long-Term Memory for ${user.name}

<!--
This file stores persistent facts and preferences about ${user.name}.
Use [MEMORY] tags in responses to add information here.
-->

## User Facts

## Preferences

## Important Context
`);
  }
}

/**
 * Add a new user
 */
export function addUser(
  id: string,
  name: string,
  phoneNumbers: string[],
  workspacePath?: string
): UserProfile {
  const config = loadUsersConfig();

  // Check for duplicate ID
  if (config.users.some(u => u.id === id)) {
    throw new Error(`User with ID '${id}' already exists`);
  }

  // Check for duplicate phone numbers
  for (const phone of phoneNumbers) {
    const existing = findUserByPhone(phone, config);
    if (existing) {
      throw new Error(`Phone number '${phone}' is already assigned to user '${existing.id}'`);
    }
  }

  const user: UserProfile = {
    id,
    name,
    phoneNumbers,
    workspacePath: workspacePath ?? join(getUserWorkspaceBasePath(), id),
    enabled: true,
  };

  config.users.push(user);
  saveUsersConfig(config);

  // Create workspace and bootstrap files
  createDefaultBootstrapFiles(user);

  return user;
}

/**
 * Remove a user (keeps workspace files)
 */
export function removeUser(id: string): boolean {
  const config = loadUsersConfig();
  const index = config.users.findIndex(u => u.id === id);

  if (index === -1) {
    return false;
  }

  config.users.splice(index, 1);
  saveUsersConfig(config);

  return true;
}

/**
 * Enable or disable a user
 */
export function setUserEnabled(id: string, enabled: boolean): boolean {
  const config = loadUsersConfig();
  const user = config.users.find(u => u.id === id);

  if (!user) {
    return false;
  }

  user.enabled = enabled;
  saveUsersConfig(config);

  return true;
}

/**
 * List all users
 */
export function listUsers(): UserProfile[] {
  return loadUsersConfig().users;
}
