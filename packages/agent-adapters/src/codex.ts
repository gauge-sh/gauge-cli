import type { AgentEvent, EvidencePayload as NormalizedPayload } from "./types.js";


function get(obj: unknown, key: string): unknown {
  if (typeof obj === "object" && obj !== null && key in obj) {
    return (obj as Record<string, unknown>)[key];
  }
  return undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function classifyCodexEvent(parsed: unknown): AgentEvent["kind"] {
  switch (get(parsed, "type")) {
    case "thread.started":
      return "system";
    case "turn.completed":
    case "turn.failed":
      return "result";
    case "item.started":
    case "item.completed": {
      const itemType = get(get(parsed, "item"), "type");
      if (itemType === "agent_message") return "assistant";
      if (itemType === "reasoning") return "reasoning";
      if (
        itemType === "command_execution" ||
        itemType === "file_change" ||
        itemType === "mcp_tool_call" ||
        itemType === "web_search"
      ) {
        return "tool_call";
      }
      return "other";
    }
    default:
      return "other";
  }
}

function itemToolKind(itemType: string): "shell" | "file_edit" | "mcp" | "web" {
  switch (itemType) {
    case "file_change":
      return "file_edit";
    case "mcp_tool_call":
      return "mcp";
    case "web_search":
      return "web";
    default:
      return "shell";
  }
}

export function normalizeCodexEvent(ev: AgentEvent): NormalizedPayload[] {
  const parsed = ev.parsed;
  if (!isRecord(parsed)) return [];

  if (parsed.type === "error") {
    const message = asString(parsed.message);
    return message
      ? [{ type: "harness_action", action: "agent_transport_error", message }]
      : [];
  }

  if (parsed.type === "turn.completed") {
    const usage = isRecord(parsed.usage) ? parsed.usage : undefined;
    if (!usage) return [];
    const out: NormalizedPayload = { type: "usage" };
    let hasAny = false;
    const input = asNumber(usage.input_tokens);
    const output = asNumber(usage.output_tokens);
    const cacheRead = asNumber(usage.cached_input_tokens);
    if (input !== undefined) {
      out.input_tokens = input;
      hasAny = true;
    }
    if (output !== undefined) {
      out.output_tokens = output;
      hasAny = true;
    }
    if (cacheRead !== undefined) {
      out.cache_read_input_tokens = cacheRead;
      hasAny = true;
    }
    return hasAny ? [out] : [];
  }

  if (parsed.type !== "item.completed") return [];
  const item = parsed.item;
  if (!isRecord(item)) return [];
  const itemType = asString(item.type);
  const itemId = asString(item.id);

  switch (itemType) {
    case "agent_message": {
      const text = asString(item.text);
      if (!text) return [];
      const out: NormalizedPayload[] = [{ type: "agent_message", text }];
      return out;
    }
    case "reasoning": {
      const text = asString(item.text);
      return text ? [{ type: "reasoning", text }] : [];
    }
    case "command_execution": {
      const command = asString(item.command);
      const exitCode = asNumber(item.exit_code);
      const out: NormalizedPayload[] = [
        {
          type: "tool_call",
          tool_kind: "shell",
          name: "shell",
          tool_id: itemId,
          input: { command },
        },
      ];
      out.push({
        type: "tool_result",
        tool_kind: "shell",
        tool_id: itemId,
        output: item.aggregated_output,
        is_error: exitCode !== undefined && exitCode !== 0,
      });
      return out;
    }
    case "web_search": {
      const out: NormalizedPayload[] = [
        {
          type: "tool_call",
          tool_kind: itemToolKind(itemType),
          name: itemType,
          tool_id: itemId,
          input: item,
        },
      ];
      return out;
    }
    case "file_change":
    case "mcp_tool_call":
      return [
        {
          type: "tool_call",
          tool_kind: itemToolKind(itemType),
          name: itemType,
          tool_id: itemId,
          input: item,
        },
      ];
    default:
      return [];
  }
}
