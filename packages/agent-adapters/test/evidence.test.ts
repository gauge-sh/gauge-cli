import { describe, expect, it } from "vitest";
import { type AgentKind, NativeSession } from "../src/index.js";

const at = "2026-10-15T00:00:00.000Z";
const observe = (session: NativeSession, record: object) =>
  session.observe(JSON.stringify(record), at);

describe("portable native evidence", () => {
  it.each([
    [
      "claude-code",
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello" }] },
      },
    ],
    [
      "codex",
      {
        type: "item.completed",
        item: { type: "agent_message", id: "message", text: "Hello" },
      },
    ],
    [
      "pi",
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_end", content: "Hello" },
      },
    ],
    [
      "opencode",
      {
        type: "message.part.updated",
        properties: {
          sessionID: "root",
          part: { id: "part", type: "text", text: "Hello", time: { end: 1 } },
        },
      },
    ],
  ] satisfies [AgentKind, object][])(
    "decodes %s text without hosted context",
    (agent, record) => {
      const result = observe(new NativeSession(agent, "root"), record);
      expect(result.payloads).toEqual([
        { type: "agent_message", text: "Hello" },
      ]);
      expect(result.event.raw).toBe(JSON.stringify(record));
    },
  );

  it("retains Claude reasoning and tool calls while omitting empty thinking blocks", () => {
    const result = observe(new NativeSession("claude-code"), {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "", signature: "opaque" },
          { type: "thinking", thinking: "Inspect the file" },
          {
            type: "tool_use",
            id: "call",
            name: "Read",
            input: { file_path: "README.md" },
          },
        ],
      },
    });
    expect(result.payloads).toEqual([
      { type: "reasoning", text: "Inspect the file" },
      {
        type: "tool_call",
        tool_kind: "file_read",
        name: "Read",
        tool_id: "call",
        input: { file_path: "README.md" },
      },
    ]);
  });

  it("decodes Codex command results once and leaves pricing to the consumer", () => {
    const session = new NativeSession("codex");
    const item = {
      type: "command_execution",
      id: "call",
      command: "false",
      aggregated_output: "failed",
      exit_code: 1,
    };
    expect(observe(session, { type: "item.started", item }).payloads).toEqual(
      [],
    );
    expect(observe(session, { type: "item.completed", item }).payloads).toEqual(
      [
        {
          type: "tool_call",
          tool_kind: "shell",
          name: "shell",
          tool_id: "call",
          input: { command: "false" },
        },
        {
          type: "tool_result",
          tool_kind: "shell",
          tool_id: "call",
          output: "failed",
          is_error: true,
        },
      ],
    );
    expect(
      observe(session, {
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 2 },
      }).payloads,
    ).toEqual([{ type: "usage", input_tokens: 10, output_tokens: 2 }]);
  });

  it("keeps Pi native usage and identity without duplicating cumulative text", () => {
    const session = new NativeSession("pi");
    observe(session, {
      type: "message_update",
      assistantMessageEvent: { type: "text_end", content: "Hello" },
    });
    const result = observe(session, {
      type: "message_end",
      message: {
        role: "assistant",
        provider: "provider",
        model: "model",
        stopReason: "stop",
        content: [{ type: "text", text: "Hello" }],
        usage: {
          input: 10,
          output: 2,
          cacheRead: 3,
          cacheWrite: 4,
          cost: { total: 0.01 },
        },
      },
    });
    expect(result.payloads).toEqual([
      {
        type: "usage",
        input_tokens: 10,
        output_tokens: 2,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 4,
        cost_usd: 0.01,
      },
    ]);
    expect(result.identity).toMatchObject({
      provider: "provider",
      model: "model",
    });
    expect(result.terminal).toBeUndefined();
    expect(observe(session, { type: "agent_settled" }).terminal?.status).toBe(
      "complete",
    );
  });

  it("retains OpenCode error output and the native byte count for consumer enrichment", () => {
    const result = observe(new NativeSession("opencode", "root"), {
      type: "message.part.updated",
      properties: {
        sessionID: "root",
        part: {
          id: "part",
          type: "tool",
          tool: "bash",
          callID: "call",
          state: {
            status: "error",
            input: { command: "false" },
            output: "é",
            error: "failed",
          },
        },
      },
    });
    expect(result.payloads).toEqual([
      {
        type: "tool_result",
        tool_kind: "shell",
        tool_id: "call",
        name: "bash",
        input: { command: "false" },
        output: "failed",
        outputBytes: 2,
        is_error: true,
      },
    ]);
  });

  it.each(["claude-code", "codex", "pi", "opencode"] satisfies AgentKind[])(
    "retains unknown/malformed %s records without inventing evidence",
    (agent) => {
      const session = new NativeSession(agent, "root");
      for (const raw of [
        "not JSON",
        '{"type":"new_native_event","newField":42}',
      ]) {
        const result = session.observe(raw, at);
        expect(result.event.raw).toBe(raw);
        expect(result.payloads).toEqual([]);
        expect(result.terminal).toBeUndefined();
      }
    },
  );
});
