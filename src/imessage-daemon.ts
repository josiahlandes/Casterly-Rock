#!/usr/bin/env node
import { safeLogger } from './logging/safe-logger.js';
import { startDaemon } from './imessage/index.js';

function parseArgs(argv: string[]): {
  pollInterval: number;
  workspacePath: string | undefined;
  sessionScope: 'main' | 'per-peer';
} {
  const args = argv.slice(2);
  let pollInterval = 2000;
  let workspacePath: string | undefined;
  let sessionScope: 'main' | 'per-peer' = 'per-peer';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--poll-interval' && args[i + 1]) {
      pollInterval = parseInt(args[i + 1] ?? '2000', 10);
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
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`
iMessage Daemon for Casterly

Usage: node imessage-daemon.js [options]

Options:
  --poll-interval <ms>      Polling interval in milliseconds (default: 2000)
  --workspace <path>        Workspace path (default: ~/.casterly)
  --session-scope <scope>   Session isolation: 'main' or 'per-peer' (default: per-peer)
  --help, -h                Show this help message

Allowed senders are managed via the address book (~/.casterly/contacts.json).
Use iMessage commands from the admin number: add contact, remove contact, list contacts.

Examples:
  node imessage-daemon.js
  node imessage-daemon.js --poll-interval 5000
\n`);
      process.exit(0);
    }
  }

  return { pollInterval, workspacePath, sessionScope };
}

async function main(): Promise<void> {
  const { pollInterval, workspacePath, sessionScope } = parseArgs(process.argv);

  safeLogger.info('Starting iMessage daemon', {
    pollInterval,
    sessionScope,
  });

  await startDaemon({
    pollIntervalMs: pollInterval,
    workspacePath,
    sessionScope,
  });
}

main().catch((error: unknown) => {
  safeLogger.error('iMessage daemon failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
