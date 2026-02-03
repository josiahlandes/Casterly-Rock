#!/usr/bin/env node
import { safeLogger } from './logging/safe-logger.js';
import { runCli } from './interfaces/cli.js';

runCli().catch((error: unknown) => {
  safeLogger.error('CLI failed.', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
