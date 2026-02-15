import { describe, expect, it } from 'vitest';

import {
  extractTypeScript,
  getTypeScriptExtensions,
} from '../src/coding/repo-map/extractors/typescript.js';

// ═══════════════════════════════════════════════════════════════════════════════
// extractTypeScript — Imports
// ═══════════════════════════════════════════════════════════════════════════════

describe('extractTypeScript — imports', () => {
  it('extracts ES6 named imports', () => {
    const content = `import { foo, bar } from './utils.js';`;
    const result = extractTypeScript(content);
    expect(result.references).toContain('utils.ts');
  });

  it('extracts ES6 default imports', () => {
    const content = `import Config from './config.js';`;
    const result = extractTypeScript(content);
    expect(result.references).toContain('config.ts');
  });

  it('extracts dynamic imports', () => {
    const content = `const mod = await import('./lazy-module.js');`;
    const result = extractTypeScript(content);
    expect(result.references).toContain('lazy-module.ts');
  });

  it('extracts require() calls', () => {
    const content = `const fs = require('./helpers');`;
    const result = extractTypeScript(content);
    expect(result.references).toContain('helpers.ts');
  });

  it('ignores non-local imports', () => {
    const content = `import { readFileSync } from 'node:fs';
import express from 'express';`;
    const result = extractTypeScript(content);
    expect(result.references).toHaveLength(0);
  });

  it('converts .js extension to .ts', () => {
    const content = `import { something } from './module.js';`;
    const result = extractTypeScript(content);
    expect(result.references).toContain('module.ts');
  });

  it('converts .jsx extension to .tsx', () => {
    const content = `import App from './App.jsx';`;
    const result = extractTypeScript(content);
    expect(result.references).toContain('App.tsx');
  });

  it('adds .ts extension when missing', () => {
    const content = `import { helper } from './utils/helper';`;
    const result = extractTypeScript(content);
    expect(result.references).toContain('utils/helper.ts');
  });

  it('deduplicates import references', () => {
    const content = `import { a } from './shared.js';
import { b } from './shared.js';`;
    const result = extractTypeScript(content);
    const sharedCount = result.references.filter((r) => r === 'shared.ts').length;
    expect(sharedCount).toBe(1);
  });

  it('strips leading ./ from paths', () => {
    const content = `import { x } from './sibling.js';`;
    const result = extractTypeScript(content);
    expect(result.references).toContain('sibling.ts');
    expect(result.references).not.toContain('./sibling.ts');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extractTypeScript — Symbols
// ═══════════════════════════════════════════════════════════════════════════════

describe('extractTypeScript — functions', () => {
  it('extracts exported function', () => {
    const content = `export function processData(input: string): string {`;
    const result = extractTypeScript(content);
    const sym = result.symbols.find((s) => s.name === 'processData');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
    expect(sym!.exported).toBe(true);
    expect(sym!.line).toBe(1);
  });

  it('extracts exported async function', () => {
    const content = `export async function fetchData(url: string): Promise<Response> {`;
    const result = extractTypeScript(content);
    const sym = result.symbols.find((s) => s.name === 'fetchData');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
    expect(sym!.exported).toBe(true);
  });

  it('extracts non-exported function', () => {
    const content = `function helperFn(x: number): number {`;
    const result = extractTypeScript(content);
    const sym = result.symbols.find((s) => s.name === 'helperFn');
    expect(sym).toBeDefined();
    expect(sym!.exported).toBe(false);
  });

  it('extracts exported arrow function', () => {
    const content = `export const transform = (data: string) => {`;
    const result = extractTypeScript(content);
    const sym = result.symbols.find((s) => s.name === 'transform');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
    expect(sym!.exported).toBe(true);
  });

  it('extracts non-exported arrow function', () => {
    const content = `const internal = (x: number) => x * 2;`;
    const result = extractTypeScript(content);
    const sym = result.symbols.find((s) => s.name === 'internal');
    expect(sym).toBeDefined();
    expect(sym!.exported).toBe(false);
  });
});

describe('extractTypeScript — classes', () => {
  it('extracts exported class', () => {
    const content = `export class UserService {`;
    const result = extractTypeScript(content);
    const sym = result.symbols.find((s) => s.name === 'UserService');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('class');
    expect(sym!.exported).toBe(true);
  });

  it('extracts class with extends', () => {
    const content = `export class AdminService extends UserService {`;
    const result = extractTypeScript(content);
    const sym = result.symbols.find((s) => s.name === 'AdminService');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('class');
    expect(sym!.signature).toContain('extends');
  });

  it('extracts abstract class', () => {
    const content = `export abstract class BaseHandler {`;
    const result = extractTypeScript(content);
    const sym = result.symbols.find((s) => s.name === 'BaseHandler');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('class');
  });

  it('extracts non-exported class', () => {
    const content = `class Internal {`;
    const result = extractTypeScript(content);
    const sym = result.symbols.find((s) => s.name === 'Internal');
    expect(sym).toBeDefined();
    expect(sym!.exported).toBe(false);
  });
});

describe('extractTypeScript — interfaces and types', () => {
  it('extracts exported interface', () => {
    const content = `export interface Config {`;
    const result = extractTypeScript(content);
    const sym = result.symbols.find((s) => s.name === 'Config');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('interface');
    expect(sym!.exported).toBe(true);
  });

  it('extracts interface with generics', () => {
    const content = `export interface Response<T> extends BaseResponse {`;
    const result = extractTypeScript(content);
    const sym = result.symbols.find((s) => s.name === 'Response');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('interface');
  });

  it('extracts type alias', () => {
    const content = `export type Status = 'active' | 'inactive';`;
    const result = extractTypeScript(content);
    const sym = result.symbols.find((s) => s.name === 'Status');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('type');
    expect(sym!.exported).toBe(true);
  });

  it('extracts non-exported type', () => {
    const content = `type Internal = string | number;`;
    const result = extractTypeScript(content);
    const sym = result.symbols.find((s) => s.name === 'Internal');
    expect(sym).toBeDefined();
    expect(sym!.exported).toBe(false);
  });
});

describe('extractTypeScript — enums and namespaces', () => {
  it('extracts exported enum', () => {
    const content = `export enum Direction {`;
    const result = extractTypeScript(content);
    const sym = result.symbols.find((s) => s.name === 'Direction');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('enum');
    expect(sym!.exported).toBe(true);
  });

  it('extracts const enum', () => {
    const content = `export const enum Color {`;
    const result = extractTypeScript(content);
    const sym = result.symbols.find((s) => s.name === 'Color');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('enum');
  });

  it('extracts exported namespace', () => {
    const content = `export namespace Utils {`;
    const result = extractTypeScript(content);
    const sym = result.symbols.find((s) => s.name === 'Utils');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('namespace');
    expect(sym!.exported).toBe(true);
  });
});

describe('extractTypeScript — constants', () => {
  it('extracts exported const', () => {
    const content = `export const MAX_SIZE: number = 100;`;
    const result = extractTypeScript(content);
    const sym = result.symbols.find((s) => s.name === 'MAX_SIZE');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('const');
    expect(sym!.exported).toBe(true);
  });

  it('extracts exported let', () => {
    const content = `export let counter = 0;`;
    const result = extractTypeScript(content);
    const sym = result.symbols.find((s) => s.name === 'counter');
    expect(sym).toBeDefined();
    expect(sym!.exported).toBe(true);
  });
});

describe('extractTypeScript — methods', () => {
  it('extracts public method', () => {
    const content = `  public async getData(id: string): Promise<Data> {`;
    const result = extractTypeScript(content);
    const sym = result.symbols.find((s) => s.name === 'getData');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('method');
    expect(sym!.exported).toBe(true); // public = exported
  });

  it('extracts private method as non-exported', () => {
    const content = `  private validate(input: string): boolean {`;
    const result = extractTypeScript(content);
    const sym = result.symbols.find((s) => s.name === 'validate');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('method');
    expect(sym!.exported).toBe(false); // private = not exported
  });
});

describe('extractTypeScript — JSDoc', () => {
  it('extracts JSDoc description for symbol', () => {
    const content = `/**
 * Process incoming data and return result.
 */
export function processData(input: string): string {`;
    const result = extractTypeScript(content);
    const sym = result.symbols.find((s) => s.name === 'processData');
    expect(sym).toBeDefined();
    expect(sym!.description).toContain('Process incoming data');
  });

  it('strips JSDoc tags from description', () => {
    const content = `/**
 * Calculate the sum.
 * @param a First number
 * @param b Second number
 * @returns The sum
 */
export function add(a: number, b: number): number {`;
    const result = extractTypeScript(content);
    const sym = result.symbols.find((s) => s.name === 'add');
    expect(sym).toBeDefined();
    expect(sym!.description).toContain('Calculate the sum');
    // Tags should be stripped
    expect(sym!.description).not.toContain('@param');
    expect(sym!.description).not.toContain('@returns');
  });

  it('omits description when no JSDoc present', () => {
    const content = `export function noDoc(): void {`;
    const result = extractTypeScript(content);
    const sym = result.symbols.find((s) => s.name === 'noDoc');
    expect(sym).toBeDefined();
    expect(sym!.description).toBeUndefined();
  });
});

describe('extractTypeScript — edge cases', () => {
  it('skips reserved words', () => {
    // "function" is a reserved word — patterns should not match reserved words as names
    const content = `const break_thing = 'nope';`;
    const result = extractTypeScript(content);
    // "break_thing" should NOT match because the arrow pattern won't match assignment to a string
    // Check that "break" itself isn't extracted if a pattern mismatches
    const reserved = result.symbols.find((s) => s.name === 'break');
    expect(reserved).toBeUndefined();
  });

  it('skips comment lines', () => {
    const content = `// export function commentedOut() {}
export function real(): void {`;
    const result = extractTypeScript(content);
    const sym = result.symbols.find((s) => s.name === 'commentedOut');
    expect(sym).toBeUndefined();

    const realSym = result.symbols.find((s) => s.name === 'real');
    expect(realSym).toBeDefined();
  });

  it('handles empty content', () => {
    const result = extractTypeScript('');
    expect(result.symbols).toEqual([]);
    expect(result.references).toEqual([]);
  });

  it('handles content with only comments', () => {
    const content = `// Just a comment
// Another comment
/* Block comment */`;
    const result = extractTypeScript(content);
    expect(result.symbols).toEqual([]);
  });

  it('extracts multiple symbols from multi-line file', () => {
    const content = `import { join } from 'node:path';
import { readFile } from './io.js';

export interface Config {
  name: string;
}

export type Status = 'ok' | 'error';

export function init(config: Config): void {
  // ...
}

export const VERSION = '1.0.0';`;

    const result = extractTypeScript(content);
    expect(result.references).toContain('io.ts');
    expect(result.symbols.length).toBeGreaterThanOrEqual(4);

    const names = result.symbols.map((s) => s.name);
    expect(names).toContain('Config');
    expect(names).toContain('Status');
    expect(names).toContain('init');
    expect(names).toContain('VERSION');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getTypeScriptExtensions
// ═══════════════════════════════════════════════════════════════════════════════

describe('getTypeScriptExtensions', () => {
  it('returns all TS/JS extensions', () => {
    const exts = getTypeScriptExtensions();
    expect(exts).toContain('.ts');
    expect(exts).toContain('.tsx');
    expect(exts).toContain('.js');
    expect(exts).toContain('.jsx');
    expect(exts).toContain('.mjs');
    expect(exts).toContain('.cjs');
    expect(exts).toHaveLength(6);
  });
});
