/**
 * File Tracker
 *
 * Tracks which files are currently in context, their token usage,
 * and manages file loading/unloading based on priority and budget.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { tokenCounter } from '../token-counter.js';
import type { TrackedFile, FilePriority, FileContent } from './types.js';

/**
 * File tracker for managing context files.
 */
export class FileTracker {
  /** Root path of the repository */
  private readonly rootPath: string;

  /** Currently tracked files */
  private files: Map<string, TrackedFile> = new Map();

  /** Cached file contents */
  private contentCache: Map<string, FileContent> = new Map();

  /** Maximum token budget for files */
  private maxTokens: number;

  constructor(rootPath: string, maxTokens: number) {
    this.rootPath = path.isAbsolute(rootPath) ? rootPath : path.resolve(rootPath);
    this.maxTokens = maxTokens;
  }

  /**
   * Add a file to the context.
   */
  async addFile(
    relativePath: string,
    priority: FilePriority = 'medium'
  ): Promise<{ success: boolean; tokens?: number; error?: string }> {
    const normalized = this.normalizePath(relativePath);
    const absolutePath = path.join(this.rootPath, normalized);

    // Check if already tracked
    if (this.files.has(normalized)) {
      const tracked = this.files.get(normalized);
      if (tracked) {
        tracked.lastAccessedAt = new Date().toISOString();
        tracked.accessCount++;
        // Update priority if higher
        if (this.priorityValue(priority) > this.priorityValue(tracked.priority)) {
          tracked.priority = priority;
        }
        return { success: true, tokens: tracked.tokens };
      }
    }

    // Read and count tokens
    try {
      const content = await fs.readFile(absolutePath, 'utf-8');
      const tokens = tokenCounter.count(content);

      // Check if we have room
      const currentUsage = this.getTotalTokens();
      if (currentUsage + tokens > this.maxTokens) {
        // Try to evict lower priority files
        const evicted = this.evictForSpace(tokens, priority);
        if (!evicted) {
          return {
            success: false,
            error: `Not enough token budget. Need ${tokens}, have ${this.maxTokens - currentUsage} available.`,
          };
        }
      }

      const now = new Date().toISOString();

      // Track the file
      this.files.set(normalized, {
        path: normalized,
        priority,
        tokens,
        addedAt: now,
        lastAccessedAt: now,
        accessCount: 1,
      });

      // Cache the content
      this.contentCache.set(normalized, {
        path: normalized,
        content,
        tokens,
        loadedAt: now,
        modified: false,
      });

      return { success: true, tokens };
    } catch (err) {
      return {
        success: false,
        error: `Failed to read file: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Remove a file from context.
   */
  removeFile(relativePath: string): boolean {
    const normalized = this.normalizePath(relativePath);
    const hadFile = this.files.has(normalized);
    this.files.delete(normalized);
    this.contentCache.delete(normalized);
    return hadFile;
  }

  /**
   * Get all tracked files.
   */
  getTrackedFiles(): TrackedFile[] {
    return Array.from(this.files.values());
  }

  /**
   * Get paths of all tracked files.
   */
  getFilePaths(): string[] {
    return Array.from(this.files.keys());
  }

  /**
   * Get content of a tracked file.
   */
  getFileContent(relativePath: string): FileContent | undefined {
    const normalized = this.normalizePath(relativePath);
    const tracked = this.files.get(normalized);
    if (tracked) {
      tracked.lastAccessedAt = new Date().toISOString();
      tracked.accessCount++;
    }
    return this.contentCache.get(normalized);
  }

  /**
   * Get all file contents.
   */
  getAllContents(): Map<string, FileContent> {
    // Update access times
    for (const [path, tracked] of this.files) {
      tracked.lastAccessedAt = new Date().toISOString();
    }
    return new Map(this.contentCache);
  }

  /**
   * Update a file's content (e.g., after editing).
   */
  async updateFile(relativePath: string): Promise<{ success: boolean; tokens?: number; error?: string }> {
    const normalized = this.normalizePath(relativePath);
    const absolutePath = path.join(this.rootPath, normalized);

    if (!this.files.has(normalized)) {
      return { success: false, error: 'File not tracked' };
    }

    try {
      const content = await fs.readFile(absolutePath, 'utf-8');
      const tokens = tokenCounter.count(content);
      const now = new Date().toISOString();

      // Update tracking
      const tracked = this.files.get(normalized);
      if (tracked) {
        tracked.tokens = tokens;
        tracked.lastAccessedAt = now;
        tracked.accessCount++;
      }

      // Update cache
      this.contentCache.set(normalized, {
        path: normalized,
        content,
        tokens,
        loadedAt: now,
        modified: true,
      });

      return { success: true, tokens };
    } catch (err) {
      return {
        success: false,
        error: `Failed to update file: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Mark a file as modified.
   */
  markModified(relativePath: string): void {
    const normalized = this.normalizePath(relativePath);
    const content = this.contentCache.get(normalized);
    if (content) {
      content.modified = true;
    }
  }

  /**
   * Get total tokens used by tracked files.
   */
  getTotalTokens(): number {
    let total = 0;
    for (const tracked of this.files.values()) {
      total += tracked.tokens;
    }
    return total;
  }

  /**
   * Get remaining token budget.
   */
  getRemainingTokens(): number {
    return this.maxTokens - this.getTotalTokens();
  }

  /**
   * Check if a file is tracked.
   */
  isTracked(relativePath: string): boolean {
    return this.files.has(this.normalizePath(relativePath));
  }

  /**
   * Get files sorted by priority and recency.
   */
  getFilesByPriority(): TrackedFile[] {
    return Array.from(this.files.values()).sort((a, b) => {
      // First by priority (higher first)
      const priorityDiff = this.priorityValue(b.priority) - this.priorityValue(a.priority);
      if (priorityDiff !== 0) return priorityDiff;

      // Then by access count (higher first)
      const accessDiff = b.accessCount - a.accessCount;
      if (accessDiff !== 0) return accessDiff;

      // Then by recency (more recent first)
      return new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime();
    });
  }

  /**
   * Get modified files.
   */
  getModifiedFiles(): string[] {
    const modified: string[] = [];
    for (const [path, content] of this.contentCache) {
      if (content.modified) {
        modified.push(path);
      }
    }
    return modified;
  }

  /**
   * Update the maximum token budget.
   */
  setMaxTokens(maxTokens: number): void {
    this.maxTokens = maxTokens;
  }

  /**
   * Clear all tracked files.
   */
  clear(): void {
    this.files.clear();
    this.contentCache.clear();
  }

  /**
   * Normalize a file path.
   */
  private normalizePath(filePath: string): string {
    // Remove leading ./
    let normalized = filePath.replace(/^\.\//, '');
    // Resolve relative to root if absolute
    if (path.isAbsolute(filePath)) {
      normalized = path.relative(this.rootPath, filePath);
    }
    return normalized;
  }

  /**
   * Get numeric value for priority.
   */
  private priorityValue(priority: FilePriority): number {
    switch (priority) {
      case 'required':
        return 4;
      case 'high':
        return 3;
      case 'medium':
        return 2;
      case 'low':
        return 1;
    }
  }

  /**
   * Evict lower-priority files to make room.
   */
  private evictForSpace(neededTokens: number, minPriority: FilePriority): boolean {
    const minValue = this.priorityValue(minPriority);
    const available = this.maxTokens - this.getTotalTokens();

    if (available >= neededTokens) {
      return true;
    }

    // Find files we can evict (lower priority than the new file)
    const evictable = Array.from(this.files.values())
      .filter((f) => this.priorityValue(f.priority) < minValue)
      .sort((a, b) => {
        // Evict low priority first, then by least recently accessed
        const priorityDiff = this.priorityValue(a.priority) - this.priorityValue(b.priority);
        if (priorityDiff !== 0) return priorityDiff;
        return new Date(a.lastAccessedAt).getTime() - new Date(b.lastAccessedAt).getTime();
      });

    let freed = available;
    const toEvict: string[] = [];

    for (const file of evictable) {
      if (freed >= neededTokens) break;
      freed += file.tokens;
      toEvict.push(file.path);
    }

    if (freed < neededTokens) {
      return false; // Can't free enough space
    }

    // Evict the files
    for (const filePath of toEvict) {
      this.removeFile(filePath);
    }

    return true;
  }
}
