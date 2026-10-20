import { createHash } from "node:crypto";
import {
  antigravityConversationId,
  antigravityResult,
  classifyAntigravityEvent,
  normalizeAntigravityEvent,
  reduceAntigravityUsage,
} from "./antigravity.js";
import {
  classifyClaudeEvent,
  formatResultVerdict,
  parseResultVerdict,
} from "./claudeCode.js";
import { normalizeAgentEvent } from "./claudeEvidence.js";
import { classifyCodexEvent, normalizeCodexEvent } from "./codex.js";
import { classifyCursorEvent, normalizeCursorEvent } from "./cursor.js";
import {
  classifyOpenCodeEvent,
  normalizeOpenCodeEvent,
  openCodeQuestion,
} from "./openCode.js";
import { classifyPiEvent, normalizePiEvent } from "./pi.js";
import type { AgentFact, AgentKind, AgentProjection } from "./state.js";
import type {
  AgentEvent,
  EvidencePayload as NormalizedPayload,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

function object(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function stringAt(value: unknown, key: string): string | undefined {
  const candidate = object(value)?.[key];
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

export interface AgentCorrelations {
  observedRunningToolIds?: readonly string[];
  sessionParents?: Readonly<Record<string, string>>;
  partFingerprints?: Readonly<Record<string, string>>;
}

export interface NativeIdentity {
  provider?: string;
  model?: string;
  sessionId?: string;
}

export interface NativeRecordInput {
  state: AgentProjection;
  raw: string;
  observedAt: string;
  correlations?: AgentCorrelations;
  rootSessionId?: string;
}

export interface TurnCompletion {
  status: "complete" | "failed";
  reason: string;
  nativeId?: string;
}

export interface NativeRecordResult {
  state: AgentProjection;
  event: AgentEvent;
  payloads: readonly NormalizedPayload[];
  facts: readonly AgentFact[];
  terminal?: TurnCompletion;
  identity?: NativeIdentity;
}

export function initialAgentProjection(
  agent: AgentKind,
  sessionId?: string,
): AgentProjection {
  return {
    version: 1,
    agent,
    ...(sessionId ? { sessionId } : {}),
    turn: { number: 1, phase: "awaiting_completion" },
  };
}

export function decodeJsonLine(raw: string): AgentEvent {
  const trimmed = raw.trim();
  if (!trimmed) return { raw, parsed: null, kind: "other" };
  try {
    return { raw, parsed: JSON.parse(trimmed), kind: "other" };
  } catch {
    return { raw, parsed: null, kind: "other" };
  }
}

function openCodeProperties(parsed: JsonRecord): JsonRecord | undefined {
  return object(parsed.properties);
}

function openCodePart(parsed: JsonRecord): JsonRecord | undefined {
  return object(openCodeProperties(parsed)?.part);
}

function openCodeSessionId(parsed: JsonRecord): string | undefined {
  const properties = openCodeProperties(parsed);
  const info = object(properties?.info);
  const part = object(properties?.part);
  return (
    stringAt(properties, "sessionID") ??
    stringAt(info, "sessionID") ??
    stringAt(part, "sessionID")
  );
}

function belongsToOpenCodeRun(
  sessionId: string | undefined,
  root: string | undefined,
  parents: Readonly<Record<string, string>>,
): boolean {
  if (!sessionId || !root) return false;
  const visited = new Set<string>();
  let current: string | undefined = sessionId;
  while (current && !visited.has(current)) {
    if (current === root) return true;
    visited.add(current);
    current = parents[current];
  }
  return false;
}

function reduceOpenCode(
  input: NativeRecordInput,
  event: AgentEvent,
): NativeRecordResult {
  const parsed = object(event.parsed);
  const returnedFacts: AgentFact[] = [];
  const parents: Record<string, string> = Object.assign(
    Object.create(null),
    input.correlations?.sessionParents,
  );
  const observed = new Set(input.correlations?.observedRunningToolIds ?? []);
  let terminal: TurnCompletion | undefined;
  let identity: NativeIdentity | undefined;
  let unrelatedSession = false;
  let state = input.state;

  if (parsed) {
    event.kind = classifyOpenCodeEvent(parsed);
    const properties = openCodeProperties(parsed);
    const info = object(properties?.info);
    if (
      (parsed.type === "session.created" ||
        parsed.type === "session.updated") &&
      info
    ) {
      const id = stringAt(info, "id");
      const parentNativeId = stringAt(info, "parentID");
      if (id && parentNativeId && parents[id] !== parentNativeId) {
        parents[id] = parentNativeId;
        returnedFacts.push({
          kind: "child_session",
          nativeId: id,
          parentNativeId,
        });
      }
    }

    const sessionId = openCodeSessionId(parsed);
    const belongs = belongsToOpenCodeRun(
      sessionId,
      input.rootSessionId ?? input.state.sessionId,
      parents,
    );
    unrelatedSession = sessionId !== undefined && !belongs;
    if (belongs && sessionId) {
      const question = openCodeQuestion(parsed, sessionId);
      if (question) {
        event.question = question;
        returnedFacts.push({
          kind: "question_observed",
          nativeId: question.id,
        });
      }
    }
    const part = openCodePart(parsed);
    if (belongs && part && typeof part.id === "string") {
      const partState = object(part.state);
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify([
            part.text,
            partState?.status,
            partState?.output,
            partState?.metadata,
          ]),
        )
        .digest("hex");
      if (input.correlations?.partFingerprints?.[part.id] !== fingerprint) {
        event.progress = true;
        returnedFacts.push({
          kind: "part_progress",
          nativeId: part.id,
          fingerprint,
          observedAt: input.observedAt,
        });
        state = {
          ...state,
          turn: { ...state.turn, lastMeaningfulProgressAt: input.observedAt },
        };
      }
    }
    if (
      belongs &&
      parsed.type === "message.part.delta" &&
      typeof properties?.delta === "string" &&
      properties.delta.length > 0
    ) {
      event.progress = true;
      state = {
        ...state,
        turn: { ...state.turn, lastMeaningfulProgressAt: input.observedAt },
      };
    }
    if (sessionId === (input.rootSessionId ?? state.sessionId)) {
      if (parsed.type === "session.error")
        terminal = {
          status: "failed",
          reason: "session.error",
          nativeId: sessionId,
        };
      if (parsed.type === "session.status") {
        const status = stringAt(object(properties?.status), "type");
        if (status === "busy")
          state = { ...state, turn: { ...state.turn, sawBusy: true } };
      }
      if (parsed.type === "message.updated") {
        const message = object(properties?.info);
        if (message?.role === "assistant") {
          const provider = stringAt(message, "providerID");
          const model = stringAt(message, "modelID");
          identity = { provider, model, sessionId };
          if (provider) state = { ...state, observedProvider: provider };
          const terminalNativeId = stringAt(message, "id");
          if (terminalNativeId)
            state = {
              ...state,
              turn: {
                ...state.turn,
                terminalNativeId,
                ...(terminalNativeId !== state.turn.terminalNativeId
                  ? {
                      sawTerminalStep: false,
                      terminalReason: undefined,
                    }
                  : {}),
              },
            };
        }
      }
      if (
        parsed.type === "message.part.updated" &&
        part?.type === "step-finish"
      ) {
        const reason = stringAt(part, "reason");
        if (reason === "length") event.turnStopReason = "length";
        if (
          reason &&
          stringAt(part, "messageID") === state.turn.terminalNativeId
        ) {
          state = {
            ...state,
            turn: {
              ...state.turn,
              sawTerminalStep: true,
              terminalReason: reason,
            },
          };
          returnedFacts.push({
            kind: "terminal_observation",
            nativeId: stringAt(part, "messageID"),
            reason,
          });
        }
      }
      const idleStatus =
        parsed.type === "session.status"
          ? stringAt(object(properties?.status), "type")
          : undefined;
      if (
        (parsed.type === "session.idle" || idleStatus === "idle") &&
        state.turn.sawBusy
      ) {
        const exactTerminal =
          state.turn.sawBusy &&
          state.turn.terminalNativeId &&
          state.turn.sawTerminalStep &&
          (state.turn.terminalReason === "stop" ||
            state.turn.terminalReason === "length");
        terminal = exactTerminal
          ? {
              status: "complete",
              reason: state.turn.terminalReason as string,
              nativeId: state.turn.terminalNativeId,
            }
          : {
              status: "failed",
              reason: "idle_without_exact_terminal_step",
              nativeId: sessionId,
            };
      }
    }
  }

  const before = new Set(observed);
  const payloads = unrelatedSession
    ? []
    : normalizeOpenCodeEvent(event, observed);
  for (const nativeId of observed) {
    if (!before.has(nativeId))
      returnedFacts.push({ kind: "tool_observed_running", nativeId });
  }
  if (terminal)
    state = {
      ...state,
      turn: {
        ...state.turn,
        phase: terminal.status === "complete" ? "complete" : "failed",
        terminalReason: terminal.reason,
      },
    };
  return {
    state,
    event,
    payloads,
    facts: returnedFacts,
    ...(identity ? { identity } : {}),
    ...(terminal ? { terminal } : {}),
  };
}

export function reduceNativeRecord(
  input: NativeRecordInput,
): NativeRecordResult {
  const event = decodeJsonLine(input.raw);
  const parsed = object(event.parsed);
  const facts: AgentFact[] = [];
  let state = input.state;
  let terminal: TurnCompletion | undefined;
  let identity: NativeIdentity | undefined;

  if (input.state.agent === "opencode") return reduceOpenCode(input, event);
  if (input.state.agent === "antigravity") {
    event.kind = classifyAntigravityEvent(parsed);
    const sessionId = antigravityConversationId(parsed);
    const recordSessionId =
      sessionId ??
      stringAt(object(parsed?.step_update), "conversation_id") ??
      stringAt(object(parsed?.result), "conversation_id");
    if (
      state.sessionId &&
      recordSessionId &&
      state.sessionId !== recordSessionId
    )
      return { state, event, payloads: [], facts };
    if (sessionId) {
      const modelSelector = stringAt(object(parsed?.init), "model");
      state = {
        ...state,
        sessionId,
        ...(modelSelector
          ? { antigravity: { ...state.antigravity, modelSelector } }
          : {}),
      };
      facts.push({ kind: "session_identity", nativeId: sessionId });
    }
    const payloads = normalizeAntigravityEvent(event);
    terminal = antigravityResult(parsed);
    if (terminal) {
      const usage = reduceAntigravityUsage(
        parsed,
        state.antigravity?.cumulativeUsage,
      );
      if (usage.payload) payloads.push(usage.payload);
      facts.push({ kind: "terminal_observation", reason: terminal.reason });
      state = {
        ...state,
        antigravity: {
          ...state.antigravity,
          cumulativeUsage: usage.cumulativeUsage,
        },
        turn: {
          ...state.turn,
          phase: terminal.status,
          terminalReason: terminal.reason,
        },
      };
    }
    return { state, event, payloads, facts, ...(terminal ? { terminal } : {}) };
  }

  if (parsed) {
    event.kind =
      input.state.agent === "claude-code"
        ? classifyClaudeEvent(parsed)
        : input.state.agent === "codex"
          ? classifyCodexEvent(parsed)
          : input.state.agent === "cursor"
            ? classifyCursorEvent(parsed)
            : classifyPiEvent(parsed);
    if (input.state.agent === "claude-code" && parsed.type === "system") {
      const sessionId = stringAt(parsed, "session_id");
      const cliVersion =
        stringAt(parsed, "claude_code_version") ??
        stringAt(parsed, "version") ??
        stringAt(parsed, "cli_version");
      const observedModel = stringAt(parsed, "model")?.replace(/\[1m\]$/, "");
      state = {
        ...state,
        ...(sessionId ? { sessionId } : {}),
        ...(cliVersion ? { cliVersion } : {}),
        ...(observedModel ? { observedModel } : {}),
      };
      if (sessionId)
        facts.push({ kind: "session_identity", nativeId: sessionId });
    } else if (
      input.state.agent === "codex" &&
      parsed.type === "thread.started"
    ) {
      const sessionId = stringAt(parsed, "thread_id");
      if (sessionId) {
        state = { ...state, sessionId };
        facts.push({ kind: "session_identity", nativeId: sessionId });
      }
    } else if (input.state.agent === "cursor" && parsed.type === "system") {
      const sessionId = stringAt(parsed, "session_id");
      const observedModel = stringAt(parsed, "model");
      state = {
        ...state,
        ...(sessionId ? { sessionId } : {}),
        ...(observedModel ? { observedModel } : {}),
      };
      if (sessionId)
        facts.push({ kind: "session_identity", nativeId: sessionId });
    }

    const noopTaskNotification =
      object(parsed.origin)?.kind === "task-notification" &&
      parsed.num_turns === 0 &&
      parsed.result === "" &&
      parsed.is_error !== true;
    if (
      input.state.agent === "claude-code" &&
      parsed.type === "result" &&
      !noopTaskNotification
    ) {
      const verdict = parseResultVerdict(parsed);
      const reason = verdict?.isError
        ? (formatResultVerdict(verdict) ??
          verdict.terminalReason ??
          stringAt(parsed, "stop_reason") ??
          "result")
        : (verdict?.terminalReason ??
          stringAt(parsed, "stop_reason") ??
          "result");
      terminal = {
        status: parsed.is_error === true ? "failed" : "complete",
        reason,
      };
      if (reason === "max_tokens" || reason === "length")
        event.turnStopReason = "length";
    } else if (input.state.agent === "codex" && parsed.type === "turn.failed") {
      terminal = {
        status: "failed",
        reason: stringAt(object(parsed.error), "message") ?? "turn.failed",
      };
    } else if (
      input.state.agent === "codex" &&
      parsed.type === "turn.completed"
    ) {
      terminal = { status: "complete", reason: "turn.completed" };
    } else if (input.state.agent === "cursor" && parsed.type === "result") {
      terminal = {
        status: parsed.is_error === true ? "failed" : "complete",
        reason: parsed.is_error === true ? "result.is_error" : "result",
      };
    } else if (input.state.agent === "pi" && parsed.type === "message_end") {
      const message = object(parsed.message);
      if (message?.role === "assistant") {
        const reason = stringAt(message, "stopReason");
        const provider = stringAt(message, "provider");
        const model = stringAt(message, "model");
        identity = { provider, model };
        if (provider) state = { ...state, observedProvider: provider };
        if (reason) {
          facts.push({ kind: "terminal_observation", reason });
          state = {
            ...state,
            turn: {
              ...state.turn,
              terminalReason: reason,
              sawTerminalStep: true,
            },
          };
        }
        if (reason === "length") event.turnStopReason = "length";
      }
    } else if (input.state.agent === "pi" && parsed.type === "agent_settled") {
      terminal = state.turn.sawTerminalStep
        ? {
            status:
              state.turn.terminalReason === "error" ||
              state.turn.terminalReason === "aborted"
                ? "failed"
                : "complete",
            reason: state.turn.terminalReason ?? "agent_settled",
          }
        : {
            status: "failed",
            reason: "agent_settled_without_terminal_assistant",
          };
    }
  }

  const payloads =
    input.state.agent === "claude-code"
      ? normalizeAgentEvent(event)
      : input.state.agent === "codex"
        ? normalizeCodexEvent(event)
        : input.state.agent === "cursor"
          ? normalizeCursorEvent(event)
          : normalizePiEvent(event);
  if (terminal) {
    facts.push({ kind: "terminal_observation", reason: terminal.reason });
    state = {
      ...state,
      turn: {
        ...state.turn,
        phase: terminal.status === "complete" ? "complete" : "failed",
        terminalReason: terminal.reason,
      },
    };
  }
  return {
    state,
    event,
    payloads,
    facts,
    ...(identity ? { identity } : {}),
    ...(terminal ? { terminal } : {}),
  };
}
