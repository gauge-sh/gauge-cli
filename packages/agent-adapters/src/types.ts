export interface AgentQuestion {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiple?: boolean;
  custom?: boolean;
}

export interface AgentEvent {
  question?: { id: string; questions: AgentQuestion[] };
  progress?: boolean;
  turnStopReason?: "stop" | "length";
  raw: string;
  parsed: unknown;
  kind:
    | "system"
    | "assistant"
    | "reasoning"
    | "tool_call"
    | "tool_result"
    | "result"
    | "other";
}


export type ToolKind = "shell" | "file_edit" | "file_read" | "mcp" | "web";

export interface UsageData {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cost_usd?: number;
}

export interface AgentMessagePayload {
  type: "agent_message";
  text: string;
}

export interface ReasoningPayload {
  type: "reasoning";
  text: string;
}

export interface ToolCallPayload {
  type: "tool_call";
  tool_kind: ToolKind;
  name: string;
  tool_id: string;
  input: unknown;
}

export interface ToolResultPayload {
  type: "tool_result";
  tool_kind: ToolKind;
  tool_id: string;
  output: unknown;
  is_error: boolean;
  name?: string;
  input?: unknown;
  outputBytes?: number;
}
export interface UsagePayload extends UsageData {
  type: "usage";
}
export type EvidencePayload =
  | AgentMessagePayload
  | ReasoningPayload
  | ToolCallPayload
  | ToolResultPayload
  | UsagePayload
  | {
      type: "harness_action";
      action: "agent_transport_error";
      message: string;
    };

export interface DuplexProcess {
  stdout(): AsyncIterable<Buffer>;
  write(data: string): Promise<void>;
  closeStdin(): void;
  wait(): Promise<{ code: number | null; signal: string | null }>;
  kill(signal?: NodeJS.Signals): void;
  terminate?(signal: NodeJS.Signals, timeoutMs: number): Promise<void>;
  stderrTail(): string;
}
