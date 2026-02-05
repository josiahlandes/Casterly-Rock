/**
 * CLI Interface
 *
 * Mac Studio Edition - Local Ollama Only
 */

import { loadConfig } from '../config/index.js';
import { safeLogger } from '../logging/safe-logger.js';
import { buildProviders } from '../providers/index.js';
import { createToolRegistry } from '../tools/index.js';

function parseArgs(argv: string[]): { input: string; execute: boolean } {
  const args = argv.slice(2);
  const execute = args.includes('--execute');
  const filtered = args.filter((arg) => arg !== '--execute');
  const input = filtered.join(' ').trim();

  return { input, execute };
}

export async function runCli(): Promise<void> {
  const { input, execute } = parseArgs(process.argv);

  if (!input) {
    safeLogger.info('Usage: npm run dev -- "your request here" [--execute]');
    return;
  }

  const config = loadConfig();
  const providers = buildProviders(config);

  safeLogger.info('Using local provider (Ollama)', {
    model: config.local.model,
  });

  if (!execute) {
    safeLogger.info('Pass --execute to run the provider.');
    return;
  }

  const provider = providers.local;
  const toolRegistry = createToolRegistry();
  const response = await provider.generateWithTools({ prompt: input }, toolRegistry.getTools());

  safeLogger.info('Provider response received.', {
    provider: response.providerId,
    model: response.model,
  });
  console.log(response.text);
}
