import { describe, expect, it } from 'vitest';

import { extractRust, getRustExtensions } from '../src/coding/repo-map/extractors/rust.js';

describe('extractRust', () => {
  it('extracts a pub function', () => {
    const { symbols } = extractRust('pub fn process(input: &str) -> Result<String, Error> {');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.name).toBe('process');
    expect(symbols[0]?.kind).toBe('function');
    expect(symbols[0]?.exported).toBe(true);
  });

  it('extracts a private function', () => {
    const { symbols } = extractRust('fn helper(x: i32) -> i32 {');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.name).toBe('helper');
    expect(symbols[0]?.exported).toBe(false);
  });

  it('extracts an async fn', () => {
    const { symbols } = extractRust('pub async fn fetch(url: &str) -> Response {');
    expect(symbols[0]?.name).toBe('fetch');
    expect(symbols[0]?.exported).toBe(true);
  });

  it('extracts pub(crate) as exported', () => {
    const { symbols } = extractRust('pub(crate) fn internal() {');
    expect(symbols[0]?.name).toBe('internal');
    expect(symbols[0]?.exported).toBe(true);
  });

  it('extracts a method (indented fn)', () => {
    const code = `    pub fn start(&self, port: u16) -> Result<(), Error> {`;
    const { symbols } = extractRust(code);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.name).toBe('start');
    expect(symbols[0]?.kind).toBe('method');
    expect(symbols[0]?.exported).toBe(true);
  });

  it('extracts a struct', () => {
    const { symbols } = extractRust('pub struct Config {');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.name).toBe('Config');
    expect(symbols[0]?.kind).toBe('class');
    expect(symbols[0]?.exported).toBe(true);
  });

  it('marks private struct as non-exported', () => {
    const { symbols } = extractRust('struct Internal {');
    expect(symbols[0]?.exported).toBe(false);
  });

  it('extracts an enum', () => {
    const { symbols } = extractRust('pub enum Status {');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.name).toBe('Status');
    expect(symbols[0]?.kind).toBe('enum');
    expect(symbols[0]?.exported).toBe(true);
  });

  it('extracts a trait', () => {
    const { symbols } = extractRust('pub trait Handler {');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.name).toBe('Handler');
    expect(symbols[0]?.kind).toBe('interface');
    expect(symbols[0]?.exported).toBe(true);
  });

  it('extracts a type alias', () => {
    const { symbols } = extractRust('pub type Result<T> = std::result::Result<T, Error>;');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.name).toBe('Result');
    expect(symbols[0]?.kind).toBe('type');
  });

  it('extracts a const', () => {
    const { symbols } = extractRust('pub const MAX_SIZE: usize = 1024;');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.name).toBe('MAX_SIZE');
    expect(symbols[0]?.kind).toBe('const');
    expect(symbols[0]?.exported).toBe(true);
  });

  it('extracts a static', () => {
    const { symbols } = extractRust('pub static GLOBAL_STATE: Mutex<State> = Mutex::new(State::new());');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.name).toBe('GLOBAL_STATE');
    expect(symbols[0]?.kind).toBe('const');
  });

  it('extracts use statements as references', () => {
    const { references } = extractRust('use crate::config::Settings;\nuse super::utils;');
    expect(references).toHaveLength(2);
    expect(references[0]).toContain('crate::config::Settings');
    expect(references[1]).toContain('super::utils');
  });

  it('extracts mod statements as references', () => {
    const { references } = extractRust('mod config;\nmod utils;');
    expect(references).toContain('config');
    expect(references).toContain('utils');
  });

  it('ignores external use statements', () => {
    const { references } = extractRust('use std::io;\nuse tokio::runtime;');
    expect(references).toHaveLength(0);
  });

  it('extracts doc comment as description', () => {
    const code = `/// Create a new instance with default settings.
pub fn new() -> Self {`;
    const { symbols } = extractRust(code);
    expect(symbols[0]?.description).toBe('Create a new instance with default settings.');
  });

  it('skips attributes before extracting doc comments', () => {
    const code = `/// Documented function.
#[inline]
pub fn fast() {}`;
    const { symbols } = extractRust(code);
    expect(symbols[0]?.description).toBe('Documented function.');
  });

  it('handles empty content', () => {
    const { symbols, references } = extractRust('');
    expect(symbols).toHaveLength(0);
    expect(references).toHaveLength(0);
  });

  it('handles a full Rust file', () => {
    const code = `use crate::error::AppError;

pub struct Server {
    port: u16,
}

impl Server {
    pub fn new(port: u16) -> Self {
        Self { port }
    }

    pub async fn run(&self) -> Result<(), AppError> {
        Ok(())
    }
}

pub trait Service {
    fn handle(&self) -> Result<(), AppError>;
}

const DEFAULT_PORT: u16 = 8080;`;
    const { symbols, references } = extractRust(code);
    expect(symbols.map((s) => s.name)).toEqual(['Server', 'new', 'run', 'Service', 'handle', 'DEFAULT_PORT']);
    expect(references).toContain('crate::error::AppError');
  });
});

describe('getRustExtensions', () => {
  it('returns .rs', () => {
    expect(getRustExtensions()).toContain('.rs');
  });
});
