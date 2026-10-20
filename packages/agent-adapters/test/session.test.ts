import { describe, expect, it } from "vitest";
import {
  type AgentKind,
  NativeSession,
  type NativeSessionSnapshot,
} from "../src/index.js";

const at = "2026-10-14T23:00:00.000Z";
const observe = (session: NativeSession, record: object) =>
  session.observe(JSON.stringify(record), at);
const part = (sessionID: string, value: object) => ({
  type: "message.part.updated",
  properties: { sessionID, part: value },
});
const busy = {
  type: "session.status",
  properties: { sessionID: "root", status: { type: "busy" } },
};
const idle = { type: "session.idle", properties: { sessionID: "root" } };
const assistant = (id: string, sessionID = "root") => ({
  type: "message.updated",
  properties: {
    sessionID,
    info: { id, role: "assistant", providerID: "provider", modelID: "model" },
  },
});
const finished = (messageID: string, sessionID = "root") =>
  part(sessionID, { type: "step-finish", messageID, reason: "stop" });

describe("in-memory native consumer", () => {
  it.each(["claude-code", "codex", "pi", "opencode"] satisfies AgentKind[])(
    "observes two %s turns across JSON snapshot restoration",
    (agent) => {
      let session = new NativeSession(agent, "root");
      for (let turn = 1; turn <= 2; turn++) {
        expect(session.snapshot().projection.turn.number).toBe(turn);
        expect(() => session.beginTurn()).toThrow("current turn is active");
        let records: object[];
        switch (agent) {
          case "claude-code":
            records = [{ type: "result", is_error: false, result: "done" }];
            break;
          case "codex":
            records = [
              {
                type: "turn.completed",
                usage: { input_tokens: 5, output_tokens: 2 },
              },
            ];
            break;
          case "pi":
            records = [
              {
                type: "message_end",
                message: {
                  role: "assistant",
                  provider: "any-provider",
                  model: "any-model",
                  stopReason: "stop",
                },
              },
              { type: "agent_settled" },
            ];
            break;
          case "opencode":
            records = [
              busy,
              assistant(`message-${turn}`),
              finished(`message-${turn}`),
              idle,
            ];
            break;
          default:
            throw new Error("unexpected agent");
        }
        const results = records.map((record) => observe(session, record));
        expect(results.filter((result) => result.terminal)).toHaveLength(1);
        expect(results.at(-1)?.terminal?.status).toBe("complete");
        session = NativeSession.restore(
          JSON.parse(JSON.stringify(session.snapshot())),
        );
        expect(session.snapshot().projection.sessionId).toBe("root");
        if (turn === 1) session.beginTurn();
      }
    },
  );

  it("retains descendant correlations and running-tool deduplication across restore and turns", () => {
    let session = new NativeSession("opencode", "root");
    observe(session, {
      type: "session.created",
      properties: { info: { id: "child", parentID: "root" } },
    });
    observe(session, {
      type: "session.created",
      properties: { info: { id: "grandchild", parentID: "child" } },
    });
    const running = (output: string) =>
      part("grandchild", {
        id: "part-1",
        type: "tool",
        tool: "bash",
        callID: "call-1",
        state: {
          status: "running",
          input: { command: "echo ok" },
          output,
          metadata: {},
        },
      });
    const first = observe(session, running("first"));
    expect(first.event.progress).toBe(true);
    expect(first.payloads.filter((p) => p.type === "tool_call")).toHaveLength(
      1,
    );
    session = NativeSession.restore(
      JSON.parse(JSON.stringify(session.snapshot())),
    );
    const repeated = observe(session, running("first"));
    expect(repeated.event.progress).toBeUndefined();
    expect(repeated.payloads).toEqual([]);
    const progress = observe(session, running("second"));
    expect(progress.event.progress).toBe(true);
    expect(progress.payloads).toEqual([]);
    expect(
      observe(session, assistant("child-message", "grandchild")).identity,
    ).toBeUndefined();
    observe(session, finished("child-message", "grandchild"));
    expect(
      observe(session, {
        type: "session.idle",
        properties: { sessionID: "grandchild" },
      }).terminal,
    ).toBeUndefined();
    for (const record of [
      busy,
      assistant("root-message"),
      finished("root-message"),
      idle,
    ])
      observe(session, record);
    session.beginTurn();
    expect(observe(session, idle).terminal).toBeUndefined();
    expect(observe(session, running("second")).payloads).toEqual([]);
    expect(session.snapshot().projection.turn).toEqual({
      number: 2,
      phase: "awaiting_completion",
    });
    expect(session.snapshot().correlations.sessionParents).toEqual({
      child: "root",
      grandchild: "child",
    });
  });

  it("surfaces descendant questions without finishing the turn", () => {
    const session = new NativeSession("opencode", "root");
    observe(session, {
      type: "session.created",
      properties: { info: { id: "child", parentID: "root" } },
    });
    const question = observe(session, {
      type: "question.asked",
      properties: {
        id: "que-1",
        sessionID: "child",
        questions: [
          {
            header: "Choice",
            question: "Which?",
            options: [{ label: "A", description: "Use A" }],
          },
        ],
      },
    });
    expect(question.event.question?.id).toBe("que-1");
    expect(question.terminal).toBeUndefined();
    expect(() => session.beginTurn()).toThrow();
    expect(() =>
      observe(session, {
        type: "question.asked",
        properties: { id: "bad", sessionID: "child" },
      }),
    ).toThrow("invalid question");
  });

  it("ignores evidence from unrelated OpenCode sessions", () => {
    expect(() => new NativeSession("opencode")).toThrow("root session ID");
    const session = new NativeSession("opencode", "root");
    const result = observe(
      session,
      part("unrelated", {
        id: "foreign-part",
        type: "tool",
        tool: "bash",
        callID: "foreign-call",
        state: { status: "running", input: { command: "echo foreign" } },
      }),
    );
    expect(result.payloads).toEqual([]);
    expect(result.facts).toEqual([]);
    expect(result.event.progress).toBeUndefined();
    expect(result.terminal).toBeUndefined();
  });

  it("does not leak mutable state through results, snapshots or restore inputs", () => {
    const session = new NativeSession("codex");
    const result = observe(session, {
      type: "thread.started",
      thread_id: "thread",
    });
    result.state.sessionId = "tampered";
    const snapshot = session.snapshot();
    const restored = NativeSession.restore(snapshot);
    snapshot.projection.sessionId = "tampered";
    expect(session.snapshot().projection.sessionId).toBe("thread");
    expect(restored.snapshot().projection.sessionId).toBe("thread");
    expect(() =>
      NativeSession.restore({
        ...snapshot,
        version: 2,
      } as unknown as NativeSessionSnapshot),
    ).toThrow("snapshot version");
  });

  it("preserves native failure and permits an explicitly requested next turn", () => {
    const session = new NativeSession("codex", "thread");
    const result = observe(session, {
      type: "turn.failed",
      error: { message: "native failure" },
    });
    expect(result.terminal).toEqual({
      status: "failed",
      reason: "native failure",
    });
    session.beginTurn();
    expect(session.snapshot().projection).toMatchObject({
      sessionId: "thread",
      turn: { number: 2, phase: "awaiting_completion" },
    });
    expect(session.snapshot().projection.turn.terminalReason).toBeUndefined();
  });
});
