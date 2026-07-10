export type ToolTextResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function serializeStructuredContent(structuredContent: Record<string, unknown>): string {
  return JSON.stringify(structuredContent, null, 2);
}

export function textResult(structuredContent: Record<string, unknown>): ToolTextResult {
  return {
    content: [{ type: "text", text: serializeStructuredContent(structuredContent) }],
    structuredContent,
  };
}

/**
 * Structured-first response for compact analysis tools.  Keeping the text
 * content short avoids sending the same (potentially large) JSON twice while
 * retaining a useful status line for clients that render text only.
 */
export function structuredResult(summary: string, structuredContent: Record<string, unknown>): ToolTextResult {
  return {
    content: [{ type: "text", text: summary }],
    structuredContent,
  };
}

export function errorResult(errorLabel: string, error: unknown): ToolTextResult {
  return {
    content: [{ type: "text", text: `Error ${errorLabel}: ${error}` }],
    isError: true,
  };
}
