/**
 * Archive Parser
 *
 * Extracts file listings from .zip and .tar.gz archives.
 * Does NOT extract files to disk — returns metadata only for safety.
 */

import { createReadStream } from 'node:fs';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import extractZip from 'extract-zip';
import * as tar from 'tar';

interface ArchiveEntry {
  path: string;
  size: number;
  type: 'file' | 'directory';
}

interface ArchiveResult {
  format: 'zip' | 'tar.gz';
  totalEntries: number;
  totalSize: number;
  entries: ArchiveEntry[];
}

interface ArchiveOptions {
  /** Max number of entries to list (default: 500) */
  maxEntries?: number | undefined;
  /** Max total uncompressed size in bytes (default: 512 MB). Rejects zip bombs. */
  maxTotalSize?: number | undefined;
}

/** Default max total uncompressed size: 512 MB */
const DEFAULT_MAX_TOTAL_SIZE = 512 * 1024 * 1024;

/**
 * List contents of a zip archive from a buffer.
 */
export async function parseZip(
  buffer: Buffer,
  options: ArchiveOptions = {},
): Promise<ArchiveResult> {
  const maxEntries = options.maxEntries ?? 500;
  const maxTotalSize = options.maxTotalSize ?? DEFAULT_MAX_TOTAL_SIZE;

  // extract-zip requires a file path, so write buffer to temp
  const tmpDir = await mkdtemp(join(tmpdir(), 'casterly-zip-'));
  const zipPath = join(tmpDir, 'archive.zip');
  const extractDir = join(tmpDir, 'extracted');

  try {
    await writeFile(zipPath, buffer);

    const entries: ArchiveEntry[] = [];
    let totalSize = 0;

    await extractZip(zipPath, {
      dir: extractDir,
      onEntry: (entry) => {
        const size = entry.uncompressedSize ?? 0;
        totalSize += size;

        // Zip bomb protection: abort if cumulative uncompressed size is excessive
        if (totalSize > maxTotalSize) {
          throw new Error(
            `Archive exceeds maximum uncompressed size (${(maxTotalSize / 1024 / 1024).toFixed(0)} MB). Possible zip bomb.`,
          );
        }

        if (entries.length < maxEntries) {
          const isDir = entry.fileName.endsWith('/');
          entries.push({
            path: entry.fileName,
            size,
            type: isDir ? 'directory' : 'file',
          });
        }
      },
    });

    return {
      format: 'zip',
      totalEntries: entries.length,
      totalSize,
      entries,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * List contents of a tar.gz / .tgz archive from a file path.
 */
export async function parseTarGz(
  filePath: string,
  options: ArchiveOptions = {},
): Promise<ArchiveResult> {
  const maxEntries = options.maxEntries ?? 500;
  const maxTotalSize = options.maxTotalSize ?? DEFAULT_MAX_TOTAL_SIZE;
  const entries: ArchiveEntry[] = [];
  let totalSize = 0;

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath).pipe(
      tar.list({
        onReadEntry: (entry) => {
          const size = entry.size ?? 0;
          totalSize += size;

          // Tar bomb protection
          if (totalSize > maxTotalSize) {
            reject(
              new Error(
                `Archive exceeds maximum uncompressed size (${(maxTotalSize / 1024 / 1024).toFixed(0)} MB). Possible tar bomb.`,
              ),
            );
            return;
          }

          if (entries.length < maxEntries) {
            entries.push({
              path: entry.path,
              size,
              type: entry.type === 'Directory' ? 'directory' : 'file',
            });
          }
          entry.resume();
        },
      }),
    );

    stream.on('end', () => resolve());
    stream.on('error', (err: Error) => reject(err));
  });

  return {
    format: 'tar.gz',
    totalEntries: entries.length,
    totalSize,
    entries,
  };
}
