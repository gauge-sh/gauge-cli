import { describe, expect, it } from "vitest";
import { NativeSession } from "@withgauge/agent-adapters";
import { AgentDriver, codexRecord, exitError, readLines } from "../src/driver.js";
import type { Question, SessionSpec } from "../src/types.js";
import { validateSpec } from "../src/session.js";
import { harnessCommand, shellQuote } from "../src/scripts.js";
import { execFileSync } from "node:child_process";
import { spec } from "./fakes.js";

describe("stock persistent transports", () => {
  it("preserves native question envelopes and writes only the caller's answer as the result", async () => {
    for (const method of ["item/tool/requestUserInput", "item/commandExecution/requestApproval"]) {
      const questions: Question[] = [];
      const driver = new AgentDriver(spec({ agent: { kind: "codex", model: "m" } }), {
        record() {}, question(q) { questions.push(q); }, stderr() {}, failed(e) { throw e; },
      }, "unused");
      const wire = driver as unknown as { accept(raw: string): void; write(value: unknown): void };
      const request = { id: 42, method, params: { threadId: "thread-1", questions: [] } };
      wire.accept(JSON.stringify(request));
      expect(questions).toEqual([{ id: "42", request }]);
      const sent: unknown[] = [];
      wire.write = (value) => { sent.push(value); };
      const answer = method.endsWith("requestUserInput") ? { answers: {} } : { decision: "decline" };
      await driver.answer("42", answer);
      expect(sent).toEqual([{ id: 42, result: answer }]);
    }
  });
  it("preserves UTF-8 across chunks and does not split Unicode line separators", async () => {
    const expected = JSON.stringify({ text: "hello 🐈\u2028world" });
    const bytes = Buffer.from(expected + "\n");
    const lines: string[] = [];
    async function* chunks() { for (const b of bytes) yield Buffer.from([b]); }
    await readLines(chunks(), (line) => lines.push(line));
    expect(lines).toEqual([expected]);
  });
  it("names the agent's last stderr line when the connection exits", () => {
    const stderr = "starting\n--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons\n\n";
    expect(exitError(1, stderr).message).toBe("agent connection exited (1): --dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons");
    expect(exitError("SIGKILL", "").message).toBe("agent connection exited (SIGKILL)");
    expect(exitError(1, "x".repeat(400)).message).toHaveLength("agent connection exited (1): ".length + 301);
  });
  it("rejects incomplete and oversized records", async () => {
    async function* partial() { yield Buffer.from('{"hello":'); }
    async function* large() { yield Buffer.alloc(8 * 1024 * 1024 + 1, "x"); }
    await expect(readLines(partial(), () => {})).rejects.toThrow(/incomplete/);
    await expect(readLines(large(), () => {})).rejects.toThrow(/8 MiB/);
  });
  it("feeds app-server messages, tool results and explicit turn endings into the published codec", () => {
    const native = new NativeSession("codex", "thread-1");
    const observe = (value: Record<string, unknown>) => native.observe(JSON.stringify(codexRecord(value)), new Date().toISOString());
    const message = observe({ method: "item/completed", params: { item: { type: "agentMessage", id: "m1", text: "hello" } } });
    expect(message.payloads).toEqual([{ type: "agent_message", text: "hello" }]);
    const tool = observe({ method: "item/completed", params: { item: { type: "commandExecution", id: "c1", command: "pwd", aggregatedOutput: "/workspace", exitCode: 0 } } });
    expect(tool.payloads).toContainEqual(expect.objectContaining({ type: "tool_result", output: "/workspace", is_error: false }));
    expect(observe({ method: "turn/completed", params: { turn: { status: "completed" } } }).terminal?.status).toBe("complete");
    native.beginTurn();
    expect(observe({ method: "turn/completed", params: { turn: { status: "failed", error: { message: "denied" } } } }).terminal).toMatchObject({ status: "failed", reason: "denied" });
  });
  it("quotes shell values literally and uses persistent modes", () => {
    const value = "it's $(touch /should-not-exist) `echo nope`";
    expect(execFileSync("sh", ["-c", `printf %s ${shellQuote(value)}`], { encoding: "utf8" })).toBe(value);
    expect(harnessCommand(spec())).toContain("--input-format");
    expect(harnessCommand(spec({ agent: { kind: "codex", model: "m" } }))).toEqual(["codex", "app-server", "--listen", "stdio://"]);
    expect(harnessCommand(spec({ agent: { kind: "pi", model: "openai/m" } }))).toContain("rpc");
  });
});

describe("launch input boundaries", () => {
  it("rejects obsolete or unknown resource kinds and archive uses", () => {
    const resource = { name: "input", kind: "file", digest: `sha256:${"a".repeat(64)}`, filename: "input.tgz" };
    for (const invalid of [
      { ...resource, kind: "npm_package" }, { ...resource, kind: "unknown" },
      { ...resource, use: { type: "files" } },
      { ...resource, kind: "archive", use: { type: "unknown" } },
    ]) expect(() => validateSpec(spec({ resources: [invalid] } as unknown as Partial<SessionSpec>))).toThrow();
  });
  it("allows public GitHub URLs and rejects credentials, alternate protocols and option-like refs", () => {
    expect(() => validateSpec(spec())).not.toThrow();
    for (const repo of ["file:///tmp/repo", "https://user:password@github.com/a/b", "https://github.com/a/b?token=secret", "https://example.com/a/b"])
      expect(() => validateSpec(spec({ workspace: { repo, ref: "main" } }))).toThrow();
    expect(() => validateSpec(spec({ workspace: { repo: "https://github.com/a/b", ref: "--help" } }))).toThrow();
  });
  it("rejects paths that escape the frozen resource directories", () => {
    for (const filename of ["../secret", "..", "/etc/passwd"])
      expect(() => validateSpec(spec({ resources: [{ name: "input", kind: "file", digest: `sha256:${"a".repeat(64)}`, filename }] }))).toThrow();
  });
});
