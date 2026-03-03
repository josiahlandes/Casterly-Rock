import { describe, expect, it } from 'vitest';
import {
  extractImportBindings,
  extractMemberAccesses,
  extractAPISurface,
  extractObjectPropertyNames,
} from '../src/dual-loop/deep-loop.js';

// ─────────────────────────────────────────────────────────────────────────────
// extractImportBindings
// ─────────────────────────────────────────────────────────────────────────────

describe('extractImportBindings', () => {
  it('extracts default imports', () => {
    const content = `import Player from './player.js';`;
    const bindings = extractImportBindings(content);
    expect(bindings).toEqual([
      { localName: 'Player', source: './player.js', isDefault: true },
    ]);
  });

  it('extracts named imports', () => {
    const content = `import { CANVAS_WIDTH, CANVAS_HEIGHT } from './config.js';`;
    const bindings = extractImportBindings(content);
    expect(bindings).toHaveLength(2);
    expect(bindings[0]).toEqual({ localName: 'CANVAS_WIDTH', source: './config.js', isDefault: false });
    expect(bindings[1]).toEqual({ localName: 'CANVAS_HEIGHT', source: './config.js', isDefault: false });
  });

  it('handles aliased imports', () => {
    const content = `import { speed as moveSpeed } from './config.js';`;
    const bindings = extractImportBindings(content);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.localName).toBe('moveSpeed');
  });

  it('handles namespace imports', () => {
    const content = `import * as Utils from './utils.js';`;
    const bindings = extractImportBindings(content);
    expect(bindings).toEqual([
      { localName: 'Utils', source: './utils.js', isDefault: false },
    ]);
  });

  it('handles combined default + named imports', () => {
    const content = `import Player, { PLAYER_CONFIG } from './player.js';`;
    const bindings = extractImportBindings(content);
    expect(bindings).toHaveLength(2);
    expect(bindings.find((b) => b.localName === 'Player')?.isDefault).toBe(true);
    expect(bindings.find((b) => b.localName === 'PLAYER_CONFIG')?.isDefault).toBe(false);
  });

  it('filters out non-relative imports', () => {
    const content = `
      import React from 'react';
      import Player from './player.js';
      import { useState } from 'react';
    `;
    const bindings = extractImportBindings(content);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.localName).toBe('Player');
  });

  it('ignores imports inside comments', () => {
    const content = `
      // import OldPlayer from './old-player.js';
      /* import { Legacy } from './legacy.js'; */
      import Player from './player.js';
    `;
    const bindings = extractImportBindings(content);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.localName).toBe('Player');
  });

  it('handles multiple imports from different files', () => {
    const content = `
      import Player from './player.js';
      import EnemyGrid from './enemies.js';
      import { checkCollision } from './collision.js';
    `;
    const bindings = extractImportBindings(content);
    expect(bindings).toHaveLength(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractMemberAccesses
// ─────────────────────────────────────────────────────────────────────────────

describe('extractMemberAccesses', () => {
  it('extracts method calls', () => {
    const content = `
      player.update(dt);
      player.draw(ctx);
    `;
    expect(extractMemberAccesses(content, 'player')).toEqual(
      expect.arrayContaining(['update', 'draw']),
    );
  });

  it('extracts property accesses', () => {
    const content = `const w = player.width; const h = player.height;`;
    expect(extractMemberAccesses(content, 'player')).toEqual(
      expect.arrayContaining(['width', 'height']),
    );
  });

  it('deduplicates results', () => {
    const content = `
      player.update(dt);
      player.update(dt2);
    `;
    const result = extractMemberAccesses(content, 'player');
    expect(result.filter((m) => m === 'update')).toHaveLength(1);
  });

  it('respects word boundaries', () => {
    const content = `
      player.update();
      myplayer.draw();
    `;
    expect(extractMemberAccesses(content, 'player')).toEqual(['update']);
  });

  it('ignores accesses inside comments', () => {
    const content = `
      // player.oldMethod();
      /* player.deprecatedMethod(); */
      player.currentMethod();
    `;
    expect(extractMemberAccesses(content, 'player')).toEqual(['currentMethod']);
  });

  it('returns empty for no accesses', () => {
    const content = `const x = 42;`;
    expect(extractMemberAccesses(content, 'player')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractAPISurface
// ─────────────────────────────────────────────────────────────────────────────

describe('extractAPISurface', () => {
  it('extracts class methods', () => {
    const content = `
export default class Player {
    constructor(x, y) {
        this.x = x;
    }

    update(dt) {
        this.x += dt;
    }

    draw(ctx) {
        ctx.fillRect(this.x, 0, 10, 10);
    }
}`;
    const api = extractAPISurface(content);
    expect(api.has('update')).toBe(true);
    expect(api.has('draw')).toBe(true);
    expect(api.has('constructor')).toBe(false);
  });

  it('extracts getters and setters', () => {
    const content = `
class Player {
    get health() { return this._health; }
    set health(v) { this._health = v; }
    update() {}
}`;
    const api = extractAPISurface(content);
    expect(api.has('health')).toBe(true);
    expect(api.has('update')).toBe(true);
  });

  it('extracts exported functions', () => {
    const content = `
export function checkCollision(a, b) { return true; }
export function pointInRect(x, y, rect) { return true; }
`;
    const api = extractAPISurface(content);
    expect(api.has('checkCollision')).toBe(true);
    expect(api.has('pointInRect')).toBe(true);
  });

  it('extracts exported variables', () => {
    const content = `
export const CANVAS_WIDTH = 800;
export const CANVAS_HEIGHT = 600;
export let score = 0;
`;
    const api = extractAPISurface(content);
    expect(api.has('CANVAS_WIDTH')).toBe(true);
    expect(api.has('CANVAS_HEIGHT')).toBe(true);
    expect(api.has('score')).toBe(true);
  });

  it('extracts re-exports', () => {
    const content = `export { Player, Enemy };`;
    const api = extractAPISurface(content);
    expect(api.has('Player')).toBe(true);
    expect(api.has('Enemy')).toBe(true);
  });

  it('excludes control flow keywords from class methods', () => {
    const content = `
class Player {
    update(dt) {
        if (this.alive) {
            for (let i = 0; i < 10; i++) {
                while (true) { break; }
            }
        }
    }
}`;
    const api = extractAPISurface(content);
    expect(api.has('update')).toBe(true);
    expect(api.has('if')).toBe(false);
    expect(api.has('for')).toBe(false);
    expect(api.has('while')).toBe(false);
  });

  it('handles async methods', () => {
    const content = `
export default class Loader {
    async loadData(url) { return fetch(url); }
    process(data) { return data; }
}`;
    const api = extractAPISurface(content);
    expect(api.has('loadData')).toBe(true);
    expect(api.has('process')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractObjectPropertyNames
// ─────────────────────────────────────────────────────────────────────────────

describe('extractObjectPropertyNames', () => {
  it('extracts top-level property names from an exported const object', () => {
    const content = `
export const ENEMIES = {
    rows: 5,
    cols: 8,
    baseSpeed: 50,
    maxSpeed: 200
};`;
    const props = extractObjectPropertyNames(content, 'ENEMIES');
    expect(props).toEqual(expect.arrayContaining(['rows', 'cols', 'baseSpeed', 'maxSpeed']));
  });

  it('extracts from non-exported const', () => {
    const content = `
const PLAYER = {
    width: 40,
    height: 30,
    speed: 500
};
export { PLAYER };`;
    const props = extractObjectPropertyNames(content, 'PLAYER');
    expect(props).toEqual(expect.arrayContaining(['width', 'height', 'speed']));
  });

  it('only extracts top-level keys from nested objects', () => {
    const content = `
export const CONFIG = {
    player: {
        width: 40,
        height: 30
    },
    enemy: {
        speed: 100
    }
};`;
    const props = extractObjectPropertyNames(content, 'CONFIG');
    expect(props).toContain('player');
    expect(props).toContain('enemy');
    // Nested properties should NOT appear at top level
    expect(props).not.toContain('width');
    expect(props).not.toContain('speed');
  });

  it('returns empty array for non-existent variable', () => {
    const content = `export const FOO = { bar: 1 };`;
    expect(extractObjectPropertyNames(content, 'MISSING')).toEqual([]);
  });

  it('returns empty for non-object assignments', () => {
    const content = `export const COUNT = 42;`;
    expect(extractObjectPropertyNames(content, 'COUNT')).toEqual([]);
  });

  it('ignores properties inside comments', () => {
    const content = `
export const ENEMIES = {
    // oldProp: 123,
    baseSpeed: 50,
    rows: 5
};`;
    const props = extractObjectPropertyNames(content, 'ENEMIES');
    expect(props).toContain('baseSpeed');
    expect(props).toContain('rows');
    expect(props).not.toContain('oldProp');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: cross-file API mismatch detection
// ─────────────────────────────────────────────────────────────────────────────

describe('cross-file API validation integration', () => {
  it('detects missing method calls', () => {
    // Simulate main.js calling player.getBulletRects() which doesn't exist
    const mainContent = `
import Player from './player.js';
const player = new Player(0, 0);
player.update(dt);
player.getBulletRects();
player.draw(ctx);
`;
    const playerContent = `
export default class Player {
    constructor(x, y) { this.x = x; }
    update(dt) {}
    draw(ctx) {}
    getBounds() {}
}`;

    // Extract bindings from main
    const bindings = extractImportBindings(mainContent);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.localName).toBe('Player');

    // Note: main.js uses 'player' (lowercase) not 'Player', so we need to
    // check member accesses on the actual variable name used, not the import name.
    // The import gives us Player, but the code instantiates as `const player = new Player()`
    // For direct member calls on the import itself (like static methods), we'd check 'Player'
    // The crossValidateAPIs handles this by checking member accesses on the binding localName

    // For this test, check the Player import's member accesses won't match (since code uses lowercase)
    // Let's test with direct usage instead:
    const mainDirect = `
import player from './player.js';
player.update(dt);
player.getBulletRects();
player.draw(ctx);
`;
    const directBindings = extractImportBindings(mainDirect);
    const accesses = extractMemberAccesses(mainDirect, directBindings[0]!.localName);
    expect(accesses).toEqual(expect.arrayContaining(['update', 'getBulletRects', 'draw']));

    const api = extractAPISurface(playerContent);
    expect(api.has('update')).toBe(true);
    expect(api.has('draw')).toBe(true);
    expect(api.has('getBulletRects')).toBe(false); // This is the mismatch!
    expect(api.has('getBounds')).toBe(true);
  });

  it('detects config property mismatches', () => {
    const mainContent = `
import { ENEMIES } from './config.js';
const speed = ENEMIES.baseMoveSpeed;
const rows = ENEMIES.rows;
`;
    const configContent = `
export const ENEMIES = {
    rows: 5,
    cols: 8,
    baseSpeed: 50,
    maxSpeed: 200
};`;

    const bindings = extractImportBindings(mainContent);
    const enemiesBinding = bindings.find((b) => b.localName === 'ENEMIES');
    expect(enemiesBinding).toBeDefined();

    const accesses = extractMemberAccesses(mainContent, 'ENEMIES');
    expect(accesses).toEqual(expect.arrayContaining(['baseMoveSpeed', 'rows']));

    // Check config properties
    const props = extractObjectPropertyNames(configContent, 'ENEMIES');
    expect(props).toContain('rows');
    expect(props).toContain('baseSpeed');
    expect(props).not.toContain('baseMoveSpeed'); // Mismatch!

    // Verify: 'rows' exists, 'baseMoveSpeed' doesn't
    const allAvailable = new Set([...extractAPISurface(configContent), ...props]);
    expect(allAvailable.has('rows')).toBe(true);
    expect(allAvailable.has('baseMoveSpeed')).toBe(false);
  });

  it('passes when APIs are compatible', () => {
    const mainContent = `
import Player from './player.js';
import { checkCollision } from './collision.js';
`;
    const playerContent = `
export default class Player {
    update() {}
    draw() {}
}`;
    const collisionContent = `
export function checkCollision(a, b) { return false; }
`;

    // Check Player binding — no member accesses on the class itself
    const accesses = extractMemberAccesses(mainContent, 'Player');
    expect(accesses).toEqual([]); // No Player.something() calls

    // Check collision
    const collisionAccesses = extractMemberAccesses(mainContent, 'checkCollision');
    expect(collisionAccesses).toEqual([]); // Used as a function, not obj.method
  });
});
