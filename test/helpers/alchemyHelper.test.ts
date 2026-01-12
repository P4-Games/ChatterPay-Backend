import { describe, expect, it } from 'vitest';

import { fromTopicAddress, toTopicAddress } from '../../src/helpers/alchemyHelper';

describe('alchemyHelper', () => {
  const addr = '0xc17456b51ce6bebc5fb01869d1403517111dbe02';
  const topic = `0x000000000000000000000000${addr.slice(2)}`;

  it('should convert to padded topic', () => {
    expect(toTopicAddress(addr)).toBe(topic);
  });

  it('should handle address without 0x prefix', () => {
    expect(toTopicAddress(addr.slice(2))).toBe(topic);
  });

  it('should extract address from topic', () => {
    expect(fromTopicAddress(topic)).toBe(addr);
  });

  it('should handle topic without 0x prefix', () => {
    expect(fromTopicAddress(topic.slice(2))).toBe(addr);
  });

  it('should be reversible (round-trip)', () => {
    const encoded = toTopicAddress(addr);
    const decoded = fromTopicAddress(encoded);
    expect(decoded).toBe(addr);
  });
});
