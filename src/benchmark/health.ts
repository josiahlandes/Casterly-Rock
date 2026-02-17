/**
 * Ollama Health Check & Memory Footprint
 *
 * Pre-flight checks before benchmark runs:
 * 1. Verify Ollama is running and responsive
 * 2. Verify the target model is available
 * 3. Capture VRAM/memory footprint via /api/ps
 * 4. Detect cold-start vs warm-start conditions
 *
 * All checks are local-only (privacy-first).
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OllamaHealthStatus {
  /** Whether Ollama is running and responsive */
  healthy: boolean;
  /** Ollama version string if available */
  version?: string | undefined;
  /** Error message if unhealthy */
  error?: string | undefined;
}

export interface ModelAvailability {
  /** Whether the model is available (pulled) */
  available: boolean;
  /** Model name as resolved by Ollama */
  resolvedName?: string | undefined;
  /** Model parameter size (e.g., "7B") */
  parameterSize?: string | undefined;
  /** Model quantization level (e.g., "Q4_K_M") */
  quantization?: string | undefined;
  /** Error message if unavailable */
  error?: string | undefined;
}

export interface MemoryFootprint {
  /** VRAM used by the model in bytes */
  vramBytes: number;
  /** VRAM used in human-readable form (e.g., "4.2 GB") */
  vramFormatted: string;
  /** RAM used by the model in bytes (for CPU-offloaded layers) */
  ramBytes: number;
  /** RAM used in human-readable form */
  ramFormatted: string;
  /** Whether the model is fully loaded in GPU memory */
  fullyGpuLoaded: boolean;
  /** Timestamp of the measurement */
  timestamp: number;
}

export interface WarmthStatus {
  /** Whether the model is warm (already loaded in memory) */
  isWarm: boolean;
  /** If warm, time since last use in seconds */
  idleSecs?: number | undefined;
  /** If cold, estimated load time from a warmup probe in ms */
  coldStartMs?: number | undefined;
}

