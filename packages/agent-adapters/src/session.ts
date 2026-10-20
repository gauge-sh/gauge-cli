import {
  type AgentCorrelations,
  initialAgentProjection,
  type NativeRecordResult,
  reduceNativeRecord,
} from "./processor.js";
import {
  AGENT_PROTOCOL_VERSION,
  type AgentFact,
  type AgentKind,
  type AgentProjection,
} from "./state.js";

export class AgentCorrelationStore {
  private readonly running: Set<string>;
  private readonly parents: Map<string, string>;
  private readonly fingerprints: Map<string, string>;

  constructor(snapshot: AgentCorrelations = {}) {
    this.running = new Set(snapshot.observedRunningToolIds);
    this.parents = new Map(Object.entries(snapshot.sessionParents ?? {}));
    this.fingerprints = new Map(
      Object.entries(snapshot.partFingerprints ?? {}),
    );
  }

  apply(fact: AgentFact): void {
    switch (fact.kind) {
      case "tool_observed_running":
        this.running.add(fact.nativeId);
        break;
      case "child_session":
        this.parents.set(fact.nativeId, fact.parentNativeId);
        break;
      case "part_progress":
        this.fingerprints.set(fact.nativeId, fact.fingerprint);
        break;
    }
  }

  snapshot(): AgentCorrelations {
    return {
      observedRunningToolIds: [...this.running],
      sessionParents: Object.fromEntries(this.parents),
      partFingerprints: Object.fromEntries(this.fingerprints),
    };
  }
}

export interface NativeSessionSnapshot {
  version: typeof AGENT_PROTOCOL_VERSION;
  projection: AgentProjection;
  correlations: AgentCorrelations;
}

export function beginAgentTurn(state: AgentProjection): AgentProjection {
  if (state.turn.phase === "awaiting_completion")
    throw new Error(
      "Cannot begin another turn while the current turn is active",
    );
  return {
    ...state,
    turn: { number: state.turn.number + 1, phase: "awaiting_completion" },
  };
}

export class NativeSession {
  private projection: AgentProjection;
  private correlations: AgentCorrelationStore;

  constructor(agent: AgentKind, sessionId?: string) {
    if (agent === "opencode" && !sessionId)
      throw new Error("OpenCode requires its native root session ID");
    this.projection = initialAgentProjection(agent, sessionId);
    this.correlations = new AgentCorrelationStore();
  }

  static restore(snapshot: NativeSessionSnapshot): NativeSession {
    if (
      snapshot.version !== AGENT_PROTOCOL_VERSION ||
      snapshot.projection.version !== AGENT_PROTOCOL_VERSION
    )
      throw new Error("Unsupported native session snapshot version");
    const session = new NativeSession(
      snapshot.projection.agent,
      snapshot.projection.sessionId,
    );
    session.projection = structuredClone(snapshot.projection);
    session.correlations = new AgentCorrelationStore(snapshot.correlations);
    return session;
  }

  observe(raw: string, observedAt: string): NativeRecordResult {
    const result = reduceNativeRecord({
      state: this.projection,
      raw,
      observedAt,
      correlations: this.correlations.snapshot(),
    });
    this.projection = structuredClone(result.state);
    for (const fact of result.facts) this.correlations.apply(fact);
    return result;
  }

  beginTurn(): void {
    this.projection = beginAgentTurn(this.projection);
  }

  snapshot(): NativeSessionSnapshot {
    return {
      version: AGENT_PROTOCOL_VERSION,
      projection: structuredClone(this.projection),
      correlations: this.correlations.snapshot(),
    };
  }
}
