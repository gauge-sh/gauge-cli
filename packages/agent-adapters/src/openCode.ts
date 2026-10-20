type JsonRecord = Record<string, unknown>;

import type {
  AgentEvent,
  AgentQuestion,
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

function eventProperties(parsed: unknown): JsonRecord | undefined {
  return isRecord(parsed) && isRecord(parsed.properties)
    ? parsed.properties
    : undefined;
}

function partFromEvent(parsed: unknown): JsonRecord | undefined {
  const properties = eventProperties(parsed);
  return properties && isRecord(properties.part) ? properties.part : undefined;
}

export function openCodeQuestion(
  parsed: unknown,
  sessionId: string,
): AgentEvent["question"] {
  if (!isRecord(parsed) || parsed.type !== "question.asked") return undefined;
  const p = eventProperties(parsed);
  if (
    !p ||
    p.sessionID !== sessionId ||
    typeof p.id !== "string" ||
    !p.id.startsWith("que") ||
    !Array.isArray(p.questions) ||
    p.questions.length === 0
  ) {
    throw new Error("OpenCode received an invalid question request");
  }
  const questions: AgentQuestion[] = p.questions.map((q: unknown) => {
    if (
      !isRecord(q) ||
      typeof q.question !== "string" ||
      typeof q.header !== "string" ||
      !Array.isArray(q.options) ||
      q.options.some(
        (o: unknown) =>
          !isRecord(o) ||
          typeof o.label !== "string" ||
          typeof o.description !== "string",
      ) ||
      (q.multiple !== undefined && typeof q.multiple !== "boolean") ||
      (q.custom !== undefined && typeof q.custom !== "boolean")
    ) {
      throw new Error("OpenCode received malformed question options");
    }
    return q as unknown as AgentQuestion;
  });
  return { id: p.id, questions };
}

function toolKind(name: string): ToolKind {
  if (name === "read" || name === "glob" || name === "grep" || name === "list")
    return "file_read";
  if (name === "write" || name === "edit") return "file_edit";
  if (name === "webfetch" || name === "websearch") return "web";
  return "shell";
}

export function classifyOpenCodeEvent(parsed: unknown): AgentEvent["kind"] {
  if (!isRecord(parsed)) return "other";
  if (parsed.type === "message.updated") return "system";
  if (parsed.type !== "message.part.updated") return "other";
  const part = partFromEvent(parsed);
  switch (part?.type) {
    case "text":
      return "assistant";
    case "reasoning":
      return "reasoning";
    case "tool": {
      const state = isRecord(part.state) ? part.state : undefined;
      return state?.status === "completed" || state?.status === "error"
        ? "tool_result"
        : "tool_call";
    }
    case "step-finish":
      return "result";
    default:
      return "other";
  }
}

export function normalizeOpenCodeEvent(
  event: AgentEvent,
  observedRunningToolIds?: Set<string>,
): NormalizedPayload[] {
  if (!isRecord(event.parsed)) return [];
  const parsed = event.parsed;
  if (parsed.type === "message.updated") {
    const properties = eventProperties(parsed);
    const info =
      properties && isRecord(properties.info) ? properties.info : null;
    if (info && isRecord(info.error)) {
      return [
        {
          type: "harness_action",
          action: "agent_transport_error",
          message:
            stringAt(info.error, "message") ??
            stringAt(info.error, "name") ??
            "OpenCode assistant error",
        },
      ];
    }
    return [];
  }
  if (parsed.type === "session.error") {
    const properties = eventProperties(parsed);
    return [
      {
        type: "harness_action",
        action: "agent_transport_error",
        message: properties
          ? JSON.stringify(properties)
          : "OpenCode session error",
      },
    ];
  }
  if (parsed.type !== "message.part.updated") return [];
  const part = partFromEvent(parsed);
  if (!part) return [];
  if (part.type === "text") {
    const time = isRecord(part.time) ? part.time : undefined;
    const text = stringAt(part, "text") ?? "";
    if (!text || !time || numberAt(time, "end") === undefined) return [];
    const out: NormalizedPayload[] = [{ type: "agent_message", text }];
    return out;
  }
  if (part.type === "reasoning") {
    const time = isRecord(part.time) ? part.time : undefined;
    const text = stringAt(part, "text") ?? "";
    return text && time && numberAt(time, "end") !== undefined
      ? [{ type: "reasoning", text }]
      : [];
  }
  if (part.type === "step-finish") {
    const tokens = isRecord(part.tokens) ? part.tokens : undefined;
    const cache = tokens && isRecord(tokens.cache) ? tokens.cache : undefined;
    return [
      {
        type: "usage",
        input_tokens: tokens ? numberAt(tokens, "input") : undefined,
        output_tokens: tokens ? numberAt(tokens, "output") : undefined,
        cache_read_input_tokens: cache ? numberAt(cache, "read") : undefined,
        cache_creation_input_tokens: cache
          ? numberAt(cache, "write")
          : undefined,
        cost_usd: numberAt(part, "cost"),
      },
    ];
  }
  if (part.type !== "tool") return [];
  const state = isRecord(part.state) ? part.state : undefined;
  if (!state) return [];
  const name = stringAt(part, "tool") ?? "unknown";
  const toolId = stringAt(part, "callID") ?? stringAt(part, "id") ?? "unknown";
  if (state.status === "running") {
    if (observedRunningToolIds) {
      if (observedRunningToolIds.has(toolId)) return [];
      observedRunningToolIds.add(toolId);
    } else if (state.metadata !== undefined) return [];
    const out: NormalizedPayload[] = [
      {
        type: "tool_call",
        tool_kind: toolKind(name),
        name,
        tool_id: toolId,
        input: state.input,
      },
    ];
    return out;
  }
  if (state.status === "completed" || state.status === "error") {
    const metadata = isRecord(state.metadata) ? state.metadata : undefined;
    const metadataExit = metadata ? numberAt(metadata, "exit") : undefined;
    const out: NormalizedPayload[] = [];
    out.push({
      type: "tool_result",
      tool_kind: toolKind(name),
      tool_id: toolId,
      name,
      input: state.input,
      ...(typeof state.output === "string"
        ? { outputBytes: Buffer.byteLength(state.output) }
        : {}),
      output:
        state.status === "completed"
          ? state.output
          : (stringAt(state, "error") ?? state),
      is_error:
        state.status === "error" ||
        (name === "bash" && metadata?.exit === null) ||
        (metadataExit !== undefined && metadataExit !== 0),
    });
    return out;
  }
  return [];
}
