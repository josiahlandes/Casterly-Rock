import { describe, expect, it } from 'vitest';

import { extractGo, getGoExtensions } from '../src/coding/repo-map/extractors/go.js';

describe('extractGo', () => {
  it('extracts an exported function', () => {
    const { symbols } = extractGo('func HandleRequest(w http.ResponseWriter, r *http.Request) {');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.name).toBe('HandleRequest');
    expect(symbols[0]?.kind).toBe('function');
    expect(symbols[0]?.exported).toBe(true);
  });

  it('extracts an unexported function', () => {
    const { symbols } = extractGo('func parseArgs(s string) (int, error) {');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.name).toBe('parseArgs');
    expect(symbols[0]?.exported).toBe(false);
  });

  it('extracts a method with receiver', () => {
    const { symbols } = extractGo('func (s *Server) Start(port int) error {');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.name).toBe('Start');
    expect(symbols[0]?.kind).toBe('method');
    expect(symbols[0]?.exported).toBe(true);
  });

  it('extracts a struct', () => {
    const { symbols } = extractGo('type Config struct {');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.name).toBe('Config');
    expect(symbols[0]?.kind).toBe('class');
    expect(symbols[0]?.exported).toBe(true);
  });

  it('marks unexported struct as non-exported', () => {
    const { symbols } = extractGo('type config struct {');
    expect(symbols[0]?.exported).toBe(false);
  });

  it('extracts an interface', () => {
    const { symbols } = extractGo('type Handler interface {');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.name).toBe('Handler');
    expect(symbols[0]?.kind).toBe('interface');
    expect(symbols[0]?.exported).toBe(true);
  });

  it('extracts a const', () => {
    const { symbols } = extractGo('const MaxRetries = 5');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.name).toBe('MaxRetries');
    expect(symbols[0]?.kind).toBe('const');
    expect(symbols[0]?.exported).toBe(true);
  });

  it('extracts a var', () => {
    const { symbols } = extractGo('var defaultTimeout = 30');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.name).toBe('defaultTimeout');
    expect(symbols[0]?.exported).toBe(false);
  });

  it('extracts single import', () => {
    const { references } = extractGo('import "fmt"');
    expect(references).toContain('fmt');
  });

  it('extracts block imports', () => {
    const code = `import (
    "fmt"
    "os"
    log "github.com/sirupsen/logrus"
)`;
    const { references } = extractGo(code);
    expect(references).toContain('fmt');
    expect(references).toContain('os');
    expect(references).toContain('github.com/sirupsen/logrus');
  });

  it('extracts preceding comment as description', () => {
    const code = `// NewServer creates a new server instance.
func NewServer(port int) *Server {`;
    const { symbols } = extractGo(code);
    expect(symbols[0]?.description).toBe('NewServer creates a new server instance.');
  });

  it('skips comment-only lines', () => {
    const code = `// just a comment\n// another\nfunc Real() {}`;
    const { symbols } = extractGo(code);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.name).toBe('Real');
  });

  it('handles empty content', () => {
    const { symbols, references } = extractGo('');
    expect(symbols).toHaveLength(0);
    expect(references).toHaveLength(0);
  });

  it('handles multiple declarations', () => {
    const code = `func Foo() {}
type Bar struct {}
func (b *Bar) Baz() {}
const Version = "1.0"`;
    const { symbols } = extractGo(code);
    expect(symbols).toHaveLength(4);
    expect(symbols.map((s) => s.name)).toEqual(['Foo', 'Bar', 'Baz', 'Version']);
  });
});

describe('getGoExtensions', () => {
  it('returns .go', () => {
    expect(getGoExtensions()).toContain('.go');
  });
});
