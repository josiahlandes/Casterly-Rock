import { describe, expect, it } from 'vitest';

import { isAcknowledgementMessage } from '../src/imessage/message-utils.js';

describe('isAcknowledgementMessage', () => {
  it('detects simple thanks', () => {
    expect(isAcknowledgementMessage('Awesome, thanks')).toBe(true);
    expect(isAcknowledgementMessage('Thanks!')).toBe(true);
  });

  it('rejects acknowledgements that include new requests', () => {
    expect(isAcknowledgementMessage('Thanks, can you add a note?')).toBe(false);
    expect(isAcknowledgementMessage('Awesome, but also add this')).toBe(false);
  });

  it('rejects questions', () => {
    expect(isAcknowledgementMessage('Thanks?')).toBe(false);
  });
});
