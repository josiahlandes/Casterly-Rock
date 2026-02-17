/**
 * Reflector Module for Autonomous Self-Improvement
 *
 * Logs outcomes of improvement cycles and maintains learnings
 * for future reference.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Reflection, CycleMetrics } from './types.js';

// ============================================================================
// REFLECTOR
// ============================================================================

export class Reflector {
  private readonly reflectionsDir: string;
  private readonly metricsFile: string;
  private readonly memoryFile: string;

  constructor(options?: { reflectionsDir?: string; projectRoot?: string }) {
    const homeDir = process.env['HOME'] || '~';
    this.reflectionsDir =
      options?.reflectionsDir || path.join(homeDir, '.casterly', 'autonomous', 'reflections');
    this.metricsFile = path.join(
      options?.reflectionsDir || path.join(homeDir, '.casterly', 'autonomous'),
      'metrics.jsonl'
    );
    this.memoryFile = options?.projectRoot
      ? path.join(options.projectRoot, 'MEMORY.md')
      : 'MEMORY.md';
  }

  /**
   * Initialize storage directories.
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.reflectionsDir, { recursive: true });
    await fs.mkdir(path.dirname(this.metricsFile), { recursive: true });
  }

  // --------------------------------------------------------------------------
  // REFLECTION STORAGE
  // --------------------------------------------------------------------------

  /**
   * Save a reflection to storage.
   */
  async saveReflection(reflection: Reflection): Promise<void> {
    await this.initialize();

    // Generate filename based on timestamp and cycle ID
    const filename = `${reflection.timestamp.replace(/[:.]/g, '-')}-${reflection.cycleId}.json`;
    const filePath = path.join(this.reflectionsDir, filename);

    await fs.writeFile(filePath, JSON.stringify(reflection, null, 2), 'utf-8');
  }

  /**
   * Load recent reflections.
   */
  async loadRecentReflections(limit: number = 10): Promise<Reflection[]> {
    await this.initialize();

    const reflections: Reflection[] = [];

    try {
      const files = await fs.readdir(this.reflectionsDir);

      // Sort by name (timestamp-based) descending
      const sortedFiles = files
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, limit);

      for (const file of sortedFiles) {
        try {
          const content = await fs.readFile(path.join(this.reflectionsDir, file), 'utf-8');
          const reflection = JSON.parse(content) as Reflection;
          reflections.push(reflection);
        } catch {
          // Skip invalid files
        }
      }
    } catch {
      // Directory might not exist yet
    }

    return reflections;
  }

  /**
   * Get reflections by outcome.
   */
  async getReflectionsByOutcome(
    outcome: Reflection['outcome'],
    limit: number = 20
  ): Promise<Reflection[]> {
    const all = await this.loadRecentReflections(100);
    return all.filter((r) => r.outcome === outcome).slice(0, limit);
  }

  // --------------------------------------------------------------------------
  // METRICS TRACKING
  // --------------------------------------------------------------------------

  /**
   * Log cycle metrics.
   */
  async logMetrics(metrics: CycleMetrics): Promise<void> {
    await this.initialize();

    const line = JSON.stringify(metrics) + '\n';
    await fs.appendFile(this.metricsFile, line, 'utf-8');
  }

  /**
   * Get aggregate statistics.
   */
  async getStatistics(days: number = 7): Promise<AggregateStats> {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    const stats: AggregateStats = {
      totalCycles: 0,
      successfulCycles: 0,
      failedCycles: 0,
      totalTokensUsed: { input: 0, output: 0 },
      estimatedCostUsd: 0,
      successRate: 0,
      averageDurationMs: 0,
      topFailureReasons: [],
    };

    try {
      const content = await fs.readFile(this.metricsFile, 'utf-8');
      const lines = content.trim().split('\n');

      const recentMetrics: CycleMetrics[] = [];

      for (const line of lines) {
        try {
          const metrics = JSON.parse(line) as CycleMetrics;
          if (new Date(metrics.startTime).getTime() >= cutoff) {
            recentMetrics.push(metrics);
          }
        } catch {
          // Skip invalid lines
        }
      }

      stats.totalCycles = recentMetrics.length;
      stats.successfulCycles = recentMetrics.filter((m) => m.hypothesesSucceeded > 0).length;
      stats.failedCycles = stats.totalCycles - stats.successfulCycles;

      for (const m of recentMetrics) {
        stats.totalTokensUsed.input += m.tokensUsed.input;
        stats.totalTokensUsed.output += m.tokensUsed.output;
        stats.estimatedCostUsd += m.estimatedCostUsd || 0;
        if (m.durationMs) {
          stats.averageDurationMs += m.durationMs;
        }
      }

      if (stats.totalCycles > 0) {
        stats.successRate = stats.successfulCycles / stats.totalCycles;
        stats.averageDurationMs /= stats.totalCycles;
      }

      // Compute top failure reasons from recent reflections
      const reflections = await this.loadRecentReflections(100);
      const failedReflections = reflections.filter(
        (r) => r.outcome === 'failure' && r.learnings,
      );

      if (failedReflections.length > 0) {
        // Count failure reason patterns
        const reasonCounts = new Map<string, number>();
        for (const r of failedReflections) {
          const area = r.observation?.suggestedArea ?? 'unknown';
          reasonCounts.set(area, (reasonCounts.get(area) ?? 0) + 1);
        }

        stats.topFailureReasons = [...reasonCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([reason, count]) => `${reason} (${count})`);
      }
    } catch {
      // Metrics file might not exist
    }

    return stats;
  }

  // --------------------------------------------------------------------------
  // MEMORY.MD INTEGRATION
  // --------------------------------------------------------------------------

  /**
   * Append a significant learning to MEMORY.md.
   */
  async appendToMemory(entry: MemoryEntry): Promise<void> {
    const content = await this.readMemory();

    // Find or create autonomous learnings section
    const sectionHeader = '\n## Autonomous Learnings\n';
    let newContent: string;

    if (content.includes('## Autonomous Learnings')) {
      // Append to existing section
      const sectionIndex = content.indexOf('## Autonomous Learnings');
      const nextSectionIndex = content.indexOf('\n## ', sectionIndex + 1);

      const beforeSection = content.substring(0, sectionIndex);
      const afterSection = nextSectionIndex > 0 ? content.substring(nextSectionIndex) : '';
      const sectionContent = nextSectionIndex > 0
        ? content.substring(sectionIndex, nextSectionIndex)
        : content.substring(sectionIndex);

      newContent = beforeSection + sectionContent.trimEnd() + '\n\n' + this.formatMemoryEntry(entry) + '\n' + afterSection;
    } else {
      // Add new section at the end
      newContent = content.trimEnd() + '\n' + sectionHeader + '\n' + this.formatMemoryEntry(entry) + '\n';
    }

    await fs.writeFile(this.memoryFile, newContent, 'utf-8');
  }

  private async readMemory(): Promise<string> {
    try {
      return await fs.readFile(this.memoryFile, 'utf-8');
    } catch {
      return '# Memory\n\nThis file contains learnings and notes from autonomous improvement cycles.\n';
    }
  }

  private formatMemoryEntry(entry: MemoryEntry): string {
    const date = new Date().toISOString().split('T')[0];
    return `### ${date} - ${entry.title}

${entry.content}

*Cycle: ${entry.cycleId}*`;
  }

  // --------------------------------------------------------------------------
  // CLEANUP
  // --------------------------------------------------------------------------

  /**
   * Clean up old reflections.
   */
  async cleanupOldReflections(retainDays: number = 90): Promise<number> {
    const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
    let deleted = 0;

    try {
      const files = await fs.readdir(this.reflectionsDir);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const filePath = path.join(this.reflectionsDir, file);
        const stat = await fs.stat(filePath);

        if (stat.mtime.getTime() < cutoff) {
          await fs.unlink(filePath);
          deleted++;
        }
      }
    } catch {
      // Directory might not exist
    }

    return deleted;
  }
}

// ============================================================================
// TYPES
// ============================================================================

export interface AggregateStats {
  totalCycles: number;
  successfulCycles: number;
  failedCycles: number;
  totalTokensUsed: { input: number; output: number };
  estimatedCostUsd: number;
  successRate: number;
  averageDurationMs: number;
  topFailureReasons: string[];
}

export interface MemoryEntry {
  cycleId: string;
  title: string;
  content: string;
}
