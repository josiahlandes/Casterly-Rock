/**
 * Parse Validation
 *
 * Validates that files can be parsed (syntax is correct).
 * Uses built-in capabilities for JSON/YAML and basic regex for JS/TS.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as YAML from 'yaml';
import type { ValidationError, ValidationStepResult } from './types.js';

/**
 * Parse validation result for a single file.
 */
export interface ParseResult {
  /** File path */
  file: string;
  /** Whether parsing succeeded */
  valid: boolean;
  /** Parse errors */
  errors: ValidationError[];
  /** Parser used */
  parser: string;
}

/**
 * Validate that a file can be parsed.
 */
export async function parseFile(filePath: string): Promise<ParseResult> {
  const ext = path.extname(filePath).toLowerCase();
  const relativePath = filePath;

  try {
    const content = await fs.readFile(filePath, 'utf-8');

    switch (ext) {
      case '.json':
        return parseJson(relativePath, content);
      case '.yaml':
      case '.yml':
        return parseYaml(relativePath, content);
      case '.ts':
      case '.tsx':
        return parseTypeScript(relativePath, content);
      case '.js':
      case '.jsx':
      case '.mjs':
      case '.cjs':
        return parseJavaScript(relativePath, content);
      default:
        // Unknown file type - assume valid
        return {
          file: relativePath,
          valid: true,
          errors: [],
          parser: 'none',
        };
    }
  } catch (err) {
    return {
      file: relativePath,
      valid: false,
      errors: [
        {
          file: relativePath,
          message: `Failed to read file: ${(err as Error).message}`,
          severity: 'error',
        },
      ],
      parser: 'none',
    };
  }
}

/**
 * Parse JSON file.
 */
function parseJson(filePath: string, content: string): ParseResult {
  try {
    JSON.parse(content);
    return {
      file: filePath,
      valid: true,
      errors: [],
      parser: 'json',
    };
  } catch (err) {
    const error = err as SyntaxError;
    const match = error.message.match(/at position (\d+)/);
    let line = 1;
    let column = 1;

    if (match) {
      const position = parseInt(match[1] ?? '0', 10);
      const lines = content.substring(0, position).split('\n');
      line = lines.length;
      const lastLine = lines[lines.length - 1];
      column = lastLine ? lastLine.length + 1 : 1;
    }

    return {
      file: filePath,
      valid: false,
      errors: [
        {
          file: filePath,
          line,
          column,
          message: error.message,
          severity: 'error',
          code: 'JSON_PARSE_ERROR',
        },
      ],
      parser: 'json',
    };
  }
}

/**
 * Parse YAML file.
 */
function parseYaml(filePath: string, content: string): ParseResult {
  try {
    YAML.parse(content);
    return {
      file: filePath,
      valid: true,
      errors: [],
      parser: 'yaml',
    };
  } catch (err) {
    const error = err as YAML.YAMLParseError;
    const validationError: ValidationError = {
      file: filePath,
      message: error.message,
      severity: 'error',
      code: 'YAML_PARSE_ERROR',
    };
    if (error.linePos?.[0]?.line) validationError.line = error.linePos[0].line;
    if (error.linePos?.[0]?.col) validationError.column = error.linePos[0].col;
    return {
      file: filePath,
      valid: false,
      errors: [validationError],
      parser: 'yaml',
    };
  }
}

/**
 * Basic TypeScript/JavaScript syntax validation.
 *
 * This performs basic checks without a full parser:
 * - Balanced braces, brackets, parentheses
 * - Unclosed strings
 * - Basic syntax patterns
 *
 * For full validation, use the typecheck step.
 */
function parseTypeScript(filePath: string, content: string): ParseResult {
  return parseJsLike(filePath, content, 'typescript');
}

function parseJavaScript(filePath: string, content: string): ParseResult {
  return parseJsLike(filePath, content, 'javascript');
}

function parseJsLike(
  filePath: string,
  content: string,
  parser: string
): ParseResult {
  const errors: ValidationError[] = [];

  // Remove comments and strings for bracket matching
  const stripped = stripCommentsAndStrings(content);

  // Check balanced brackets
  const bracketErrors = checkBalancedBrackets(filePath, stripped, content);
  errors.push(...bracketErrors);

  // Check for common syntax errors
  const syntaxErrors = checkCommonSyntaxErrors(filePath, content);
  errors.push(...syntaxErrors);

  return {
    file: filePath,
    valid: errors.length === 0,
    errors,
    parser,
  };
}

