import type { EvidencePayload } from "@withgauge/agent-adapters";
export type AgentKind = "claude-code" | "codex" | "opencode" | "pi";
export type AuthMode = "setup_token" | "api_key" | "access_token";
export type ResourceRef = {
  name: string; digest: string; filename: string;
} & (
  | { kind: "file"; use?: never }
  | { kind: "archive"; use?: { type: "files" | "skill" } | { type: "npm-package"; package: string; install: "environment" | "workspace" } }
);
export interface SessionSpec {
  agent: { kind: AgentKind; model: string };
  image: string;
  auth: { mode: AuthMode };
  workspace: { repo: string; ref: string } | null;
  resources: ResourceRef[];
  prompt: { text: string };
  limits: { turnTimeoutS: number; responseTimeoutS: number | null; maxTurns: number };
}
export interface Question { id: string; request: unknown }
export interface SessionStatus {
  state: "preparing" | "running" | "waiting" | "blocked" | "completed" | "failed" | "canceled" | "interrupted";
  turn: number;
  sessionId?: string;
  workspaceCommit?: string;
  driverPid?: number;
  cleanupPending?: boolean;
  question?: Question;
  detail?: string;
  updatedAt: string;
  artifacts?: { diff?: string; workspace?: string };
}
export interface SessionEvent { seq: number; turn: number; observedAt: string; payload: EvidencePayload }
export type SessionCommand =
  | { action: "prompt"; turn: number; text: string }
  | { action: "answer"; questionId: string; answer: unknown; turn?: number }
  | { action: "finish"; turn?: number }
  | { action: "cancel" };
export interface CommandReceipt { accepted: boolean; error?: string }
export interface LaunchRecord {
  version: 1;
  containerName: string;
  credentialDir: string;
  socketPath: string;
  spec: SessionSpec;
  credentialExpiresAt?: string;
}
export const terminal = (state: SessionStatus["state"]): boolean =>
  state === "completed" || state === "failed" || state === "canceled" || state === "interrupted";
