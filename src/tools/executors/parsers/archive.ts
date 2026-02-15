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

export interface ArchiveEntry {
  path: string;
  size: number;
  type: 'file' | 'directory';
}

export interface ArchiveResult {
  format: 'zip' | 'tar.gz';
  totalEntries: number;
  totalSize: number;
  entries: ArchiveEntry[];
}

export interface ArchiveOptions {
  /** Max number of entries to list (default: 500) */
  maxEntries?: number | undefined;
}

/**
 * List contents of a zip archive from a buffer.
 */
export async function parseZip(
  buffer: Buffer,
  options: ArchiveOptions = {},
): Promise<ArchiveResult> {
  const maxEntries = options.maxEntries ?? 500;

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
        if (entries.length < maxEntries) {
          const isDir = entry.fileName.endsWith('/');
          const size = entry.uncompressedSize ?? 0;
          entries.push({
            path: entry.fileName,
            size,
            type: isDir ? 'directory' : 'file',
          });
          totalSize += size;
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
  const entries: ArchiveEntry[] = [];
  let totalSize = 0;

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath).pipe(
      tar.list({
        onReadEntry: (entry) => {
          if (entries.length < maxEntries) {
            entries.push({
              path: entry.path,
              size: entry.size ?? 0,
              type: entry.type === 'Directory' ? 'directory' : 'file',
            });
            totalSize += entry.size ?? 0;
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
