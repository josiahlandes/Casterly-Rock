import { chmodSync, existsSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

const repoRoot = process.cwd();
const binSource = resolve(repoRoot, 'dist', 'index.js');
const binDir = join(homedir(), '.local', 'bin');
const binTarget = join(binDir, 'casterly');

if (!existsSync(binSource)) {
  console.error('[install] dist/index.js not found. Run `npm run build` first.');
  process.exit(1);
}

mkdirSync(binDir, { recursive: true });

try {
  chmodSync(binSource, 0o755);
} catch {
  // If chmod fails, continue; symlink may still work.
}

if (existsSync(binTarget)) {
  try {
    const current = readlinkSync(binTarget);
    if (resolve(binDir, current) === binSource) {
      console.log('[install] casterly already installed at', binTarget);
      process.exit(0);
    }
  } catch {
    // If it's a regular file or invalid symlink, remove it.
  }

  rmSync(binTarget, { force: true });
}

symlinkSync(binSource, binTarget);
console.log('[install] Installed casterly to', binTarget);
console.log('[install] Ensure ~/.local/bin is on your PATH.');
