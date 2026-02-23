/**
 * Tool Required Parameters
 *
 * Single source of truth for known required parameters per tool.
 * Used by both the planner (to validate LLM-generated plans before execution)
 * and the runner (to fast-fail steps with missing input).
 */

export const TOOL_REQUIRED_PARAMS: Record<string, string[]> = {
  bash: ['command'],
  read_file: ['path'],
  write_file: ['path', 'content'],
  edit_file: ['path', 'old_text', 'new_text'],
  search_files: ['query'],
  grep_files: ['pattern'],
  list_files: ['path'],
  glob_files: ['pattern'],
  read_document: ['path'],
  calendar_read: [],
  reminder_create: ['message'],
  http_get: ['url'],
  schedule_reminder: ['message'],
  send_message: ['recipient', 'text'],
};
