/**
 * Type declarations for mammoth (no @types/mammoth available)
 */

declare module 'mammoth' {
  interface MammothInput {
    buffer: Buffer;
  }

  interface MammothResult {
    value: string;
    messages: Array<{ type: string; message: string }>;
  }

  export function convertToHtml(input: MammothInput): Promise<MammothResult>;
  export function extractRawText(input: MammothInput): Promise<MammothResult>;
}
