/**
 * Cognitive Map — Machine & Filesystem Awareness
 *
 * Persistent spatial model of the entire machine Tyrion runs on.
 * This is proprioception: Tyrion always knows what hardware he has,
 * what runtime he's using, and what territory he's explored on the
 * filesystem.
 *
 * The map is divided into:
 *   - machine: hardware specs, OS, hostname (static, rarely changes)
 *   - runtime: Ollama endpoint, loaded models, Node version (semi-static)
 *   - filesystem: directories categorized as familiar / visited / unexplored
 *
 * Update strategy:
 *   - Full scan: during dream cycles or on first boot (expensive)
 *   - Partial scan: refresh runtime info after each cycle (cheap)
 *   - Explorer pass: one directory per dream cycle gets promoted
 *
 * Storage: ~/.casterly/cognitive-map.yaml
 */

import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { getTracer } from '../autonomous/debug.js';

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface MachineInfo {
  hostname: string;
  os: string;
  osVersion: string;
  chip: string;
  memory: string;
  disk: string;
}

export interface RuntimeInfo {
  ollamaEndpoint: string;
  modelsLoaded: string[];
  nodeVersion: string;
  lastChecked: string;
}

export type DirectoryFamiliarity = 'familiar' | 'visited' | 'unexplored';

export interface DirectoryEntry {
  path: string;
  role: string;
  familiarity: DirectoryFamiliarity;
  lastExplored: string;
  /** Number of files found on last scan (rough sense of size) */
  fileCount?: number;
}

export interface CognitiveMapData {
  version: number;
  lastFullScan: string;
  machine: MachineInfo;
  runtime: RuntimeInfo;
  directories: DirectoryEntry[];
}