export interface HealthReport {
  ollama: OllamaHealthStatus;
  model: ModelAvailability;
  memory?: MemoryFootprint | undefined;
  warmth?: WarmthStatus | undefined;
  /** Total time for all health checks in ms */
  checkDurationMs: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(1)} ${units[i]}`;
}

// ─── Ollama Health Check ─────────────────────────────────────────────────────

async function checkOllamaHealth(baseUrl: string): Promise<OllamaHealthStatus> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/version`, {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      return { healthy: false, error: `Ollama responded with ${response.status}` };
    }

    const data = (await response.json()) as { version?: string };
    return { healthy: true, version: data.version };
  } catch (err) {
    return {
      healthy: false,
      error: `Cannot reach Ollama at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Model Availability ──────────────────────────────────────────────────────

interface OllamaModelInfo {
  name?: string;
  details?: {
    parameter_size?: string;
    quantization_level?: string;
  };
}

interface OllamaTagsResponse {
  models?: OllamaModelInfo[];
}

async function checkModelAvailability(
  baseUrl: string,
  modelId: string,
): Promise<ModelAvailability> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return { available: false, error: `Failed to list models: ${response.status}` };
    }

    const data = (await response.json()) as OllamaTagsResponse;
    const models = data.models ?? [];

    // Match by exact name or prefix (e.g., "qwen2.5-coder" matches "qwen2.5-coder:7b")
    const match = models.find(
      (m) => m.name === modelId || m.name?.startsWith(`${modelId}:`),
    );

    if (!match) {
      return {
        available: false,
        error: `Model "${modelId}" not found. Available: ${models.map((m) => m.name).join(', ')}`,
      };
    }

    return {
      available: true,
      resolvedName: match.name,
      parameterSize: match.details?.parameter_size,
      quantization: match.details?.quantization_level,
    };
  } catch (err) {
    return {
      available: false,
      error: `Failed to check model: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Memory Footprint ────────────────────────────────────────────────────────

interface OllamaPsModel {
  name?: string;
  size?: number;
  size_vram?: number;
  expires_at?: string;
}

interface OllamaPsResponse {
  models?: OllamaPsModel[];
}

async function getMemoryFootprint(
  baseUrl: string,
  modelId: string,
): Promise<MemoryFootprint | undefined> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/ps`, {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) return undefined;

    const data = (await response.json()) as OllamaPsResponse;
    const models = data.models ?? [];

    const match = models.find(
      (m) => m.name === modelId || m.name?.startsWith(`${modelId}:`),
    );

    if (!match) return undefined;

    const totalSize = match.size ?? 0;
    const vramSize = match.size_vram ?? 0;
    const ramSize = totalSize - vramSize;

    return {
      vramBytes: vramSize,
      vramFormatted: formatBytes(vramSize),
      ramBytes: Math.max(0, ramSize),
      ramFormatted: formatBytes(Math.max(0, ramSize)),
      fullyGpuLoaded: ramSize <= 0,
      timestamp: Date.now(),
    };
  } catch {
    return undefined;
  }
}

// ─── Warmth Detection ────────────────────────────────────────────────────────

async function detectWarmth(
  baseUrl: string,
  modelId: string,
): Promise<WarmthStatus> {
  try {
    // Check /api/ps to see if model is loaded
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/ps`, {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      return { isWarm: false };
    }

    const data = (await response.json()) as OllamaPsResponse;
    const models = data.models ?? [];

    const match = models.find(
      (m) => m.name === modelId || m.name?.startsWith(`${modelId}:`),
    );

    if (match) {
      // Model is loaded — it's warm
      let idleSecs: number | undefined;
      if (match.expires_at) {
        // Ollama sets expires_at as when the model will be unloaded
        // We can't directly get idle time, but the model is warm
        idleSecs = 0;
      }
      return { isWarm: true, idleSecs };
    }

    // Model not loaded — do a warmup probe to measure cold start
    const probeStart = Date.now();
    const probeResponse = await fetch(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false,
        options: { num_predict: 1 },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const coldStartMs = Date.now() - probeStart;

    if (probeResponse.ok) {
      return { isWarm: false, coldStartMs };
    }

    return { isWarm: false };
  } catch {
    return { isWarm: false };
  }
}

// ─── Full Health Check ───────────────────────────────────────────────────────

/**
 * Run a full pre-flight health check before benchmark runs.
 * Returns a comprehensive health report with Ollama status, model availability,
 * memory footprint, and warmth status.
 */
export async function runHealthCheck(
  baseUrl: string,
  modelId: string,
  options?: { skipWarmth?: boolean },
): Promise<HealthReport> {
  const start = Date.now();

  // Step 1: Check Ollama is running
  const ollama = await checkOllamaHealth(baseUrl);
  if (!ollama.healthy) {
    return {
      ollama,
      model: { available: false, error: 'Skipped — Ollama not healthy' },
      checkDurationMs: Date.now() - start,
    };
  }

  // Step 2: Check model availability
  const model = await checkModelAvailability(baseUrl, modelId);
  if (!model.available) {
    return {
      ollama,
      model,
      checkDurationMs: Date.now() - start,
    };
  }

  // Step 3 & 4: Memory footprint and warmth (can run in parallel)
  const [memory, warmth] = await Promise.all([
    getMemoryFootprint(baseUrl, modelId),
    options?.skipWarmth ? Promise.resolve(undefined) : detectWarmth(baseUrl, modelId),
  ]);

  return {
    ollama,
    model,
    memory: memory ?? undefined,
    warmth: warmth ?? undefined,
    checkDurationMs: Date.now() - start,
  };
}

/**
 * Format a health report for console output.
 */
export function formatHealthReport(report: HealthReport): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('─'.repeat(50));
  lines.push('PRE-FLIGHT HEALTH CHECK');
  lines.push('─'.repeat(50));

  // Ollama status
  const ollamaIcon = report.ollama.healthy ? '\x1b[32mOK\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  lines.push(`  Ollama:    ${ollamaIcon}${report.ollama.version ? ` (v${report.ollama.version})` : ''}`);
  if (report.ollama.error) {
    lines.push(`             ${report.ollama.error}`);
  }

  // Model status
  const modelIcon = report.model.available ? '\x1b[32mOK\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  lines.push(`  Model:     ${modelIcon}${report.model.resolvedName ? ` (${report.model.resolvedName})` : ''}`);
  if (report.model.parameterSize) {
    lines.push(`             Size: ${report.model.parameterSize}${report.model.quantization ? `, Quant: ${report.model.quantization}` : ''}`);
  }
  if (report.model.error) {
    lines.push(`             ${report.model.error}`);
  }

  // Memory footprint
  if (report.memory) {
    lines.push(`  VRAM:      ${report.memory.vramFormatted}${report.memory.fullyGpuLoaded ? ' (fully GPU)' : ''}`);
    if (report.memory.ramBytes > 0) {
      lines.push(`  RAM:       ${report.memory.ramFormatted} (CPU offload)`);
    }
  }

  // Warmth
  if (report.warmth) {
    const warmIcon = report.warmth.isWarm ? '\x1b[32mWARM\x1b[0m' : '\x1b[33mCOLD\x1b[0m';
    lines.push(`  Status:    ${warmIcon}`);
    if (report.warmth.coldStartMs !== undefined) {
      lines.push(`             Cold-start load: ${report.warmth.coldStartMs.toFixed(0)}ms`);
    }
  }

  lines.push(`  Check:     ${report.checkDurationMs.toFixed(0)}ms`);
  lines.push('─'.repeat(50));

  return lines.join('\n');
}
