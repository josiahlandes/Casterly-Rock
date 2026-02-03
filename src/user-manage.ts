#!/usr/bin/env node
/**
 * User Management CLI for Casterly
 * Manage users for multi-user iMessage mode
 */

import {
  addUser,
  removeUser,
  setUserEnabled,
  listUsers,
  loadUsersConfig,
  getUsersConfigPath,
  createDefaultBootstrapFiles,
  type UserProfile,
} from './interface/index.js';

function printHelp(): void {
  process.stdout.write(`
Casterly User Management

Usage: node user-manage.js <command> [options]

Commands:
  list                           List all configured users
  add <id> <name> <phone>        Add a new user
  remove <id>                    Remove a user (keeps workspace files)
  enable <id>                    Enable a user
  disable <id>                   Disable a user
  init-workspace <id>            Re-create default bootstrap files for a user

Options for 'add':
  --phone <number>               Additional phone number (can be used multiple times)
  --workspace <path>             Custom workspace path (default: ~/.casterly/users/<id>)

Examples:
  # List all users
  node user-manage.js list

  # Add a user with one phone number
  node user-manage.js add josiah "Josiah" "+15551234567"

  # Add a user with multiple phone numbers
  node user-manage.js add user2 "Second User" "+15559876543" --phone "+15551111111"

  # Remove a user
  node user-manage.js remove user2

  # Disable a user (stop responding to their messages)
  node user-manage.js disable josiah

  # Re-enable a user
  node user-manage.js enable josiah

Configuration:
  Users are stored in: ${getUsersConfigPath()}
  User workspaces: ~/.casterly/users/<id>/
\n`);
}

function printUsers(users: UserProfile[]): void {
  if (users.length === 0) {
    process.stdout.write('No users configured.\n');
    process.stdout.write('Add a user with: node user-manage.js add <id> <name> <phone>\n');
    return;
  }

  process.stdout.write('\nConfigured Users:\n');
  process.stdout.write('─'.repeat(60) + '\n');

  for (const user of users) {
    const status = user.enabled ? '✓ enabled' : '✗ disabled';
    process.stdout.write(`\n${user.id} (${user.name}) - ${status}\n`);
    process.stdout.write(`  Phone numbers: ${user.phoneNumbers.join(', ')}\n`);
    process.stdout.write(`  Workspace: ${user.workspacePath}\n`);
  }

  process.stdout.write('\n');
}

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  try {
    switch (command) {
      case 'list': {
        const users = listUsers();
        printUsers(users);
        break;
      }

      case 'add': {
        const id = args[1];
        const name = args[2];
        const primaryPhone = args[3];

        if (!id || !name || !primaryPhone) {
          process.stderr.write('Error: add command requires <id> <name> <phone>\n');
          process.stderr.write('Usage: node user-manage.js add <id> <name> <phone>\n');
          process.exitCode = 1;
          return;
        }

        // Collect additional phone numbers
        const phoneNumbers = [primaryPhone];
        let workspacePath: string | undefined;

        for (let i = 4; i < args.length; i++) {
          const nextArg = args[i + 1];
          if (args[i] === '--phone' && nextArg) {
            phoneNumbers.push(nextArg);
            i++;
          } else if (args[i] === '--workspace' && nextArg) {
            workspacePath = nextArg;
            i++;
          }
        }

        const user = addUser(id, name, phoneNumbers, workspacePath);
        process.stdout.write(`✓ Added user '${user.id}' (${user.name})\n`);
        process.stdout.write(`  Phone numbers: ${user.phoneNumbers.join(', ')}\n`);
        process.stdout.write(`  Workspace: ${user.workspacePath}\n`);
        process.stdout.write(`\nDefault bootstrap files created. Edit them at:\n`);
        process.stdout.write(`  ${user.workspacePath}/IDENTITY.md\n`);
        process.stdout.write(`  ${user.workspacePath}/SOUL.md\n`);
        process.stdout.write(`  ${user.workspacePath}/USER.md\n`);
        process.stdout.write(`  ${user.workspacePath}/TOOLS.md\n`);
        break;
      }

      case 'remove': {
        const id = args[1];
        if (!id) {
          process.stderr.write('Error: remove command requires <id>\n');
          process.exitCode = 1;
          return;
        }

        const removed = removeUser(id);
        if (removed) {
          process.stdout.write(`✓ Removed user '${id}'\n`);
          process.stdout.write(`  Note: Workspace files were not deleted\n`);
        } else {
          process.stderr.write(`Error: User '${id}' not found\n`);
          process.exitCode = 1;
        }
        break;
      }

      case 'enable': {
        const id = args[1];
        if (!id) {
          process.stderr.write('Error: enable command requires <id>\n');
          process.exitCode = 1;
          return;
        }

        const enabled = setUserEnabled(id, true);
        if (enabled) {
          process.stdout.write(`✓ Enabled user '${id}'\n`);
        } else {
          process.stderr.write(`Error: User '${id}' not found\n`);
          process.exitCode = 1;
        }
        break;
      }

      case 'disable': {
        const id = args[1];
        if (!id) {
          process.stderr.write('Error: disable command requires <id>\n');
          process.exitCode = 1;
          return;
        }

        const disabled = setUserEnabled(id, false);
        if (disabled) {
          process.stdout.write(`✓ Disabled user '${id}'\n`);
        } else {
          process.stderr.write(`Error: User '${id}' not found\n`);
          process.exitCode = 1;
        }
        break;
      }

      case 'init-workspace': {
        const id = args[1];
        if (!id) {
          process.stderr.write('Error: init-workspace command requires <id>\n');
          process.exitCode = 1;
          return;
        }

        const config = loadUsersConfig();
        const user = config.users.find(u => u.id === id);

        if (!user) {
          process.stderr.write(`Error: User '${id}' not found\n`);
          process.exitCode = 1;
          return;
        }

        createDefaultBootstrapFiles(user);
        process.stdout.write(`✓ Initialized workspace for user '${id}'\n`);
        process.stdout.write(`  Workspace: ${user.workspacePath}\n`);
        break;
      }

      default:
        process.stderr.write(`Unknown command: ${command}\n`);
        process.stderr.write('Use --help to see available commands\n');
        process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

main();
