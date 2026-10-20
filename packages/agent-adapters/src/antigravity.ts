import type {
  AgentEvent,
  EvidencePayload as NormalizedPayload,
  ToolKind,
  UsagePayload,
} from "./types.js";
import type { AntigravityUsage } from "./state.js";


type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

export function antigravityToolKind(name: string): ToolKind {
  switch (name) {
    case "view_file":
    case "list_dir":
    case "find_by_name":
    case "grep_search":
      return "file_read";
    case "write_to_file":
    case "replace_file_content":
    case "multi_replace_file_content":
    case "sed_file":
      return "file_edit";
    case "search_web":
    case "read_url_content":
      return "web";
    case "call_mcp_tool":
      return "mcp";
    default:
      return "shell";
  }
}

function stepOf(parsed: unknown): JsonRecord | undefined {
  const value = record(parsed);
  return value?.event === "step_update" ? record(value.step_update) : undefined;
}

export function classifyAntigravityEvent(parsed: unknown): AgentEvent["kind"] {
  const value = record(parsed);
  switch (value?.event) {
    case "init":
      return "system";
    case "result":
      return "result";
    case "step_update": {
      const step = stepOf(parsed);
      if (step?.step_type === "tool")
        return step.state === "ACTIVE" ? "tool_call" : "tool_result";
      if (step?.step_type === "agent_response")
        return text(step.text_delta) ? "assistant" : "reasoning";
      return "other";
    }
    default:
      return "other";
  }
}

export function antigravityConversationId(parsed: unknown): string | undefined {
  const value = record(parsed);
  if (value?.event !== "init") return undefined;
  const id = text(value.conversation_id);
  return id && id.length > 0 ? id : undefined;
}

export function antigravityResult(
  parsed: unknown,
): { status: "complete" | "failed"; reason: string } | undefined {
  const value = record(parsed);
  if (value?.event !== "result") return undefined;
  const result = record(value.result);
  const status = text(result?.status) ?? "missing_status";
  if (status === "SUCCESS") return { status: "complete", reason: "SUCCESS" };
  const error = text(result?.error);
  return { status: "failed", reason: error ? `${status}: ${error}` : status };
}

export function reduceAntigravityUsage(
  parsed: unknown,
  previous: AntigravityUsage = {},
): { cumulativeUsage: AntigravityUsage; payload?: UsagePayload } {
  const value = record(parsed);
  const usage =
    value?.event === "result" ? record(record(value.result)?.usage) : undefined;
  const cumulativeUsage = { ...previous };
  const payload: UsagePayload = { type: "usage" };
  for (const [native, normalized] of [
    ["input_tokens", "input_tokens"],
    ["output_tokens", "output_tokens"],
    ["cache_read_tokens", "cache_read_input_tokens"],
  ] as const) {
    const current = count(usage?.[native]);
    if (current === undefined || current < (previous[native] ?? 0)) continue;
    const delta = current - (previous[native] ?? 0);
    cumulativeUsage[native] = current;
    if (delta > 0) payload[normalized] = delta;
  }
  return {
    cumulativeUsage,
    ...(Object.keys(payload).length > 1 ? { payload } : {}),
  };
}

export function normalizeAntigravityEvent(ev: AgentEvent): NormalizedPayload[] {
  const value = record(ev.parsed);
  if (!value) return [];

  if (value.event === "result") {
    const result = record(value.result);
    const out: NormalizedPayload[] = [];
    const response = text(result?.response)?.trim();
    if (response) out.push({ type: "agent_message", text: response });
    return out;
  }

  const step = stepOf(ev.parsed);
  if (step?.step_type !== "tool") return [];
  const info = record(step.tool_info);
  const name = text(step.tool_name) ?? text(info?.name) ?? "tool";
  const index = count(step.step_index);
  const toolId = index === undefined ? "" : `step-${index}`;
  const kind = antigravityToolKind(name);
  const input = record(info?.parameters) ?? {};
  if (step.state === "ACTIVE") {
    return [
      { type: "tool_call", tool_kind: kind, name, tool_id: toolId, input },
    ];
  }
  if (step.state !== "DONE" && step.state !== "ERROR") return [];
  const error = record(info?.error);
  const output = text(info?.output) ?? text(error?.message) ?? null;
  return [
    {
      type: "tool_result",
      tool_kind: kind,
      tool_id: toolId,
      output,
      is_error: step.state === "ERROR",
      name,
      input,
      ...(output === null
        ? {}
        : { outputBytes: Buffer.byteLength(output, "utf8") }),
    },
  ];
}
