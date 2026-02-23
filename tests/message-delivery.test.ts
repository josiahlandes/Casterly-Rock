import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ConsoleDelivery,
  createDelivery,
} from '../src/autonomous/communication/delivery.js';

import { loadConfig } from '../src/autonomous/loop.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-delivery-test-${Date.now()}`);

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

function writeYaml(name: string, content: string): string {
  mkdirSync(TEST_BASE, { recursive: true });
  const fp = join(TEST_BASE, name);
  writeFileSync(fp, content, 'utf-8');
  return fp;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ConsoleDelivery
// ═══════════════════════════════════════════════════════════════════════════════

describe('ConsoleDelivery', () => {
  it('writes a JSONL entry to the outbox', async () => {
    const outboxPath = join(TEST_BASE, 'outbox.jsonl');
    mkdirSync(TEST_BASE, { recursive: true });

    const delivery = new ConsoleDelivery({ outboxPath });
    const result = await delivery.send('Test message', 'low');

    expect(result.delivered).toBe(true);
    expect(result.channel).toBe('console');

    const content = readFileSync(outboxPath, 'utf-8').trim();
    const entry = JSON.parse(content);
    expect(entry.message).toBe('Test message');
    expect(entry.urgency).toBe('low');
    expect(entry.timestamp).toBeTruthy();
  });

  it('appends multiple entries', async () => {
    const outboxPath = join(TEST_BASE, 'outbox-multi.jsonl');
    mkdirSync(TEST_BASE, { recursive: true });

    const delivery = new ConsoleDelivery({ outboxPath });
    await delivery.send('First', 'low');
    await delivery.send('Second', 'high');

    const lines = readFileSync(outboxPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).message).toBe('First');
    expect(JSON.parse(lines[1]!).message).toBe('Second');
  });

  it('creates parent directories if needed', async () => {
    const outboxPath = join(TEST_BASE, 'deep', 'nested', 'outbox.jsonl');

    const delivery = new ConsoleDelivery({ outboxPath });
    const result = await delivery.send('Deep message', 'medium');

    expect(result.delivered).toBe(true);
    expect(existsSync(outboxPath)).toBe(true);
  });

  it('has channel name "console"', () => {
    const delivery = new ConsoleDelivery();
    expect(delivery.channel).toBe('console');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createDelivery factory
// ═══════════════════════════════════════════════════════════════════════════════

describe('createDelivery', () => {
  it('creates a ConsoleDelivery for console channel', () => {
    const delivery = createDelivery({ channel: 'console' });
    expect(delivery.channel).toBe('console');
  });

  it('creates an IMessageDelivery for imessage channel with recipient', () => {
    const delivery = createDelivery({ channel: 'imessage', recipient: '+1234567890' });
    expect(delivery.channel).toBe('imessage');
  });

  it('throws when imessage channel is used without recipient', () => {
    expect(() => createDelivery({ channel: 'imessage' })).toThrow(
      /recipient/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// loadConfig — communication
// ═══════════════════════════════════════════════════════════════════════════════

describe('loadConfig — communication', () => {
  it('parses enabled communication config', async () => {
    const fp = writeYaml('comm-enabled.yaml', `
autonomous:
  enabled: true
communication:
  enabled: true
  delivery_channel: imessage
  recipient: "+15551234567"
  throttle:
    max_per_hour: 5
    max_per_day: 20
    quiet_hours: true
    quiet_start: "23:00"
    quiet_end: "07:00"
  test_failure_min_severity: always
  daily_summary_enabled: false
`);
    const config = await loadConfig(fp);
    expect(config.communication).toBeDefined();
    expect(config.communication!.enabled).toBe(true);
    expect(config.communication!.deliveryChannel).toBe('imessage');
    expect(config.communication!.recipient).toBe('+15551234567');
    expect(config.communication!.throttle?.maxPerHour).toBe(5);
    expect(config.communication!.throttle?.maxPerDay).toBe(20);
    expect(config.communication!.throttle?.quietStart).toBe('23:00');
    expect(config.communication!.throttle?.quietEnd).toBe('07:00');
    expect(config.communication!.testFailureMinSeverity).toBe('always');
    expect(config.communication!.dailySummaryEnabled).toBe(false);
  });

  it('returns undefined communication when disabled', async () => {
    const fp = writeYaml('comm-disabled.yaml', `
autonomous:
  enabled: true
communication:
  enabled: false
`);
    const config = await loadConfig(fp);
    expect(config.communication).toBeUndefined();
  });

  it('returns undefined communication when section is missing', async () => {
    const fp = writeYaml('no-comm.yaml', `
autonomous:
  enabled: true
`);
    const config = await loadConfig(fp);
    expect(config.communication).toBeUndefined();
  });

  it('applies throttle defaults when throttle section is partial', async () => {
    const fp = writeYaml('comm-defaults.yaml', `
autonomous:
  enabled: true
communication:
  enabled: true
  throttle:
    max_per_hour: 1
`);
    const config = await loadConfig(fp);
    expect(config.communication!.throttle?.maxPerHour).toBe(1);
    expect(config.communication!.throttle?.maxPerDay).toBe(10);
    expect(config.communication!.throttle?.quietStart).toBe('22:00');
  });

  it('defaults delivery_channel to console', async () => {
    const fp = writeYaml('comm-no-channel.yaml', `
autonomous:
  enabled: true
communication:
  enabled: true
`);
    const config = await loadConfig(fp);
    expect(config.communication!.deliveryChannel).toBe('console');
  });
});
