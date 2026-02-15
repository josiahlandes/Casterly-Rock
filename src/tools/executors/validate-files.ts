/**
 * Validate Files Executor
 *
 * Bridges the coding module's validation pipeline to the NativeToolExecutor pattern.
 * Runs parse -> lint -> typecheck -> test stages on specified files.
 */

import { safeLogger } from '../../logging/safe-logger.js';
import { createValidationPipeline, formatValidationResult } from '../../coding/validation/pipeline.js';
import type { NativeToolCall, NativeToolResult, NativeToolExecutor } from '../schemas/types.js';

interface ValidateFilesInput {
  files: string[];
  quick?: boolean;
  skipTest?: boolean;
}

export function createValidateFilesExecutor(): NativeToolExecutor {
  return {
    toolName: 'validate_files',

    async execute(call: NativeToolCall): Promise<NativeToolResult> {
      const { files, quick = false, skipTest = false } = call.input as unknown as ValidateFilesInput;

      if (!Array.isArray(files) || files.length === 0) {
        return {
          toolCallId: call.id,
          success: false,
          error: 'Invalid input: files must be a non-empty array of file paths',
        };
      }

      // Filter to valid string paths
      const validFiles = files.filter((f): f is string => typeof f === 'string' && f.trim() !== '');
      if (validFiles.length === 0) {
        return {
          toolCallId: call.id,
          success: false,
          error: 'Invalid input: no valid file paths provided',
        };
      }

      try {
        const pipeline = createValidationPipeline({
          rootPath: process.cwd(),
          testOnEdit: !skipTest,
        });

        const result = quick
          ? await pipeline.validateQuick(validFiles)
          : await pipeline.validate(validFiles);

        const formatted = formatValidationResult(result);

        safeLogger.info('validate_files executed', {
          files: validFiles.length,
          quick,
          passed: result.success,
          steps: result.steps.map((s) => `${s.step}:${s.passed ? 'ok' : 'fail'}`).join(', '),
        });

        return {
          toolCallId: call.id,
          success: true,
          output: formatted,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          toolCallId: call.id,
          success: false,
          error: `Validation failed: ${message}`,
        };
      }
    },
  };
}
