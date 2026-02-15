import { describe, expect, it } from 'vitest';

import { ProviderError, BillingError } from '../src/providers/base.js';

// ═══════════════════════════════════════════════════════════════════════════════
// ProviderError
// ═══════════════════════════════════════════════════════════════════════════════

describe('ProviderError', () => {
  it('creates error with message', () => {
    const err = new ProviderError('Connection failed');
    expect(err.message).toBe('Connection failed');
    expect(err.name).toBe('ProviderError');
  });

  it('is an instance of Error', () => {
    const err = new ProviderError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ProviderError);
  });

  it('accepts a cause', () => {
    const cause = new Error('underlying error');
    const err = new ProviderError('wrapper', cause);
    expect(err.cause).toBe(cause);
  });

  it('cause is undefined when not provided', () => {
    const err = new ProviderError('test');
    expect(err.cause).toBeUndefined();
  });

  it('has a stack trace', () => {
    const err = new ProviderError('test');
    expect(err.stack).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BillingError
// ═══════════════════════════════════════════════════════════════════════════════

describe('BillingError', () => {
  it('creates error with message', () => {
    const err = new BillingError('Credits exhausted');
    expect(err.message).toBe('Credits exhausted');
    expect(err.name).toBe('BillingError');
  });

  it('extends ProviderError', () => {
    const err = new BillingError('test');
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toBeInstanceOf(Error);
  });

  it('has a stack trace', () => {
    const err = new BillingError('test');
    expect(err.stack).toBeTruthy();
  });
});
