import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

import { safeLogger } from '../logging/safe-logger.js';
import { appConfigSchema } from './schema.js';
import type { AppConfig } from './schema.js';

export function loadConfig(configPath = 'config/default.yaml'): AppConfig {
  const absolutePath = resolve(configPath);
  const raw = readFileSync(absolutePath, 'utf8');
  const parsed = YAML.parse(raw);
  const configFile = appConfigSchema.parse(parsed);

  const apiKey = process.env[configFile.cloud.apiKeyEnv];

  if (!apiKey) {
    safeLogger.warn(
      `Cloud API key env var ${configFile.cloud.apiKeyEnv} is not set. Cloud routing will likely fail.`
    );
  }

  const resolvedCloud = apiKey
    ? {
        ...configFile.cloud,
        apiKey
      }
    : {
        ...configFile.cloud
      };

  return {
    ...configFile,
    cloud: resolvedCloud
  };
}
