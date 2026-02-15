/**
 * Edit File Executor
 *
 * Bridges the coding module's editFile to the NativeToolExecutor pattern.
 * Provides search/replace editing with diff preview.
 */

import { safeLogger } from '../../logging/safe-logger.js';
import { editFile } from '../../coding/tools/edit.js';
import type { NativeToolCall, NativeToolResult, NativeToolExecutor } from '../schemas/types.js';

interface EditFileInput {
  path: string;
  search: string;
  replace: string;
  replaceAll?: boolean;
}

export function createEditFileExecutor(): NativeToolExecutor {
  return {
    toolName: 'edit_file',

    async execute(call: NativeToolCall): Promise<NativeToolResult> {
      const { path: filePath, search, replace, replaceAll } = call.input as unknown as EditFileInput;

      if (typeof filePath !== 'string' || filePath.trim() === '') {
        return {
          toolCallId: call.id,
          success: false,
          error: 'Invalid input: path must be a non-empty string',
        };
      }

      if (typeof search !== 'string' || search === '') {
        return {
          toolCallId: call.id,
          success: false,
          error: 'Invalid input: search must be a non-empty string',
        };
      }

      try {
        const result = await editFile({
          path: filePath,
          search,
          replace: typeof replace === 'string' ? replace : '',
          replaceAll: replaceAll ?? false,
        });

        if (!result.success) {
          return {
            toolCallId: call.id,
            success: false,
            error: result.error ?? 'Edit failed',
          };
        }

        const output = JSON.stringify({
          path: result.path,
          matchCount: result.matchCount,
          replacementsMade: result.replacementsMade,
          preview: result.preview?.substring(0, 2000),
        });

        safeLogger.info('edit_file executed', {
          path: filePath.substring(0, 80),
          matchCount: result.matchCount,
          replacementsMade: result.replacementsMade,
        });

        return {
          toolCallId: call.id,
          success: true,
          output,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          toolCallId: call.id,
          success: false,
          error: `Edit failed: ${message}`,
        };
      }
    },
  };
}
