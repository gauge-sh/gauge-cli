import { describe, expect, it } from "vitest";
import { NativeSession } from "../src/index.js";
import { decodeAntigravityEvidence } from "../src/native.js";

const at = "2026-11-10T00:00:00.000Z";
const observe = (session: NativeSession, event: unknown) =>
  session.observe(JSON.stringify(event), at);
const step = (text: string, state = "ACTIVE", index = 1) => ({
  event: "step_update",
  step_update: {
    conversation_id: "conversation",
    step_index: index,
    step_type: "agent_response",
    state,
    text_delta: text,
  },
});
const result = (response: string, status = "SUCCESS") => ({
  event: "result",
  result: { conversation_id: "conversation", status, response },
});
const messages = (value: ReturnType<NativeSession["observe"]>) =>
  value.payloads.filter((p) => p.type === "agent_message");

describe("Antigravity incremental responses", () => {
  it.each([
    ["read_file", "file_read"],
    ["write_file", "file_edit"],
    ["edit_file", "file_edit"],
  ])("classifies the 1.5.x %s tool", (name, tool_kind) => {
    const session = new NativeSession("antigravity");
    expect(
      observe(session, {
        event: "step_update",
        step_update: {
          step_type: "tool",
          step_index: 1,
          state: "ACTIVE",
          tool_name: name,
        },
      }).payloads,
    ).toEqual([
      { type: "tool_call", tool_kind, tool_id: "step-1", name, input: {} },
    ]);
  });
  it("finishes analysis with a text-free DONE or a result without DONE", () => {
    for (const includeDone of [true, false]) {
      const session = new NativeSession("antigravity");
      observe(session, step("hello"));
      const completed = observe(
        session,
        includeDone ? step("", "DONE") : result("hello"),
      );
      expect(messages(completed)).toEqual([
        {
          type: "agent_message",
          text: "",
          message_id: "step-1",
          message_text: "hello",
        },
      ]);
      expect(messages(observe(session, result("hello")))).toEqual([]);
    }
  });
  it("emits fragments before completion, preserving whitespace and repeated tokens across handoff", () => {
    let session = new NativeSession("antigravity");
    expect(messages(observe(session, step("Hi ")))).toEqual([
      { type: "agent_message", message_id: "step-1", text: "Hi " },
    ]);
    session = NativeSession.restore(
      JSON.parse(JSON.stringify(session.snapshot())),
    );
    expect(messages(observe(session, step("🪐 ")))[0]?.text).toBe("🪐 ");
    expect(messages(observe(session, step("🪐 ")))[0]?.text).toBe("🪐 ");
    expect(messages(observe(session, step("\n", "DONE")))[0]?.text).toBe("\n");
    const completed = observe(session, result("Hi 🪐 🪐 \n"));
    expect(messages(completed)).toEqual([]);
    expect(completed.terminal?.status).toBe("complete");
    expect(messages(observe(session, result("Hi 🪐 🪐 \n")))).toEqual([]);
    session.beginTurn();
    expect(messages(observe(session, result("Hi 🪐 🪐 \n")))).toEqual([
      { type: "agent_message", text: "Hi 🪐 🪐" },
    ]);
  });

  it("keeps distinct responses and falls back to result text when the stream has no matching final response", () => {
    const session = new NativeSession("antigravity");
    expect(messages(observe(session, step("Working.\n", "DONE")))).toHaveLength(
      1,
    );
    expect(messages(observe(session, step("Done.\n", "DONE", 4)))).toHaveLength(
      1,
    );
    expect(messages(observe(session, result("Done.\n")))).toEqual([]);
    session.beginTurn();
    expect(
      messages(observe(session, step("Partial", "ACTIVE", 6))),
    ).toHaveLength(1);
    expect(
      messages(observe(session, result("Different final answer"))),
    ).toEqual([{ type: "agent_message", text: "Different final answer" }]);
  });

  it("preserves the recovered-error diagnostic and leaves execution failure to the process supervisor", () => {
    const session = new NativeSession("antigravity");
    observe(session, step("recovery-ok\n", "DONE"));
    const failed = observe(session, {
      event: "result",
      result: {
        status: "ERROR",
        response: "recovery-ok\n",
        error: "API error (attempt 1): synthetic transient failure",
      },
    });
    expect(messages(failed)).toEqual([]);
    expect(failed.terminal).toEqual({
      status: "complete",
      reason: "ERROR: API error (attempt 1): synthetic transient failure",
    });
    expect(failed.event.parsed).toMatchObject({ result: { status: "ERROR" } });
  });

  it("keeps foreign conversation deltas out of both text and deduplication state", () => {
    const session = new NativeSession("antigravity", "conversation");
    const foreign = step("Wrong");
    foreign.step_update.conversation_id = "foreign";
    expect(messages(observe(session, foreign))).toEqual([]);
    expect(session.snapshot().projection.antigravity?.response).toBeUndefined();
  });

  it("supports low-level decoding and rejects unknown response states", () => {
    for (const state of ["ACTIVE", "DONE"]) {
      const parsed = step(" ", state);
      expect(
        decodeAntigravityEvidence({
          raw: JSON.stringify(parsed),
          parsed,
          kind: "assistant",
        }),
      ).toEqual([{ type: "agent_message", text: " ", message_id: "step-1" }]);
    }
    const session = new NativeSession("antigravity");
    expect(messages(observe(session, step("incomplete", "ERROR")))).toEqual([]);
  });
});
