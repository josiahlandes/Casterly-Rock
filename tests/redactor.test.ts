import { describe, expect, it } from 'vitest';

import { redactSensitiveText } from '../src/security/redactor.js';

describe('redactSensitiveText', () => {
  it('redacts SSN-like patterns', () => {
    const redacted = redactSensitiveText('SSN: 123-45-6789');
    expect(redacted).not.toContain('123-45-6789');
    expect(redacted).toContain('[REDACTED]');
  });

  it('redacts credential-like patterns', () => {
    const redacted = redactSensitiveText('api_key = sk-1234567890abcdef');
    expect(redacted.toLowerCase()).not.toContain('sk-1234567890abcdef');
    expect(redacted).toContain('[REDACTED]');
  });
});
