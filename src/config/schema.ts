import { z } from 'zod';

const sensitiveCategorySchema = z.enum([
  'calendar',
  'finances',
  'voice_memos',
  'health',
  'credentials',
  'documents',
  'contacts',
  'location'
]);

const localConfigSchema = z.object({
  provider: z.literal('ollama'),
  model: z.string().min(1),
  codingModel: z.string().min(1).optional(),
  baseUrl: z.string().url(),
  timeoutMs: z.number().int().positive().optional()
});

const sensitivityConfigSchema = z.object({
  alwaysLocal: z.array(sensitiveCategorySchema).min(1)
});

export const appConfigSchema = z.object({
  local: localConfigSchema,
  sensitivity: sensitivityConfigSchema
});

export type SensitiveCategory = z.infer<typeof sensitiveCategorySchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;
