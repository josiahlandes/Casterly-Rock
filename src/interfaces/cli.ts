import { loadConfig } from '../config/index.js';
import { safeLogger } from '../logging/safe-logger.js';
import { buildProviders } from '../providers/index.js';
import { routeRequest } from '../router/index.js';

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
  const decision = await routeRequest(input, { config, providers });

  safeLogger.info(`Route: ${decision.route}`, {
    reason: decision.reason,
    confidence: decision.confidence,
    sensitiveCategories: decision.sensitiveCategories
  });

  if (!execute) {
    safeLogger.info('Route-only mode. Pass --execute to run the selected provider.');
    return;
  }

  const provider = decision.route === 'cloud' ? providers.cloud : providers.local;

  if (!provider) {
    safeLogger.warn('No provider available for the selected route.');
    return;
  }

  const response = await provider.generate({ prompt: input });
  safeLogger.info('Provider response received.', {
    provider: response.providerId,
    model: response.model
  });
  console.log(response.text);
}
