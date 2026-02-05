/**
 * Configuration Loader
 *
 * Mac Studio Edition - Local Ollama Only
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

import { appConfigSchema } from './schema.js';
import type { AppConfig } from './schema.js';

export function loadConfig(configPath = 'config/default.yaml'): AppConfig {
  const absolutePath = resolve(configPath);
  const raw = readFileSync(absolutePath, 'utf8');
  const parsed = YAML.parse(raw);
  return appConfigSchema.parse(parsed);
}
