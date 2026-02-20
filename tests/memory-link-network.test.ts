import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { LinkNetwork, createLinkNetwork } from '../src/autonomous/memory/link-network.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

let tempDir: string;

beforeEach(async () => {
  resetTracer();
  initTracer({ enabled: false });
  tempDir = await mkdtemp(join(tmpdir(), 'casterly-link-test-'));
});

afterEach(async () => {
  resetTracer();
  await rm(tempDir, { recursive: true, force: true });
});

function makeNetwork(maxLinks?: number): LinkNetwork {
  return createLinkNetwork({
    path: join(tempDir, 'links.json'),
    ...(maxLinks !== undefined ? { maxLinks } : {}),
  });
}

describe('LinkNetwork', () => {
  describe('createLink', () => {
    it('creates a link between two entries', () => {
      const net = makeNetwork();
      const result = net.createLink({
        sourceId: 'crystal-1',
        targetId: 'journal-1',
        type: 'supports',
      });

      expect(result.success).toBe(true);
      expect(result.linkId).toBeDefined();
      expect(net.count()).toBe(1);
    });

    it('prevents self-links', () => {
      const net = makeNetwork();
      const result = net.createLink({
        sourceId: 'crystal-1',
        targetId: 'crystal-1',
        type: 'related',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('itself');
    });

    it('strengthens existing links instead of duplicating', () => {
      const net = makeNetwork();
      net.createLink({ sourceId: 'a', targetId: 'b', type: 'supports', strength: 0.5 });
      net.createLink({ sourceId: 'a', targetId: 'b', type: 'supports' });

      expect(net.count()).toBe(1);
      const links = net.getLinksForEntry('a');
      expect(links[0]!.strength).toBeGreaterThan(0.5);
    });

    it('evicts weakest link when at capacity', () => {
      const net = makeNetwork(2);
      net.createLink({ sourceId: 'a', targetId: 'b', type: 'supports', strength: 0.3 });
      net.createLink({ sourceId: 'c', targetId: 'd', type: 'extends', strength: 0.9 });
      net.createLink({ sourceId: 'e', targetId: 'f', type: 'related', strength: 0.5 });

      expect(net.count()).toBe(2);
      // The weakest link (a-b, 0.3) should have been evicted
      expect(net.findLink('a', 'b')).toBeUndefined();
    });
  });

  describe('getNeighbors', () => {
    it('returns directly connected entries', () => {
      const net = makeNetwork();
      net.createLink({ sourceId: 'a', targetId: 'b', type: 'supports' });
      net.createLink({ sourceId: 'a', targetId: 'c', type: 'extends' });
      net.createLink({ sourceId: 'd', targetId: 'a', type: 'related' });

      const neighbors = net.getNeighbors('a');
      expect(neighbors).toContain('b');
      expect(neighbors).toContain('c');
      expect(neighbors).toContain('d');
      expect(neighbors).toHaveLength(3);
    });
  });

  describe('getNeighborhood', () => {
    it('returns multi-hop neighborhood', () => {
      const net = makeNetwork();
      net.createLink({ sourceId: 'a', targetId: 'b', type: 'supports' });
      net.createLink({ sourceId: 'b', targetId: 'c', type: 'extends' });
      net.createLink({ sourceId: 'c', targetId: 'd', type: 'related' });

      const oneHop = net.getNeighborhood('a', 1);
      expect(oneHop).toContain('b');
      expect(oneHop).not.toContain('c');

      const twoHop = net.getNeighborhood('a', 2);
      expect(twoHop).toContain('b');
      expect(twoHop).toContain('c');
    });
  });

  describe('removeLinksForEntry', () => {
    it('removes all links for a deleted entry', () => {
      const net = makeNetwork();
      net.createLink({ sourceId: 'a', targetId: 'b', type: 'supports' });
      net.createLink({ sourceId: 'a', targetId: 'c', type: 'extends' });
      net.createLink({ sourceId: 'd', targetId: 'e', type: 'related' });

      const removed = net.removeLinksForEntry('a');
      expect(removed).toBe(2);
      expect(net.count()).toBe(1);
    });
  });

  describe('persistence', () => {
    it('saves and loads link network', async () => {
      const net1 = makeNetwork();
      net1.createLink({ sourceId: 'a', targetId: 'b', type: 'supports' });
      net1.createLink({ sourceId: 'c', targetId: 'd', type: 'contradicts' });
      await net1.save();

      const net2 = makeNetwork();
      await net2.load();
      expect(net2.count()).toBe(2);
      expect(net2.findLink('a', 'b')).toBeDefined();
    });
  });

  describe('applyDecay', () => {
    it('prunes links below min strength', () => {
      const net = createLinkNetwork({
        path: join(tempDir, 'links.json'),
        minStrength: 0.1,
        decayRatePerDay: 100, // Aggressive decay for testing
      });

      net.createLink({ sourceId: 'a', targetId: 'b', type: 'supports', strength: 0.05 });
      net.createLink({ sourceId: 'c', targetId: 'd', type: 'extends', strength: 0.9 });

      const pruned = net.applyDecay();
      expect(pruned).toBeGreaterThanOrEqual(1);
      expect(net.count()).toBeLessThanOrEqual(1);
    });
  });
});