export interface CognitiveMapConfig {
  path: string;
  commandTimeoutMs: number;
  /** Directories to auto-seed on first boot */
  seedDirectories: Array<{ path: string; role: string; familiarity: DirectoryFamiliarity }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

const homeDir = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';

const DEFAULT_CONFIG: CognitiveMapConfig = {
  path: '~/.casterly/cognitive-map.yaml',
  commandTimeoutMs: 15_000,
  seedDirectories: [
    { path: `${homeDir}/Casterly-Rock`, role: 'my codebase — where I live', familiarity: 'familiar' },
    { path: `${homeDir}/.casterly`, role: 'my persistent memory', familiarity: 'familiar' },
    { path: `${homeDir}/.config`, role: 'user tool configurations', familiarity: 'visited' },
    { path: `${homeDir}/Documents`, role: 'user documents', familiarity: 'unexplored' },
    { path: `${homeDir}/Projects`, role: 'user projects', familiarity: 'unexplored' },
    { path: `${homeDir}/Desktop`, role: 'user desktop', familiarity: 'unexplored' },
    { path: `${homeDir}/Downloads`, role: 'user downloads', familiarity: 'unexplored' },
  ],
};

function resolvePath(filePath: string): string {
  if (filePath.startsWith('~')) {
    return filePath.replace('~', homeDir);
  }
  return filePath;
}

function createEmptyMap(): CognitiveMapData {
  const now = new Date().toISOString();
  return {
    version: 1,
    lastFullScan: '',
    machine: {
      hostname: '',
      os: '',
      osVersion: '',
      chip: '',
      memory: '',
      disk: '',
    },
    runtime: {
      ollamaEndpoint: 'http://localhost:11434',
      modelsLoaded: [],
      nodeVersion: process.version,
      lastChecked: now,
    },
    directories: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CognitiveMap
// ─────────────────────────────────────────────────────────────────────────────

export class CognitiveMap {
  private readonly config: CognitiveMapConfig;
  private data: CognitiveMapData;
  private dirty: boolean = false;

  constructor(config?: Partial<CognitiveMapConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.data = createEmptyMap();
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  async load(): Promise<void> {
    const tracer = getTracer();
    const resolvedPath = resolvePath(this.config.path);

    try {
      const raw = await readFile(resolvedPath, 'utf8');
      const parsed = YAML.parse(raw) as unknown;

      if (parsed && typeof parsed === 'object' && 'version' in parsed) {
        this.data = parsed as CognitiveMapData;
        this.dirty = false;
        tracer.log('metacognition', 'info', 'Cognitive map loaded', {
          directories: this.data.directories.length,
          lastFullScan: this.data.lastFullScan,
        });
      } else {
        tracer.log('metacognition', 'warn', 'Cognitive map has unexpected structure, initializing fresh');
        this.data = createEmptyMap();
        this.dirty = true;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        tracer.log('metacognition', 'info', 'No cognitive map found, will initialize on first scan');
        this.data = createEmptyMap();
        this.dirty = true;
      } else {
        tracer.log('metacognition', 'error', 'Failed to load cognitive map', {
          error: err instanceof Error ? err.message : String(err),
        });
        this.data = createEmptyMap();
        this.dirty = true;
      }
    }

    // Seed directories if this is a fresh map
    if (this.data.directories.length === 0) {
      this.seedDirectories();
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;

    const tracer = getTracer();
    const resolvedPath = resolvePath(this.config.path);
    await mkdir(dirname(resolvedPath), { recursive: true });

    const content = YAML.stringify(this.data, { lineWidth: 120 });
    await writeFile(resolvedPath, content, 'utf8');
    this.dirty = false;

    tracer.log('metacognition', 'debug', 'Cognitive map saved');
  }

  // ── Scanning ─────────────────────────────────────────────────────────────

  /**
   * Full scan: gather machine info, runtime info, and verify directory state.
   * Expensive — call during dream cycles or on first boot.
   */
  async fullScan(): Promise<void> {
    const tracer = getTracer();
    await tracer.withSpan('metacognition', 'fullScan', async () => {
      tracer.log('metacognition', 'info', 'Starting full cognitive map scan');

      const [machineResult, runtimeResult] = await Promise.allSettled([
        this.scanMachine(),
        this.scanRuntime(),
      ]);

      if (machineResult.status === 'fulfilled') {
        this.data.machine = machineResult.value;
      } else {
        tracer.log('metacognition', 'error', 'Machine scan failed', {
          error: machineResult.reason instanceof Error
            ? machineResult.reason.message
            : String(machineResult.reason),
        });
      }

      if (runtimeResult.status === 'fulfilled') {
        this.data.runtime = runtimeResult.value;
      } else {
        tracer.log('metacognition', 'error', 'Runtime scan failed', {
          error: runtimeResult.reason instanceof Error
            ? runtimeResult.reason.message
            : String(runtimeResult.reason),
        });
      }

      // Verify which directories still exist
      await this.verifyDirectories();

      this.data.lastFullScan = new Date().toISOString();
      this.dirty = true;

      tracer.log('metacognition', 'info', 'Full cognitive map scan complete', {
        hostname: this.data.machine.hostname,
        chip: this.data.machine.chip,
        directories: this.data.directories.length,
      });
    });
  }

  /**
   * Quick refresh — just update runtime info. Cheap, safe to call often.
   */
  async refreshRuntime(): Promise<void> {
    const tracer = getTracer();
    try {
      this.data.runtime = await this.scanRuntime();
      this.dirty = true;
      tracer.log('metacognition', 'debug', 'Runtime info refreshed');
    } catch (err) {
      tracer.log('metacognition', 'error', 'Runtime refresh failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Directory Operations ─────────────────────────────────────────────────

  /**
   * Explore a directory — scan its contents and promote its familiarity.
   * Called by the Explorer during dream cycles.
   */
  async exploreDirectory(dirPath: string): Promise<DirectoryEntry | null> {
    const tracer = getTracer();
    const now = new Date().toISOString();

    try {
      const entries = await readdir(dirPath);
      const stats = await stat(dirPath);
      const fileCount = entries.length;

      let entry = this.data.directories.find((d) => d.path === dirPath);
      if (entry) {
        // Promote familiarity
        if (entry.familiarity === 'unexplored') {
          entry.familiarity = 'visited';
        } else if (entry.familiarity === 'visited') {
          entry.familiarity = 'familiar';
        }
        entry.lastExplored = now;
        entry.fileCount = fileCount;
      } else {
        entry = {
          path: dirPath,
          role: 'discovered directory',
          familiarity: 'visited',
          lastExplored: now,
          fileCount,
        };
        this.data.directories.push(entry);
      }

      this.dirty = true;
      tracer.log('metacognition', 'debug', `Explored ${dirPath}: ${fileCount} entries, now ${entry.familiarity}`);
      return entry;
    } catch (err) {
      tracer.log('metacognition', 'debug', `Cannot explore ${dirPath}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Update the role annotation for a directory.
   */
  setDirectoryRole(dirPath: string, role: string): void {
    const entry = this.data.directories.find((d) => d.path === dirPath);
    if (entry) {
      entry.role = role;
      this.dirty = true;
    }
  }

  /**
   * Get the next unexplored or stale directory for the Explorer to visit.
   */
  getNextExplorationTarget(): DirectoryEntry | null {
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    // Prefer unexplored directories first
    const unexplored = this.data.directories.find((d) => d.familiarity === 'unexplored');
    if (unexplored) return unexplored;

    // Then stale visited directories (not explored in 7 days)
    const stale = this.data.directories
      .filter((d) => d.familiarity === 'visited' && now - new Date(d.lastExplored).getTime() > sevenDaysMs)
      .sort((a, b) => new Date(a.lastExplored).getTime() - new Date(b.lastExplored).getTime());

    return stale[0] ?? null;
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  getData(): Readonly<CognitiveMapData> {
    return this.data;
  }

  getMachine(): Readonly<MachineInfo> {
    return this.data.machine;
  }

  getRuntime(): Readonly<RuntimeInfo> {
    return this.data.runtime;
  }

  getDirectories(familiarity?: DirectoryFamiliarity): ReadonlyArray<DirectoryEntry> {
    if (familiarity) {
      return this.data.directories.filter((d) => d.familiarity === familiarity);
    }
    return this.data.directories;
  }

  /**
   * Build a compact summary for the identity prompt hot tier.
   * Designed to be ~400-600 chars so it fits alongside other hot-tier content.
   */
  buildSummary(): string {
    const m = this.data.machine;
    const r = this.data.runtime;
    const dirs = this.data.directories;

    const lines: string[] = [];

    // Machine (only if scanned)
    if (m.hostname) {
      lines.push('## My Machine');
      lines.push(`- Host: ${m.hostname} | OS: ${m.os} ${m.osVersion}`);
      lines.push(`- Hardware: ${m.chip} | ${m.memory}`);
      if (m.disk) lines.push(`- Disk: ${m.disk}`);
    }

    // Runtime
    lines.push('');
    lines.push('## My Runtime');
    lines.push(`- Ollama: ${r.ollamaEndpoint}`);
    if (r.modelsLoaded.length > 0) {
      lines.push(`- Models loaded: ${r.modelsLoaded.join(', ')}`);
    }
    lines.push(`- Node: ${r.nodeVersion}`);

    // Filesystem overview
    const familiar = dirs.filter((d) => d.familiarity === 'familiar');
    const visited = dirs.filter((d) => d.familiarity === 'visited');
    const unexplored = dirs.filter((d) => d.familiarity === 'unexplored');

    if (dirs.length > 0) {
      lines.push('');
      lines.push('## My Filesystem');
      if (familiar.length > 0) {
        lines.push('Known well:');
        for (const d of familiar) {
          lines.push(`- ${d.path} — ${d.role}`);
        }
      }
      if (visited.length > 0) {
        lines.push(`Visited: ${visited.map((d) => d.path).join(', ')}`);
      }
      if (unexplored.length > 0) {
        lines.push(`Unexplored: ${unexplored.map((d) => d.path).join(', ')}`);
      }
    }

    return lines.join('\n');
  }

  // ── Private Helpers ──────────────────────────────────────────────────────

  private seedDirectories(): void {
    const now = new Date().toISOString();
    for (const seed of this.config.seedDirectories) {
      this.data.directories.push({
        path: seed.path,
        role: seed.role,
        familiarity: seed.familiarity,
        lastExplored: seed.familiarity === 'familiar' ? now : '',
      });
    }
    this.dirty = true;
  }

  private async verifyDirectories(): Promise<void> {
    const verified: DirectoryEntry[] = [];
    for (const dir of this.data.directories) {
      try {
        await stat(dir.path);
        verified.push(dir);
      } catch {
        // Directory no longer exists — drop it
      }
    }
    this.data.directories = verified;
  }

  private async scanMachine(): Promise<MachineInfo> {
    const timeout = this.config.commandTimeoutMs;

    // Platform-aware scanning
    const platform = process.platform;

    if (platform === 'darwin') {
      return this.scanMachineDarwin(timeout);
    }
    return this.scanMachineLinux(timeout);
  }

  private async scanMachineDarwin(timeout: number): Promise<MachineInfo> {
    const [hostnameRes, chipRes, memRes, diskRes, osRes] = await Promise.allSettled([
      execFileAsync('hostname', [], { timeout }),
      execFileAsync('sysctl', ['-n', 'machdep.cpu.brand_string'], { timeout }),
      execFileAsync('sysctl', ['-n', 'hw.memsize'], { timeout }),
      execFileAsync('df', ['-h', '/'], { timeout }),
      execFileAsync('sw_vers', ['-productVersion'], { timeout }),
    ]);

    const hostname = hostnameRes.status === 'fulfilled' ? hostnameRes.value.stdout.trim() : 'unknown';
    const chip = chipRes.status === 'fulfilled' ? chipRes.value.stdout.trim() : 'unknown';
    const osVersion = osRes.status === 'fulfilled' ? osRes.value.stdout.trim() : 'unknown';

    let memory = 'unknown';
    if (memRes.status === 'fulfilled') {
      const bytes = parseInt(memRes.value.stdout.trim(), 10);
      if (!isNaN(bytes)) {
        memory = `${Math.round(bytes / (1024 * 1024 * 1024))}GB`;
      }
    }

    let disk = '';
    if (diskRes.status === 'fulfilled') {
      const lines = diskRes.value.stdout.trim().split('\n');
      if (lines[1]) {
        const parts = lines[1].split(/\s+/);
        disk = `${parts[1] ?? '?'} total, ${parts[3] ?? '?'} free`;
      }
    }

    return { hostname, os: 'macOS', osVersion, chip, memory, disk };
  }

  private async scanMachineLinux(timeout: number): Promise<MachineInfo> {
    const [hostnameRes, cpuRes, memRes, diskRes, osRes] = await Promise.allSettled([
      execFileAsync('hostname', [], { timeout }),
      execFileAsync('cat', ['/proc/cpuinfo'], { timeout }),
      execFileAsync('cat', ['/proc/meminfo'], { timeout }),
      execFileAsync('df', ['-h', '/'], { timeout }),
      execFileAsync('cat', ['/etc/os-release'], { timeout }),
    ]);

    const hostname = hostnameRes.status === 'fulfilled' ? hostnameRes.value.stdout.trim() : 'unknown';

    let chip = 'unknown';
    if (cpuRes.status === 'fulfilled') {
      const modelLine = cpuRes.value.stdout.split('\n').find((l: string) => l.startsWith('model name'));
      if (modelLine) {
        chip = modelLine.split(':')[1]?.trim() ?? 'unknown';
      }
    }

    let memory = 'unknown';
    if (memRes.status === 'fulfilled') {
      const memLine = memRes.value.stdout.split('\n').find((l: string) => l.startsWith('MemTotal'));
      if (memLine) {
        const kb = parseInt(memLine.split(':')[1]?.trim() ?? '0', 10);
        if (!isNaN(kb)) {
          memory = `${Math.round(kb / (1024 * 1024))}GB`;
        }
      }
    }

    let disk = '';
    if (diskRes.status === 'fulfilled') {
      const lines = diskRes.value.stdout.trim().split('\n');
      if (lines[1]) {
        const parts = lines[1].split(/\s+/);
        disk = `${parts[1] ?? '?'} total, ${parts[3] ?? '?'} free`;
      }
    }

    let os = 'Linux';
    let osVersion = 'unknown';
    if (osRes.status === 'fulfilled') {
      const prettyName = osRes.value.stdout.split('\n').find((l: string) => l.startsWith('PRETTY_NAME'));
      if (prettyName) {
        const value = prettyName.split('=')[1]?.replace(/"/g, '').trim();
        if (value) {
          os = value;
          osVersion = '';
        }
      }
    }

    return { hostname, os, osVersion, chip, memory, disk };
  }

  private async scanRuntime(): Promise<RuntimeInfo> {
    const timeout = this.config.commandTimeoutMs;
    const endpoint = this.data.runtime.ollamaEndpoint || 'http://localhost:11434';

    let modelsLoaded: string[] = [];
    try {
      const { stdout } = await execFileAsync('curl', ['-s', `${endpoint}/api/tags`], { timeout });
      const parsed = JSON.parse(stdout) as { models?: Array<{ name?: string }> };
      if (parsed.models) {
        modelsLoaded = parsed.models
          .map((m) => m.name)
          .filter((n): n is string => typeof n === 'string');
      }
    } catch {
      // Ollama might not be running
    }

    return {
      ollamaEndpoint: endpoint,
      modelsLoaded,
      nodeVersion: process.version,
      lastChecked: new Date().toISOString(),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createCognitiveMap(config?: Partial<CognitiveMapConfig>): CognitiveMap {
  return new CognitiveMap(config);
}
