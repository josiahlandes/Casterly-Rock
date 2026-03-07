/**
 * Harness Store — persistence for learned harness definitions.
 *
 * Stores harness definitions as individual JSON files under
 * ~/.casterly/harnesses/. Follows the same persistence pattern as
 * the ToolSynthesizer (src/tools/synthesizer.ts).
 *
 * Storage layout:
 *   ~/.casterly/harnesses/
 *     {id}.json           — serialized HarnessDefinition
 *     failures/{id}.json  — accumulated HarnessFailure[] per harness
 */

import { readFile, writeFile, readdir, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { safeLogger } from '../logging/safe-logger.js';
import type { HarnessDefinition, HarnessFailure } from './types.js';

// ─── Configuration ───────────────────────────────────────────────────────────

export interface HarnessStoreConfig {
  /** Root directory for harness storage */
  directory: string;

  /** Maximum number of active harnesses */
  maxHarnesses: number;

  /** Maximum failures to retain per harness before triggering refinement */
  maxFailuresPerHarness: number;
}

const DEFAULT_CONFIG: HarnessStoreConfig = {
  directory: '~/.casterly/harnesses',
  maxHarnesses: 50,
  maxFailuresPerHarness: 20,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolvePath(filePath: string): string {
  if (filePath.startsWith('~')) {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
    return filePath.replace('~', home);
  }
  return filePath;
}

// ─── Store ───────────────────────────────────────────────────────────────────

export class HarnessStore {
  private readonly config: HarnessStoreConfig;
  private harnesses: Map<string, HarnessDefinition> = new Map();
  private failures: Map<string, HarnessFailure[]> = new Map();
  private loaded = false;

  constructor(config?: Partial<HarnessStoreConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Load all harness definitions and failure logs from disk. */
  async load(): Promise<void> {
    const dir = resolvePath(this.config.directory);
    const failDir = join(dir, 'failures');

    try {
      await mkdir(dir, { recursive: true });
      await mkdir(failDir, { recursive: true });

      const files = await readdir(dir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const content = await readFile(join(dir, file), 'utf8');
          const def = JSON.parse(content) as HarnessDefinition;
          if (def.id) this.harnesses.set(def.id, def);
        } catch (err) {
          safeLogger.warn('Failed to load harness', {
            file,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Load failure logs
      try {
        const failFiles = await readdir(failDir);
        for (const file of failFiles) {
          if (!file.endsWith('.json')) continue;
          try {
            const content = await readFile(join(failDir, file), 'utf8');
            const id = file.replace('.json', '');
            this.failures.set(id, JSON.parse(content) as HarnessFailure[]);
          } catch {
            // Skip malformed failure logs
          }
        }
      } catch {
        // failures directory may not exist yet
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        safeLogger.warn('Failed to load harness store', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.loaded = true;
    safeLogger.info('Harness store loaded', {
      count: this.harnesses.size,
      failureLogs: this.failures.size,
    });
  }

  /** Save a single harness definition to disk. */
  async save(def: HarnessDefinition): Promise<void> {
    const dir = resolvePath(this.config.directory);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${def.id}.json`), JSON.stringify(def, null, 2), 'utf8');
    this.harnesses.set(def.id, def);
  }

  /** Remove a harness from disk and memory. */
  async remove(id: string): Promise<boolean> {
    const dir = resolvePath(this.config.directory);
    this.harnesses.delete(id);
    this.failures.delete(id);

    try {
      await unlink(join(dir, `${id}.json`));
    } catch {
      // File may not exist
    }
    try {
      await unlink(join(dir, 'failures', `${id}.json`));
    } catch {
      // File may not exist
    }

    return true;
  }

  /** Get a harness by ID. */
  get(id: string): HarnessDefinition | undefined {
    return this.harnesses.get(id);
  }

  /** Get all harnesses for a specific tool. */
  getForTool(toolName: string): HarnessDefinition[] {
    return Array.from(this.harnesses.values()).filter(
      (h) => h.enabled && (h.toolName === toolName || h.toolName === '*'),
    );
  }

  /** Get all active harnesses. */
  getActive(): HarnessDefinition[] {
    return Array.from(this.harnesses.values()).filter((h) => h.enabled);
  }

  /** Get all harnesses (including disabled). */
  getAll(): HarnessDefinition[] {
    return Array.from(this.harnesses.values());
  }

  /** Record a failure for a harness. Returns true if refinement threshold is reached. */
  async recordFailure(failure: HarnessFailure): Promise<boolean> {
    const existing = this.failures.get(failure.harnessId) ?? [];
    existing.push(failure);

    // Cap stored failures
    if (existing.length > this.config.maxFailuresPerHarness) {
      existing.splice(0, existing.length - this.config.maxFailuresPerHarness);
    }

    this.failures.set(failure.harnessId, existing);

    // Persist failure log
    const failDir = join(resolvePath(this.config.directory), 'failures');
    await mkdir(failDir, { recursive: true });
    await writeFile(
      join(failDir, `${failure.harnessId}.json`),
      JSON.stringify(existing, null, 2),
      'utf8',
    );

    return existing.length >= this.config.maxFailuresPerHarness;
  }

  /** Get failures for a harness. */
  getFailures(harnessId: string): HarnessFailure[] {
    return this.failures.get(harnessId) ?? [];
  }

  /** Clear failures for a harness (after successful refinement). */
  async clearFailures(harnessId: string): Promise<void> {
    this.failures.delete(harnessId);
    const failDir = join(resolvePath(this.config.directory), 'failures');
    try {
      await unlink(join(failDir, `${harnessId}.json`));
    } catch {
      // File may not exist
    }
  }

  /** Whether the store has been loaded. */
  isLoaded(): boolean {
    return this.loaded;
  }

  /** Count of active harnesses. */
  activeCount(): number {
    return this.getActive().length;
  }

  /** Whether we can add more harnesses. */
  canAdd(): boolean {
    return this.activeCount() < this.config.maxHarnesses;
  }
}

export function createHarnessStore(config?: Partial<HarnessStoreConfig>): HarnessStore {
  return new HarnessStore(config);
}
