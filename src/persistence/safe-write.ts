/**
 * Atomic file write utility.
 *
 * Writes to a temporary file first, then renames it into place.
 * `rename()` is atomic on POSIX filesystems, so readers never see
 * a half-written file.
 */

import { writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Write `content` to `filePath` atomically.
 *
 * Strategy: write to `<filePath>.tmp`, then `rename()` over the target.
 * If the process crashes during `writeFile`, the original file is untouched.
 * If the process crashes during `rename`, the `.tmp` file is left behind
 * (harmless — next successful write cleans it up via overwrite).
 */
export async function safeWriteFile(
  filePath: string,
  content: string,
  encoding?: BufferEncoding,
): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  const tmp = filePath + '.tmp';
  await writeFile(tmp, content, encoding ?? 'utf8');
  await rename(tmp, filePath);
}
