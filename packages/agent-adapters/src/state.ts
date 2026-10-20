export const AGENT_PROTOCOL_VERSION = 1 as const;
export type AgentKind =
  | "claude-code"
  | "codex"
  | "cursor"
  | "pi"
  | "opencode"
  | "antigravity";

export interface AntigravityUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
}

export interface AgentProjection {
  version: typeof AGENT_PROTOCOL_VERSION;
  agent: AgentKind;
  sessionId?: string;
  cliVersion?: string;
  observedModel?: string;
  observedProvider?: string;
  antigravity?: {
    modelSelector?: string;
    cumulativeUsage?: AntigravityUsage;
  };
  turn: {
    number: number;
    phase: "idle" | "awaiting_completion" | "complete" | "failed";
    terminalReason?: string;
    lastMeaningfulProgressAt?: string;
    sawBusy?: boolean;
    terminalNativeId?: string;
    sawTerminalStep?: boolean;
  };
}

export type AgentFact =
  | { kind: "session_identity"; nativeId: string }
  | { kind: "child_session"; nativeId: string; parentNativeId: string }
  | { kind: "tool_observed_running"; nativeId: string }
  | { kind: "question_observed"; nativeId: string }
  | { kind: "question_answered"; nativeId: string }
  | {
      kind: "part_progress";
      nativeId: string;
      fingerprint: string;
      observedAt: string;
    }
  | { kind: "terminal_observation"; nativeId?: string; reason: string };
