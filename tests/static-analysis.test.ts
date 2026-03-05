import { describe, it, expect } from 'vitest';
import {
  extractImportBindings,
  extractAPISurface,
  extractMemberAccesses,
  validateProjectAPIs,
  detectUncapturedReturns,
} from '../src/tools/static-analysis.js';

// ─────────────────────────────────────────────────────────────────────────────
// extractImportBindings
// ─────────────────────────────────────────────────────────────────────────────

describe('extractImportBindings', () => {
  it('extracts named imports correctly', () => {
    const code = `import { Foo, Bar as Baz } from './module.js';`;
    const bindings = extractImportBindings(code);

    expect(bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ localName: 'Foo', source: './module.js', isDefault: false }),
        expect.objectContaining({ localName: 'Baz', source: './module.js', isDefault: false }),
      ]),
    );
  });

  it('handles default imports', () => {
    const code = `import MyClass from './my-class.js';`;
    const bindings = extractImportBindings(code);

    expect(bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ localName: 'MyClass', source: './my-class.js', isDefault: true }),
      ]),
    );
  });

  it('handles namespace imports (import * as X)', () => {
    const code = `import * as Utils from './utils.js';`;
    const bindings = extractImportBindings(code);

    expect(bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ localName: 'Utils', source: './utils.js' }),
      ]),
    );
  });

  it('handles combined default and named imports', () => {
    const code = `import Default, { named1, named2 } from './combo.js';`;
    const bindings = extractImportBindings(code);

    expect(bindings.length).toBe(3);
    expect(bindings.find((b) => b.localName === 'Default')?.isDefault).toBe(true);
    expect(bindings.find((b) => b.localName === 'named1')?.isDefault).toBe(false);
    expect(bindings.find((b) => b.localName === 'named2')?.isDefault).toBe(false);
  });

  it('ignores non-relative imports', () => {
    const code = `
      import fs from 'node:fs';
      import { join } from 'path';
      import { Foo } from './local.js';
    `;
    const bindings = extractImportBindings(code);

    // Only the relative import should be returned
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.localName).toBe('Foo');
    expect(bindings[0]!.source).toBe('./local.js');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractAPISurface
// ─────────────────────────────────────────────────────────────────────────────

describe('extractAPISurface', () => {
  it('finds exported functions', () => {
    const code = `
      export function doSomething() {}
      export async function doAsync() {}
    `;
    const api = extractAPISurface(code);

    expect(api.has('doSomething')).toBe(true);
    expect(api.has('doAsync')).toBe(true);
  });

  it('finds exported classes and their methods', () => {
    const code = `
      export class Player {
        move() {}
        async shoot() {}
        get health() { return 100; }
      }
    `;
    const api = extractAPISurface(code);

    expect(api.has('move')).toBe(true);
    expect(api.has('shoot')).toBe(true);
    expect(api.has('health')).toBe(true);
  });

  it('finds exported variables', () => {
    const code = `export const CONFIG = { speed: 5 };`;
    const api = extractAPISurface(code);
    expect(api.has('CONFIG')).toBe(true);
  });

  it('finds re-exports', () => {
    const code = `export { Foo, Bar as Baz };`;
    const api = extractAPISurface(code);

    expect(api.has('Foo')).toBe(true);
    expect(api.has('Baz')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractMemberAccesses
// ─────────────────────────────────────────────────────────────────────────────

describe('extractMemberAccesses', () => {
  it('finds method calls on an identifier', () => {
    const code = `
      player.move();
      player.shoot();
      player.move(); // duplicate
      enemy.attack();
    `;
    const members = extractMemberAccesses(code, 'player');

    expect(members).toContain('move');
    expect(members).toContain('shoot');
    // Deduplicated
    expect(members.filter((m) => m === 'move')).toHaveLength(1);
    // Does not include enemy's methods
    expect(members).not.toContain('attack');
  });

  it('finds property accesses (not just calls)', () => {
    const code = `const speed = config.baseSpeed;`;
    const members = extractMemberAccesses(code, 'config');
    expect(members).toContain('baseSpeed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateProjectAPIs
// ─────────────────────────────────────────────────────────────────────────────

describe('validateProjectAPIs', () => {
  it('catches missing member accesses (import binding calls method that does not exist in source)', () => {
    const files = new Map<string, string>();

    // main.js imports Foo and calls Foo.nonExistent() — but bar.js's Foo has no such method
    files.set('src/main.js', `
      import { Foo } from './bar.js';
      Foo.nonExistentMethod();
    `);

    files.set('src/bar.js', `
      export class Foo {
        doStuff() {}
      }
    `);

    const issues = validateProjectAPIs(files);

    // Should flag that Foo.nonExistentMethod is not found in bar.js
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.includes('nonExistentMethod'))).toBe(true);
  });

  it('reports no issues when imports match exports', () => {
    const files = new Map<string, string>();

    files.set('src/main.js', `
      import { Player } from './player.js';
      const p = new Player();
      p.move();
    `);

    files.set('src/player.js', `
      export class Player {
        move() {}
      }
    `);

    // Note: `p` is a local variable, not a direct import binding —
    // validateProjectAPIs only tracks direct import bindings' member accesses.
    // The import of `Player` itself is a named import; member accesses on
    // `Player` (e.g., `Player.staticMethod()`) would be checked.
    // This test verifies no false positives for clean code.
    const issues = validateProjectAPIs(files);

    // No issues since Player is exported and we don't call Player.anything
    // (we use `new Player()` which creates a local, not a member access on the binding)
    expect(issues).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectUncapturedReturns
// ─────────────────────────────────────────────────────────────────────────────

describe('detectUncapturedReturns', () => {
  it('catches the Neon Invaders bullet bug pattern: return value ignored', () => {
    const files = new Map<string, string>();

    files.set('enemies.js', `
      class Enemies {
        fireRandomBullet() {
          const bullet = { x: 10, y: 20 };
          return bullet;
        }
      }
    `);

    files.set('main.js', `
      enemies.fireRandomBullet();
    `);

    const issues = detectUncapturedReturns(files);

    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.includes('fireRandomBullet'))).toBe(true);
    expect(issues.some((i) => i.includes('not captured'))).toBe(true);
  });

  it('does NOT flag void functions', () => {
    const files = new Map<string, string>();

    files.set('renderer.js', `
      class Renderer {
        clearScreen() {
          ctx.clearRect(0, 0, 800, 600);
        }
      }
    `);

    files.set('main.js', `
      renderer.clearScreen();
    `);

    const issues = detectUncapturedReturns(files);

    // clearScreen has no return statement, so it should not be flagged
    expect(issues).toHaveLength(0);
  });

  it('does NOT flag when return value IS captured', () => {
    const files = new Map<string, string>();

    files.set('factory.js', `
      function createItem() {
        return { id: 1, name: 'sword' };
      }
    `);

    files.set('main.js', `
      const item = createItem();
    `);

    const issues = detectUncapturedReturns(files);
    expect(issues).toHaveLength(0);
  });

  it('does NOT flag common void-convention methods like push, forEach', () => {
    const files = new Map<string, string>();

    files.set('utils.js', `
      function push() {
        return true;
      }
    `);

    files.set('main.js', `
      items.push(newItem);
    `);

    const issues = detectUncapturedReturns(files);
    expect(issues).toHaveLength(0);
  });
});