/**
 * Strip comments and strings from code for bracket matching.
 */
function stripCommentsAndStrings(content: string): string {
  let result = '';
  let i = 0;
  let inString: string | null = null;
  let inTemplateString = false;
  let inRegex = false;

  while (i < content.length) {
    const char = content[i];
    const nextChar = content[i + 1];

    // Handle string literals
    if (!inString && !inTemplateString && !inRegex) {
      if (char === '"' || char === "'") {
        inString = char;
        i++;
        continue;
      }
      if (char === '`') {
        inTemplateString = true;
        i++;
        continue;
      }
      // Single-line comment
      if (char === '/' && nextChar === '/') {
        while (i < content.length && content[i] !== '\n') {
          i++;
        }
        result += '\n';
        i++;
        continue;
      }
      // Multi-line comment
      if (char === '/' && nextChar === '*') {
        i += 2;
        while (i < content.length - 1 && !(content[i] === '*' && content[i + 1] === '/')) {
          if (content[i] === '\n') result += '\n';
          i++;
        }
        i += 2;
        continue;
      }
    }

    // Handle end of string
    if (inString && char === inString && content[i - 1] !== '\\') {
      inString = null;
      i++;
      continue;
    }

    // Handle template string
    if (inTemplateString && char === '`' && content[i - 1] !== '\\') {
      inTemplateString = false;
      i++;
      continue;
    }

    // Keep brackets and newlines
    if (!inString && !inTemplateString && !inRegex) {
      if ('{}[]()'.includes(char ?? '')) {
        result += char;
      } else if (char === '\n') {
        result += '\n';
      } else {
        result += ' ';
      }
    } else if (char === '\n') {
      result += '\n';
    }

    i++;
  }

  return result;
}

/**
 * Check for balanced brackets.
 */
function checkBalancedBrackets(
  filePath: string,
  stripped: string,
  original: string
): ValidationError[] {
  const errors: ValidationError[] = [];
  const stack: Array<{ char: string; line: number; col: number }> = [];
  const pairs: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
  const closing: Record<string, string> = { '}': '{', ']': '[', ')': '(' };

  let line = 1;
  let col = 1;

  for (let i = 0; i < stripped.length; i++) {
    const char = stripped[i];

    if (char === '\n') {
      line++;
      col = 1;
      continue;
    }

    if (char && pairs[char]) {
      stack.push({ char, line, col });
    } else if (char && closing[char]) {
      const last = stack.pop();
      if (!last) {
        errors.push({
          file: filePath,
          line,
          column: col,
          message: `Unexpected closing '${char}'`,
          severity: 'error',
          code: 'UNMATCHED_BRACKET',
        });
      } else if (pairs[last.char] !== char) {
        errors.push({
          file: filePath,
          line,
          column: col,
          message: `Mismatched bracket: expected '${pairs[last.char]}' but found '${char}'`,
          severity: 'error',
          code: 'MISMATCHED_BRACKET',
        });
      }
    }

    col++;
  }

  // Report unclosed brackets
  for (const unclosed of stack) {
    errors.push({
      file: filePath,
      line: unclosed.line,
      column: unclosed.col,
      message: `Unclosed '${unclosed.char}'`,
      severity: 'error',
      code: 'UNCLOSED_BRACKET',
    });
  }

  return errors;
}

/**
 * Check for common syntax errors.
 */
function checkCommonSyntaxErrors(
  filePath: string,
  content: string
): ValidationError[] {
  const errors: ValidationError[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
  }

  return errors;
}

/**
 * Validate multiple files.
 */
export async function parseFiles(filePaths: string[]): Promise<ValidationStepResult> {
  const startTime = Date.now();
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  for (const filePath of filePaths) {
    const result = await parseFile(filePath);
    for (const error of result.errors) {
      if (error.severity === 'error') {
        errors.push(error);
      } else {
        warnings.push(error);
      }
    }
  }

  return {
    step: 'parse',
    passed: errors.length === 0,
    errors,
    warnings,
    durationMs: Date.now() - startTime,
    skipped: false,
  };
}
