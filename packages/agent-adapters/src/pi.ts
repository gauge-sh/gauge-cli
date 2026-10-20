type JsonRecord = Record<string, unknown>;

import type {
  AgentEvent,
  EvidencePayload as NormalizedPayload,
  ToolKind,
} from "./types.js";

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(record: JsonRecord, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function numberAt(record: JsonRecord, key: string): number | undefined {
  return typeof record[key] === "number" && Number.isFinite(record[key])
    ? record[key]
    : undefined;
}

function toolKind(name: string): ToolKind {
  if (name === "bash") return "shell";
  if (name === "read") return "file_read";
  if (name === "write" || name === "edit") return "file_edit";
  if (
    name === "WebSearch" ||
    name === "WebFetch" ||
    name === "web_search" ||
    name === "web_fetch" ||
    name === "websearch" ||
    name === "webfetch"
  )
    return "web";
  return "shell";
}

export function normalizePiEvent(ev: AgentEvent): NormalizedPayload[] {
  if (!isRecord(ev.parsed)) return [];
  const parsed = ev.parsed;
  const type = stringAt(parsed, "type");
  if (type === "message_update" && isRecord(parsed.assistantMessageEvent)) {
    const update = parsed.assistantMessageEvent;
    const updateType = stringAt(update, "type");
    const content = stringAt(update, "content");
    if (updateType === "thinking_end" && content)
      return [{ type: "reasoning", text: content }];
    if (updateType === "text_end" && content) {
      return [{ type: "agent_message", text: content }];
    }
    return [];
  }
  if (
    type === "message_end" &&
    isRecord(parsed.message) &&
    parsed.message.role === "assistant"
  ) {
    const out: NormalizedPayload[] = [];
    if (isRecord(parsed.message.usage)) {
      const usage = parsed.message.usage;
      const payload: NormalizedPayload = {
        type: "usage",
        input_tokens: numberAt(usage, "input"),
        output_tokens: numberAt(usage, "output"),
        cache_read_input_tokens: numberAt(usage, "cacheRead"),
        cache_creation_input_tokens: numberAt(usage, "cacheWrite"),
        cost_usd: isRecord(usage.cost)
          ? numberAt(usage.cost, "total")
          : undefined,
      };
      out.push(payload);
    }
    return out;
  }
  if (type === "tool_execution_start") {
    const name = stringAt(parsed, "toolName") ?? "unknown";
    const id = stringAt(parsed, "toolCallId") ?? "unknown";
    const out: NormalizedPayload[] = [
      {
        type: "tool_call",
        tool_kind: toolKind(name),
        name,
        tool_id: id,
        input: parsed.args,
      },
    ];
    return out;
  }
  if (type === "tool_execution_end") {
    const name = stringAt(parsed, "toolName") ?? "unknown";
    return [
      {
        type: "tool_result",
        tool_kind: toolKind(name),
        tool_id: stringAt(parsed, "toolCallId") ?? "unknown",
        output: parsed.result,
        is_error: parsed.isError === true,
      },
    ];
  }
  if (type === "auto_retry_start" || type === "auto_retry_end") {
    const message =
      stringAt(parsed, "errorMessage") ??
      stringAt(parsed, "finalError") ??
      type;
    return [
      { type: "harness_action", action: "agent_transport_error", message },
    ];
  }
  return [];
}

export function classifyPiEvent(parsed: unknown): AgentEvent["kind"] {
  if (!isRecord(parsed)) return "other";
  switch (parsed.type) {
    case "message_end":
      return "assistant";
    case "message_update":
      return isRecord(parsed.assistantMessageEvent) &&
        (parsed.assistantMessageEvent.type === "thinking_delta" ||
          parsed.assistantMessageEvent.type === "thinking_end")
        ? "reasoning"
        : "assistant";
    case "tool_execution_start":
      return "tool_call";
    case "tool_execution_end":
      return "tool_result";
    case "response":
      return "system";
    default:
      return "other";
  }
}
