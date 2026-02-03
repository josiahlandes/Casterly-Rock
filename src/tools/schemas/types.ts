/**
 * Native Tool Use Types
 *
 * These types define the structured format for native tool calling,
 * compatible with both Anthropic Claude and Ollama APIs.
 */

/**
 * JSON Schema type for tool parameters
 */
export type JsonSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

/**
 * Property definition within a tool's input schema
 */
export interface ToolProperty {
  type: JsonSchemaType;
  description: string;
  enum?: string[];
  items?: ToolProperty;
  properties?: Record<string, ToolProperty>;
  required?: string[];
}

/**
 * Input schema for a tool (JSON Schema format)
 */
export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, ToolProperty>;
  required: string[];
}

/**
 * Tool definition that can be passed to LLM APIs
 */
export interface ToolSchema {
  /** Unique name for the tool (used by LLM to invoke it) */
  name: string;

  /** Human-readable description of what the tool does */
  description: string;

  /** JSON Schema defining the tool's input parameters */
  inputSchema: ToolInputSchema;
}

/**
 * A tool call from the LLM response
 */
export interface NativeToolCall {
  /** Unique ID for this tool call (used to match results) */
  id: string;

  /** Name of the tool being called */
  name: string;

  /** Structured input parameters */
  input: Record<string, unknown>;
}

/**
 * Result of executing a tool call
 */
export interface NativeToolResult {
  /** ID of the tool call this result is for */
  toolCallId: string;

  /** Whether the execution succeeded */
  success: boolean;

  /** Output from successful execution */
  output?: string;

  /** Error message if execution failed */
  error?: string;

  /** Exit code for command execution */
  exitCode?: number;
}

/**
 * Tool result message for multi-turn conversations
 */
export interface ToolResultMessage {
  /** ID of the tool call */
  callId: string;

  /** Result content (output or error) */
  result: string;

  /** Whether this was an error result */
  isError?: boolean;
}

/**
 * Response from generateWithTools()
 */
export interface GenerateWithToolsResponse {
  /** Text content from the response (may be empty if only tool calls) */
  text: string;

  /** Tool calls requested by the model */
  toolCalls: NativeToolCall[];

  /** Provider that generated the response */
  providerId: string;

  /** Model that generated the response */
  model: string;

  /** Why the model stopped generating */
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
}

/**
 * Executor function type for handling tool calls
 */
export type ToolExecutor = (call: NativeToolCall) => Promise<NativeToolResult>;

/**
 * Registry for tool executors
 */
export interface NativeToolExecutor {
  /** Tool name this executor handles */
  toolName: string;

  /** Execute the tool call */
  execute: ToolExecutor;
}
