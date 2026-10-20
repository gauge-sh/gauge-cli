import type {
  AgentEvent,
  EvidencePayload as NormalizedPayload,
  ToolKind,
} from "./types.js";


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

export function classifyCursorEvent(parsed: unknown): AgentEvent["kind"] {
  switch (get(parsed, "type")) {
    case "system":
      return "system";
    case "thinking":
      return "reasoning";
    case "assistant":
      return "assistant";
    case "tool_call":
      return "tool_call";
    case "result":
      return "result";
    default:
      return "other";
  }
}

function toolFromCall(call: Record<string, unknown>): {
  name: string;
  kind: ToolKind;
  inner: Record<string, unknown>;
} {
  const key = Object.keys(call)[0] ?? "";
  const inner = isRecord(call[key])
    ? (call[key] as Record<string, unknown>)
    : {};
  const base = key.replace(/ToolCall$/, "").toLowerCase();
  let kind: ToolKind;
  switch (base) {
    case "shell":
      kind = "shell";
      break;
    case "edit":
    case "write":
    case "delete":
    case "create":
      kind = "file_edit";
      break;
    case "read":
    case "ls":
    case "glob":
    case "grep":
    case "search":
      kind = "file_read";
      break;
    case "web":
    case "fetch":
      kind = "web";
      break;
    case "mcp":
      kind = "mcp";
      break;
    default:
      kind = base.includes("mcp") ? "mcp" : "shell";
  }
  return { name: key || "tool", kind, inner };
}

export function normalizeCursorEvent(ev: AgentEvent): NormalizedPayload[] {
  const parsed = ev.parsed;
  if (!isRecord(parsed)) return [];

  switch (parsed.type) {
    case "assistant": {
      const message = parsed.message;
      if (!isRecord(message) || !Array.isArray(message.content)) return [];
      const out: NormalizedPayload[] = [];
      for (const block of message.content) {
        if (isRecord(block) && block.type === "text" && isString(block.text)) {
          out.push({ type: "agent_message", text: block.text });
        }
      }
      return out;
    }

    case "tool_call": {
      const call = isRecord(parsed.tool_call) ? parsed.tool_call : undefined;
      if (!call) return [];
      const { name, kind, inner } = toolFromCall(call);
      const toolId = asString(parsed.call_id);
      const args = isRecord(inner.args) ? inner.args : {};

      if (parsed.subtype === "started") {
        const out: NormalizedPayload[] = [
          {
            type: "tool_call",
            tool_kind: kind,
            name,
            tool_id: toolId,
            input: args,
          },
        ];

        return out;
      }
      if (parsed.subtype === "completed") {
        const result = inner.result;
        const isError = isRecord(result) && "error" in result;
        return [
          {
            type: "tool_result",
            tool_kind: kind,
            tool_id: toolId,
            output: result,
            is_error: isError,
          },
        ];
      }
      return [];
    }

    case "result": {
      const usage = isRecord(parsed.usage) ? parsed.usage : undefined;
      if (!usage) return [];
      const payload: NormalizedPayload = { type: "usage" };
      let hasAny = false;
      const input = asNumber(usage.inputTokens);
      const output = asNumber(usage.outputTokens);
      const cacheRead = asNumber(usage.cacheReadTokens);
      const cacheWrite = asNumber(usage.cacheWriteTokens);
      if (input !== undefined) {
        payload.input_tokens = input;
        hasAny = true;
      }
      if (output !== undefined) {
        payload.output_tokens = output;
        hasAny = true;
      }
      if (cacheRead !== undefined) {
        payload.cache_read_input_tokens = cacheRead;
        hasAny = true;
      }
      if (cacheWrite !== undefined) {
        payload.cache_creation_input_tokens = cacheWrite;
        hasAny = true;
      }
      return hasAny ? [payload] : [];
    }

    default:
      return [];
  }
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}
