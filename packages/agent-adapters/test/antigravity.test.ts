import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  initialAgentProjection,
  NativeSession,
  reduceNativeRecord,
} from "../src/index.js";
import {
  classifyAntigravityEvent,
  decodeAntigravityEvidence,
  reduceAntigravityUsage,
} from "../src/native.js";

const at = "2026-10-16T00:00:00.000Z";
const observe = (session: NativeSession, record: unknown) =>
  session.observe(JSON.stringify(record), at);
const init = (id = "conversation") => ({
  event: "init",
  conversation_id: id,
  init: { model: "gemini-3.1-pro-low" },
});
const result = (usage: unknown, status = "SUCCESS") => ({
  event: "result",
  result: { conversation_id: "conversation", status, response: "done", usage },
});
const totals = (n: number) => ({
  input_tokens: n * 10,
  output_tokens: n * 2,
  cache_read_tokens: n * 3,
});
const increment = {
  type: "usage",
  input_tokens: 10,
  output_tokens: 2,
  cache_read_input_tokens: 3,
};
const usages = (value: ReturnType<NativeSession["observe"]>) =>
  value.payloads.filter((p) => p.type === "usage");

describe("Antigravity 1.3.5", () => {
  it("replays recorded tools without fabricating web content or counting step usage", () => {
    const lines = readFileSync(
      new URL("./fixtures/agy-1.3.5-stream.jsonl", import.meta.url),
      "utf8",
    )
      .trim()
      .split("\n");
    const session = new NativeSession("antigravity");
    const records = lines.map((line) => session.observe(line, at));
    expect(records.map((r) => r.event.raw)).toEqual(lines);
    expect(records[0].facts).toEqual([
      {
        kind: "session_identity",
        nativeId: "3e2b824f-d81a-491c-acd1-0152793a4fd0",
      },
    ]);
    expect(records.slice(0, -1).flatMap(usages)).toEqual([]);
    expect(records.filter((r) => r.terminal)).toHaveLength(1);
    expect(records.at(-1)?.terminal).toEqual({
      status: "complete",
      reason: "SUCCESS",
    });
    const payloads = records.flatMap((r) => r.payloads);
    const calls = payloads.filter((p) => p.type === "tool_call");
    const outputs = payloads.filter((p) => p.type === "tool_result");
    expect(calls.map((p) => [p.name, p.tool_kind, p.tool_id])).toEqual([
      ["search_web", "web", "step-2"],
      ["read_url_content", "web", "step-3"],
      ["run_command", "shell", "step-4"],
      ["view_file", "file_read", "step-5"],
      ["write_to_file", "file_edit", "step-7"],
    ]);
    expect(outputs.map((p) => p.tool_id)).toEqual(calls.map((p) => p.tool_id));
    expect(
      outputs.filter((p) => p.tool_kind === "web").map((p) => p.output),
    ).toEqual([null, null]);
    expect(outputs.find((p) => p.name === "view_file")?.output).toBe(
      "2 lines, 6 bytes",
    );
    expect(payloads.filter((p) => p.type === "agent_message")).toHaveLength(1);
    expect(payloads.filter((p) => p.type === "reasoning")).toEqual([]);
    expect(usages(records.at(-1)!)).toEqual([
      {
        type: "usage",
        input_tokens: 19348,
        output_tokens: 1157,
        cache_read_input_tokens: 27308,
      },
    ]);
  });

  it("emits usage increments across continuation, JSON restore, process resume and repeated results", () => {
    let session = new NativeSession("antigravity");
    observe(session, init());
    for (let turn = 1; turn <= 3; turn++) {
      const record = result(totals(turn));
      expect(usages(observe(session, record))).toEqual([increment]);
      expect(usages(observe(session, record))).toEqual([]);
      session = NativeSession.restore(
        JSON.parse(JSON.stringify(session.snapshot())),
      );
      expect(usages(observe(session, record))).toEqual([]);
      if (turn < 3) {
        session.beginTurn();
        observe(session, init());
        expect(
          session.snapshot().projection.antigravity?.cumulativeUsage,
        ).toEqual(totals(turn));
      }
    }
    expect(session.snapshot().projection.turn.number).toBe(3);
  });

  it("keeps the selector separate from observed provider identity", () => {
    const session = new NativeSession("antigravity");
    const value = observe(session, init());
    expect(value.identity).toBeUndefined();
    expect(value.state.observedModel).toBeUndefined();
    expect(value.state.observedProvider).toBeUndefined();
    expect(value.state.antigravity?.modelSelector).toBe("gemini-3.1-pro-low");
  });

  it("accounts for usage on errored turns and preserves it for recovery", () => {
    const session = new NativeSession("antigravity");
    observe(session, init());
    observe(session, result(totals(1)));
    session.beginTurn();
    const record = result(totals(2), "ERROR");
    const errored = observe(session, {
      ...record,
      result: { ...record.result, error: "interrupted" },
    });
    expect(errored.terminal).toEqual({
      status: "complete",
      reason: "ERROR: interrupted",
    });
    expect(errored.state.turn.terminalReason).toBe("ERROR: interrupted");
    expect(usages(errored)).toEqual([increment]);
    session.beginTurn();
    expect(usages(observe(session, result(totals(3))))).toEqual([increment]);
  });

  // Real agy 1.3.5 output against an endpoint that resets or 503s the main
  // model request. A recovered retry and a give-up both report ERROR; only the
  // process exit (0 vs 3) differs, so neither result record fails the turn.
  it.each([
    ["reset-recovered", "PROBE-OK\n"],
    ["503-recovered", "PROBE-OK\n"],
    ["reset-exhausted", ""],
    ["503-exhausted", ""],
  ])("leaves the %s verdict to the process exit", (name, response) => {
    const session = new NativeSession("antigravity");
    let last: ReturnType<NativeSession["observe"]> | undefined;
    for (const line of readFileSync(
      new URL(`fixtures/agy-1.3.5-api-error-${name}.jsonl`, import.meta.url),
      "utf8",
    )
      .split("\n")
      .filter(Boolean))
      last = session.observe(line, at);
    expect(last?.terminal?.status).toBe("complete");
    expect(last?.terminal?.reason).toMatch(/^ERROR: /);
    expect(
      last?.payloads.find((p) => p.type === "agent_message")?.text ?? "",
    ).toBe(response.trim());
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { input_tokens: "20", output_tokens: -2, cache_read_tokens: 1.5 },
  ])("preserves the baseline through missing/malformed usage %j", (usage) => {
    const session = new NativeSession("antigravity");
    observe(session, result(totals(1)));
    session.beginTurn();
    expect(usages(observe(session, result(usage)))).toEqual([]);
    expect(session.snapshot().projection.antigravity?.cumulativeUsage).toEqual(
      totals(1),
    );
    session.beginTurn();
    expect(usages(observe(session, result(totals(2))))).toEqual([increment]);
  });

  it("tracks fields independently without resetting regressing counters", () => {
    const session = new NativeSession("antigravity");
    observe(session, result(totals(1)));
    session.beginTurn();
    expect(
      usages(observe(session, result({ input_tokens: 9, output_tokens: 4 }))),
    ).toEqual([{ type: "usage", output_tokens: 2 }]);
    session.beginTurn();
    expect(usages(observe(session, result(totals(2))))).toEqual([
      { type: "usage", input_tokens: 10, cache_read_input_tokens: 3 },
    ]);
  });

  it.each([
    NaN,
    Infinity,
    -Infinity,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    "10",
    null,
  ])(
    "rejects invalid numeric counters %s without mutating the baseline",
    (invalid) => {
      const baseline = Object.freeze(totals(1));
      expect(
        reduceAntigravityUsage(
          result({
            input_tokens: invalid,
            output_tokens: invalid,
            cache_read_tokens: invalid,
          }),
          baseline,
        ),
      ).toEqual({ cumulativeUsage: totals(1) });
    },
  );

  it("handles zero totals and excludes thinking/total counters from double counting", () => {
    const session = new NativeSession("antigravity");
    expect(usages(observe(session, result(totals(0))))).toEqual([]);
    session.beginTurn();
    expect(
      usages(
        observe(
          session,
          result({ ...totals(1), thinking_tokens: 1, total_tokens: 12 }),
        ),
      ),
    ).toEqual([increment]);
  });

  it("ignores records belonging to another conversation without poisoning usage", () => {
    const session = new NativeSession("antigravity");
    observe(session, init());
    const foreignResult = result(totals(100));
    for (const record of [
      init("foreign"),
      {
        ...foreignResult,
        result: { ...foreignResult.result, conversation_id: "foreign" },
      },
      {
        event: "step_update",
        step_update: {
          conversation_id: "foreign",
          step_type: "tool",
          state: "ACTIVE",
          tool_name: "run_command",
          step_index: 1,
        },
      },
    ]) {
      const value = observe(session, record);
      expect(value.payloads).toEqual([]);
      expect(value.facts).toEqual([]);
      expect(value.terminal).toBeUndefined();
      expect(value.event.parsed).toEqual(record);
    }
    expect(session.snapshot().projection.sessionId).toBe("conversation");
    expect(usages(observe(session, result(totals(1))))).toEqual([increment]);
  });

  it("retains unknown records and fails closed on malformed terminal status", () => {
    const session = new NativeSession("antigravity");
    for (const raw of [
      "not json",
      "null",
      "[]",
      '{"event":"future"}',
      '{"type":"result"}',
    ]) {
      const value = session.observe(raw, at);
      expect(value.event.raw).toBe(raw);
      expect(value.payloads).toEqual([]);
      expect(value.terminal).toBeUndefined();
    }
    expect(observe(session, { event: "result" }).terminal).toEqual({
      status: "failed",
      reason: "missing_status",
    });
  });

  it("retains tool errors, unicode output size, and unknown tool names", () => {
    const record = {
      event: "step_update",
      step_update: {
        step_index: 42,
        step_type: "tool",
        state: "ERROR",
        tool_info: {
          name: "future_tool",
          parameters: { x: 1 },
          error: { message: "失敗" },
        },
      },
    };
    const value = observe(new NativeSession("antigravity"), record);
    expect(value.event.kind).toBe("tool_result");
    expect(value.payloads).toEqual([
      {
        type: "tool_result",
        tool_kind: "shell",
        tool_id: "step-42",
        output: "失敗",
        is_error: true,
        name: "future_tool",
        input: { x: 1 },
        outputBytes: 6,
      },
    ]);
    expect(value.terminal).toBeUndefined();
  });

  it("keeps low-level message decoding separate from cumulative usage reduction", () => {
    const parsed = result(totals(1));
    expect(classifyAntigravityEvent(parsed)).toBe("result");
    expect(
      decodeAntigravityEvidence({
        raw: JSON.stringify(parsed),
        parsed,
        kind: "result",
      }),
    ).toEqual([{ type: "agent_message", text: "done" }]);
    expect(reduceAntigravityUsage(parsed).payload).toEqual(increment);
  });

  it("reduces immutably and keeps restored baseline state independent of callers", () => {
    const state = initialAgentProjection("antigravity");
    const original = structuredClone(state);
    reduceNativeRecord({
      state,
      raw: JSON.stringify(result(totals(1))),
      observedAt: at,
    });
    expect(state).toEqual(original);
    const session = new NativeSession("antigravity");
    const value = observe(session, result(totals(1)));
    value.state.antigravity!.cumulativeUsage!.input_tokens = 900;
    const snapshot = session.snapshot();
    const restored = NativeSession.restore(snapshot);
    snapshot.projection.antigravity!.cumulativeUsage!.input_tokens = 800;
    restored.beginTurn();
    expect(usages(observe(restored, result(totals(2))))).toEqual([increment]);
  });
});
