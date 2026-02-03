import { z } from 'zod';

export const sensitiveCategorySchema = z.enum([
  'calendar',
  'finances',
  'voice_memos',
  'health',
  'credentials',
  'documents',
  'contacts'
]);

const localConfigSchema = z.object({
  provider: z.literal('ollama'),
  model: z.string().min(1),
  baseUrl: z.string().url(),
  timeoutMs: z.number().int().positive().optional()
});

const cloudConfigSchema = z.object({
  provider: z.literal('claude'),
  model: z.string().min(1),
  apiKeyEnv: z.string().min(1),
  baseUrl: z.string().url().optional(),
  timeoutMs: z.number().int().positive().optional()
});

const routerConfigSchema = z.object({
  defaultRoute: z.enum(['local', 'cloud']).default('local'),
  confidenceThreshold: z.number().min(0).max(1).default(0.7)
});

const sensitivityConfigSchema = z.object({
  alwaysLocal: z.array(sensitiveCategorySchema).min(1)
});

export const appConfigSchema = z.object({
  local: localConfigSchema,
  cloud: cloudConfigSchema,
  router: routerConfigSchema,
  sensitivity: sensitivityConfigSchema
});

export type SensitiveCategory = z.infer<typeof sensitiveCategorySchema>;
export type AppConfigFile = z.infer<typeof appConfigSchema>;

export interface ResolvedCloudConfig
  extends Omit<z.infer<typeof cloudConfigSchema>, 'apiKeyEnv'> {
  apiKey?: string;
  apiKeyEnv: string;
}

export interface AppConfig extends Omit<AppConfigFile, 'cloud'> {
  cloud: ResolvedCloudConfig;
}
