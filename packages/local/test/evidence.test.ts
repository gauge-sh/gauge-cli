import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { DriverCallbacks } from "../src/driver.js";
import { finishSession, getSessionStatus, sendPrompt, stopSession } from "../src/session.js";
import type { SessionEvent, SessionSpec } from "../src/types.js";
import { runHostSession } from "../src/worker.js";
import { spec } from "./fakes.js";

vi.mock("../src/driver.js", () => ({
  AgentDriver: class {
    constructor(_spec: SessionSpec, private callbacks: DriverCallbacks) {}
    async start() {}
    async stop() {}
    async prompt(text: string) {
      this.callbacks.record(JSON.stringify({ type: "thread.started", thread_id: "test-session" }));
      this.callbacks.record(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
      this.callbacks.record("usage", JSON.stringify({ type: "gauge.usage", input_tokens: 3, output_tokens: 1 }));
      this.callbacks.record(JSON.stringify({ type: "turn.completed" }));
    }
  },
}));
vi.mock("../src/docker.js", () => ({
  DockerCli: class { async remove() {} },
}));

it("records stable sequence IDs across turns and starts a fresh sequence for each session attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "gauge-evidence-"));
  try {
    for (const attempt of [1, 2]) {
      const directory = join(root, String(attempt));
      const credentialDir = join(directory, "credentials");
      await mkdir(credentialDir, { recursive: true });
      await writeFile(join(directory, "session.json"), JSON.stringify({
        version: 1, containerName: "test-session", credentialDir,
        socketPath: join(directory, "control.sock"),
        spec: spec({ agent: { kind: "codex", model: "test" }, workspace: null }),
      }));
      const running = runHostSession(directory);
      try {
        await vi.waitFor(async () => expect(await getSessionStatus(directory)).toMatchObject({ state: "waiting", turn: 1 }));
        await sendPrompt(directory, 1, "Second turn");
        await vi.waitFor(async () => expect(await getSessionStatus(directory)).toMatchObject({ state: "waiting", turn: 2 }));
        await finishSession(directory);
        await running;
        const events: SessionEvent[] = (await readFile(join(directory, "events.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3]);
        expect(events.map((event) => event.turn)).toEqual([1, 1, 2, 2]);
        expect(events.filter((event) => event.payload.type === "agent_message").map((event) => event.seq)).toEqual([0, 2]);
      } finally {
        await stopSession(directory).catch(() => {});
        await running;
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
