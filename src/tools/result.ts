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

export function errorResult(errorLabel: string, error: unknown): ToolTextResult {
  return {
    content: [{ type: "text", text: `Error ${errorLabel}: ${error}` }],
    isError: true,
  };
}
