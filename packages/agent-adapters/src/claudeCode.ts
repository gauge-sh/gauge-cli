import type { AgentEvent } from "./types.js";


function get(obj: unknown, key: string): unknown {
  if (typeof obj === "object" && obj !== null && key in obj) {
    return (obj as Record<string, unknown>)[key];
  }
  return undefined;
}

function hasToolUse(parsed: unknown): boolean {
  const content = get(get(parsed, "message"), "content");
  if (!Array.isArray(content)) return false;
  return content.some((block) => get(block, "type") === "tool_use");
}

export function isThinkingOnlyAssistant(parsed: unknown): boolean {
  if (get(parsed, "type") !== "assistant") return false;
  const content = get(get(parsed, "message"), "content");
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((block) => get(block, "type") === "thinking");
}

function hasToolResult(parsed: unknown): boolean {
  const content = get(get(parsed, "message"), "content");
  if (!Array.isArray(content)) return false;
  return content.some((block) => get(block, "type") === "tool_result");
}

export interface ClaudeResultVerdict {
  isError: boolean;
  terminalReason?: string;
  message?: string;
}

export function parseResultVerdict(
  parsed: unknown,
): ClaudeResultVerdict | undefined {
  if (get(parsed, "type") !== "result") return undefined;
  const terminalReason = get(parsed, "terminal_reason");
  const message = get(parsed, "result");
  return {
    isError: get(parsed, "is_error") === true,
    ...(typeof terminalReason === "string" && terminalReason.length > 0
      ? { terminalReason }
      : {}),
    ...(typeof message === "string" && message.length > 0 ? { message } : {}),
  };
}

export function formatResultVerdict(
  verdict: ClaudeResultVerdict | undefined,
): string | undefined {
  if (!verdict?.isError) return undefined;
  const parts: string[] = [];
  if (verdict.terminalReason)
    parts.push(`terminal_reason=${verdict.terminalReason}`);
  if (verdict.message) parts.push(verdict.message);
  return parts.length > 0 ? parts.join(": ") : undefined;
}

export function classifyClaudeEvent(parsed: unknown): AgentEvent["kind"] {
  switch (get(parsed, "type")) {
    case "system":
      return "system";
    case "assistant":
      return hasToolUse(parsed) ? "tool_call" : "assistant";
    case "user":
      return hasToolResult(parsed) ? "tool_result" : "other";
    case "result":
      return "result";
    default:
      return "other";
  }
}
