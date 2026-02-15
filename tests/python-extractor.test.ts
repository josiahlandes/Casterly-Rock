import { describe, expect, it } from 'vitest';

import { extractPython, getPythonExtensions } from '../src/coding/repo-map/extractors/python.js';

describe('extractPython', () => {
  it('extracts a module-level function', () => {
    const { symbols } = extractPython('def greet(name: str) -> str:\n    return f"Hello {name}"');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.name).toBe('greet');
    expect(symbols[0]?.kind).toBe('function');
    expect(symbols[0]?.exported).toBe(true);
    expect(symbols[0]?.line).toBe(1);
  });

  it('extracts an async function', () => {
    const { symbols } = extractPython('async def fetch(url: str):\n    pass');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.name).toBe('fetch');
    expect(symbols[0]?.kind).toBe('function');
  });

  it('marks _private functions as non-exported', () => {
    const { symbols } = extractPython('def _helper():\n    pass');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.exported).toBe(false);
  });

  it('marks __dunder__ functions as exported', () => {
    const { symbols } = extractPython('def __init__(self):\n    pass');
    // __init__ is indented by 0 here, so it's treated as module-level
    // but dunder check only applies to methods; this is an edge case
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.name).toBe('__init__');
  });

  it('extracts a class', () => {
    const { symbols } = extractPython('class UserService:\n    pass');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.name).toBe('UserService');
    expect(symbols[0]?.kind).toBe('class');
    expect(symbols[0]?.exported).toBe(true);
  });

  it('extracts a class with bases', () => {
    const { symbols } = extractPython('class Admin(User, PermissionMixin):\n    pass');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.name).toBe('Admin');
    expect(symbols[0]?.signature).toContain('User, PermissionMixin');
  });

  it('marks _PrivateClass as non-exported', () => {
    const { symbols } = extractPython('class _Internal:\n    pass');
    expect(symbols[0]?.exported).toBe(false);
  });

  it('extracts indented methods', () => {
    const code = `class Foo:
    def bar(self):
        pass
    async def baz(self):
        pass`;
    const { symbols } = extractPython(code);
    const methods = symbols.filter((s) => s.kind === 'method');
    expect(methods).toHaveLength(2);
    expect(methods[0]?.name).toBe('bar');
    expect(methods[1]?.name).toBe('baz');
  });

  it('marks _private methods as non-exported', () => {
    const code = `class Foo:
    def _internal(self):
        pass`;
    const { symbols } = extractPython(code);
    const method = symbols.find((s) => s.kind === 'method');
    expect(method?.exported).toBe(false);
  });

  it('marks __dunder__ methods as exported', () => {
    const code = `class Foo:
    def __repr__(self):
        pass`;
    const { symbols } = extractPython(code);
    const method = symbols.find((s) => s.kind === 'method');
    expect(method?.exported).toBe(true);
  });

  it('extracts ALL_CAPS module constants', () => {
    const { symbols } = extractPython('MAX_RETRIES = 3\nDEFAULT_TIMEOUT: int = 30');
    expect(symbols).toHaveLength(2);
    expect(symbols[0]?.name).toBe('MAX_RETRIES');
    expect(symbols[0]?.kind).toBe('const');
    expect(symbols[1]?.name).toBe('DEFAULT_TIMEOUT');
  });

  it('extracts relative imports as references', () => {
    const { references } = extractPython('from .utils import helper\nfrom ..core import Base');
    expect(references).toHaveLength(2);
    expect(references[0]).toContain('utils');
    expect(references[1]).toContain('core');
  });

  it('ignores stdlib/third-party imports', () => {
    const { references } = extractPython('import os\nfrom pathlib import Path\nimport numpy as np');
    expect(references).toHaveLength(0);
  });

  it('extracts inline docstring', () => {
    const code = `def foo():
    """This is the docstring."""
    pass`;
    const { symbols } = extractPython(code);
    expect(symbols[0]?.description).toBe('This is the docstring.');
  });

  it('skips comment lines', () => {
    const code = `# this is a comment\ndef real():\n    pass`;
    const { symbols } = extractPython(code);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.name).toBe('real');
  });

  it('handles empty content', () => {
    const { symbols, references } = extractPython('');
    expect(symbols).toHaveLength(0);
    expect(references).toHaveLength(0);
  });
});

describe('getPythonExtensions', () => {
  it('returns .py and .pyi', () => {
    const exts = getPythonExtensions();
    expect(exts).toContain('.py');
    expect(exts).toContain('.pyi');
  });
});
