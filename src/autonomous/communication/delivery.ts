/**
 * Message Delivery — Backends for delivering user-facing messages
 *
 * Each implementation handles one delivery channel. The `message_user`
 * agent tool routes through MessagePolicy first, then calls the active
 * delivery backend.
 *
 * Privacy: Only status information about Tyrion's work is sent.
 * No sensitive user data is ever included in outbound messages.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getTracer } from '../debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Interface
// ─────────────────────────────────────────────────────────────────────────────

export interface DeliveryResult {
  delivered: boolean;
  channel: string;
  error?: string | undefined;
}

export interface MessageDelivery {
  /** Send a message to the user via this channel. */
  send(message: string, urgency: string): Promise<DeliveryResult>;

  /** The name of this delivery channel (for logging). */
  readonly channel: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// iMessage Delivery
// ─────────────────────────────────────────────────────────────────────────────

export interface IMessageDeliveryConfig {
  /** The recipient (phone number or Apple ID) */
  recipient: string;
}

export class IMessageDelivery implements MessageDelivery {
  readonly channel = 'imessage';
  private readonly recipient: string;

  constructor(config: IMessageDeliveryConfig) {
    this.recipient = config.recipient;
  }

  async send(message: string, urgency: string): Promise<DeliveryResult> {
    const tracer = getTracer();

    try {
      // Dynamic import to avoid hard dependency on imessage module
      // (sender.ts uses execSync which is only available on macOS)
      const { sendMessage } = await import('../../imessage/sender.js');
      const prefix = urgency === 'high' ? '[URGENT] ' : '';
      const result = sendMessage(this.recipient, `${prefix}${message}`);

      if (result.success) {
        tracer.log('communication', 'info', `iMessage delivered to ${this.recipient}`);
        return { delivered: true, channel: this.channel };
      }

      tracer.log('communication', 'warn', `iMessage delivery failed: ${result.error}`);
      return { delivered: false, channel: this.channel, error: result.error };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      tracer.log('communication', 'error', `iMessage delivery error: ${error}`);
      return { delivered: false, channel: this.channel, error };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Console (Outbox) Delivery — fallback when iMessage is not configured
// ─────────────────────────────────────────────────────────────────────────────

export interface ConsoleDeliveryConfig {
  /** Path to the outbox file. Default: ~/.casterly/outbox.jsonl */
  outboxPath?: string | undefined;
}

const DEFAULT_OUTBOX_PATH = '~/.casterly/outbox.jsonl';

function resolvePath(p: string): string {
  if (p.startsWith('~/')) {
    return p.replace('~', process.env['HOME'] ?? '/tmp');
  }
  return p;
}

export class ConsoleDelivery implements MessageDelivery {
  readonly channel = 'console';
  private readonly outboxPath: string;

  constructor(config?: ConsoleDeliveryConfig) {
    this.outboxPath = resolvePath(config?.outboxPath ?? DEFAULT_OUTBOX_PATH);
  }

  async send(message: string, urgency: string): Promise<DeliveryResult> {
    const tracer = getTracer();

    try {
      const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        message,
        urgency,
      });

      await mkdir(dirname(this.outboxPath), { recursive: true });
      await appendFile(this.outboxPath, entry + '\n', 'utf-8');

      tracer.log('communication', 'info', `Message written to outbox: ${this.outboxPath}`);
      return { delivered: true, channel: this.channel };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      tracer.log('communication', 'error', `Outbox write failed: ${error}`);
      return { delivered: false, channel: this.channel, error };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export type DeliveryChannel = 'imessage' | 'console';

export interface DeliveryConfig {
  channel: DeliveryChannel;
  /** Required when channel is 'imessage' */
  recipient?: string | undefined;
  /** Path to outbox file (console channel only) */
  outboxPath?: string | undefined;
}

export function createDelivery(config: DeliveryConfig): MessageDelivery {
  switch (config.channel) {
    case 'imessage':
      if (!config.recipient) {
        throw new Error('iMessage delivery requires a recipient (phone number or Apple ID)');
      }
      return new IMessageDelivery({ recipient: config.recipient });
    case 'console':
      return new ConsoleDelivery({ outboxPath: config.outboxPath });
  }
}
