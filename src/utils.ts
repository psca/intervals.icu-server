export function defaultDateRange(): { start: string; end: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 30);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

type ToolResult = { content: { type: "text"; text: string }[] };

export async function toolHandler(
  fn: () => Promise<string>,
  errorLabel: string,
): Promise<ToolResult> {
  try {
    const text = await fn();
    return { content: [{ type: "text", text }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Error ${errorLabel}: ${e}` }] };
  }
}
