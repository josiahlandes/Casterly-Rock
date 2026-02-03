#!/usr/bin/env node
import { safeLogger } from './logging/safe-logger.js';
import { startDaemon } from './imessage/index.js';

function parseArgs(argv: string[]): {
  pollInterval: number;
  allowedSenders: string[];
  workspacePath: string | undefined;
  sessionScope: 'main' | 'per-peer';
  useMultiUser: boolean;
} {
  const args = argv.slice(2);
  let pollInterval = 2000; // Default 2 seconds
  const allowedSenders: string[] = [];
  let workspacePath: string | undefined;
  let sessionScope: 'main' | 'per-peer' = 'per-peer';
  let useMultiUser = true; // Default to multi-user mode

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--poll-interval' && args[i + 1]) {
      pollInterval = parseInt(args[i + 1] ?? '2000', 10);
      i++;
    } else if (arg === '--allow' && args[i + 1]) {
      allowedSenders.push(args[i + 1] ?? '');
      i++;
    } else if (arg === '--workspace' && args[i + 1]) {
      workspacePath = args[i + 1];
      i++;
    } else if (arg === '--session-scope' && args[i + 1]) {
      const scope = args[i + 1];
      if (scope === 'main' || scope === 'per-peer') {
        sessionScope = scope;
      }
      i++;
    } else if (arg === '--no-multi-user') {
      useMultiUser = false;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`
iMessage Daemon for Casterly

Usage: node imessage-daemon.js [options]

Options:
  --poll-interval <ms>      Polling interval in milliseconds (default: 2000)
  --allow <number/email>    Only respond to this sender (can be used multiple times)
                            Note: In multi-user mode, allowed senders come from users.json
  --workspace <path>        Default workspace path (overridden by per-user workspaces)
  --session-scope <scope>   Session isolation: 'main' or 'per-peer' (default: per-peer)
  --no-multi-user           Disable multi-user mode (use single workspace for all)
  --help, -h                Show this help message

Multi-User Mode (default):
  Users are configured in ~/.casterly/users.json
  Each user gets their own workspace with IDENTITY.md, SOUL.md, USER.md, TOOLS.md
  Only phone numbers listed in users.json will receive responses

Examples:
  # Start daemon in multi-user mode (reads from users.json)
  node imessage-daemon.js

  # Disable multi-user mode, respond to everyone
  node imessage-daemon.js --no-multi-user

  # Disable multi-user mode, only respond to specific numbers
  node imessage-daemon.js --no-multi-user --allow +15551234567

  # Custom poll interval
  node imessage-daemon.js --poll-interval 5000
\n`);
      process.exit(0);
    }
  }

  return { pollInterval, allowedSenders, workspacePath, sessionScope, useMultiUser };
}

async function main(): Promise<void> {
  const { pollInterval, allowedSenders, workspacePath, sessionScope, useMultiUser } = parseArgs(process.argv);

  safeLogger.info('Starting iMessage daemon', {
    pollInterval,
    allowedSendersCount: allowedSenders.length,
    sessionScope,
    multiUserMode: useMultiUser,
  });

  await startDaemon({
    pollIntervalMs: pollInterval,
    allowedSenders: allowedSenders.length > 0 ? allowedSenders : undefined,
    workspacePath,
    sessionScope,
    useMultiUser,
  });
}

main().catch((error: unknown) => {
  safeLogger.error('iMessage daemon failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
