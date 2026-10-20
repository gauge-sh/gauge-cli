import type {
  AgentEvent,
  EvidencePayload as NormalizedPayload,
  ToolKind,
  UsagePayload,
} from "./types.js";


function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}


export function toolKind(name: string): ToolKind {
  if (name.toLowerCase().includes("mcp")) return "mcp";
  switch (name) {
    case "Bash":
    case "Shell":
      return "shell";
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
    case "Update":
      return "file_edit";
    case "Read":
    case "Glob":
    case "Grep":
    case "LS":
    case "NotebookRead":
      return "file_read";
    case "WebFetch":
    case "WebSearch":
      return "web";
    default:
      return "shell";
  }
}


function fromAssistant(parsed: Record<string, unknown>): NormalizedPayload[] {
  const message = parsed.message;
  if (!isRecord(message)) return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];

  const out: NormalizedPayload[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const blockType = block.type;
    if (blockType === "text") {
      if (isString(block.text)) {
        out.push({ type: "agent_message", text: block.text });
      }
    } else if (blockType === "thinking") {
      const text = isString(block.thinking)
        ? block.thinking
        : isString(block.text)
          ? block.text
          : undefined;
      if (text?.trim()) out.push({ type: "reasoning", text });
    } else if (blockType === "tool_use") {
      const name = isString(block.name) ? block.name : "";
      const kind = toolKind(name);
      out.push({
        type: "tool_call",
        tool_kind: kind,
        name,
        tool_id: isString(block.id) ? block.id : "",
        input: block.input,
      });
    }
  }
  return out;
}

function fromUser(parsed: Record<string, unknown>): NormalizedPayload[] {
  const message = parsed.message;
  if (!isRecord(message)) return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];

  const out: NormalizedPayload[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type !== "tool_result") continue;
    out.push({
      type: "tool_result",
      tool_kind: "shell",
      tool_id: isString(block.tool_use_id) ? block.tool_use_id : "",
      output: block.content,
      is_error: !!block.is_error,
    });
  }
  return out;
}

function fromResult(parsed: Record<string, unknown>): NormalizedPayload[] {
  const usage = isRecord(parsed.usage) ? parsed.usage : undefined;
  const cost = asNumber(parsed.total_cost_usd);

  const payload: UsagePayload = { type: "usage" };
  let hasAny = false;

  if (usage) {
    const input = asNumber(usage.input_tokens);
    const output = asNumber(usage.output_tokens);
    const cacheRead = asNumber(usage.cache_read_input_tokens);
    const cacheCreate = asNumber(usage.cache_creation_input_tokens);
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
    if (cacheCreate !== undefined) {
      payload.cache_creation_input_tokens = cacheCreate;
      hasAny = true;
    }
  }
  if (cost !== undefined) {
    payload.cost_usd = cost;
    hasAny = true;
  }

  return hasAny ? [payload] : [];
}


export function normalizeAgentEvent(ev: AgentEvent): NormalizedPayload[] {
  const parsed = ev.parsed;
  if (!isRecord(parsed)) return [];

  switch (parsed.type) {
    case "system":
      return [];
    case "assistant":
      return fromAssistant(parsed);
    case "user":
      return fromUser(parsed);
    case "result":
      return fromResult(parsed);
    default:
      return [];
  }
}
