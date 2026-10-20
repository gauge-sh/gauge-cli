import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { answerQuestion, finishSession, getSessionStatus, sendPrompt, startSession, stopSession } from "../dist/index.js";
import type { LaunchRecord, SessionSpec, SessionStatus } from "../src/types.js";
import { spec } from "./fakes.js";

const enabled = process.env.GAUGE_DOCKER_FIXTURES === "1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function wait(directory: string, state: SessionStatus["state"]): Promise<SessionStatus> {
  for (let i = 0; i < 150; i++) {
    const status = await getSessionStatus(directory);
    if (status.state === state) return status;
    if (["failed", "interrupted"].includes(status.state)) throw new Error(JSON.stringify(status));
    await sleep(100);
  }
  throw new Error(`did not reach ${state}`);
}
async function fixture(overrides: Partial<SessionSpec>, test: (directory: string, launch: LaunchRecord) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "gauge-lifecycle-"));
  const directory = join(root, "session");
  try {
    await startSession({ directory, spec: spec({ image: "gauge-session-fixture:test", ...overrides }), credentials: { env: { CLAUDE_CODE_OAUTH_TOKEN: "fixture-only" }, homeDir: root }, runtimeDirectory: tmpdir() });
    const launch: LaunchRecord = JSON.parse(await readFile(join(directory, "session.json"), "utf8"));
    await test(directory, launch);
  } finally {
    await stopSession(directory).catch(() => {});
    if (process.env.GAUGE_IT_KEEP !== "1") await rm(root, { recursive: true, force: true });
  }
}
function absent(launch: LaunchRecord) {
  expect(execFileSync("docker", ["ps", "-aq", "--filter", `name=^/${launch.containerName}$`], { encoding: "utf8" }).trim()).toBe("");
}

describe.skipIf(!enabled)("host owner lifecycle in real Docker, without inference", () => {
  it("routes a blocked question and rejects duplicate answers", { timeout: 30_000 }, () => fixture({ prompt: { text: "QUESTION" } }, async (dir, launch) => {
    const status = await wait(dir, "blocked");
    expect(status.question?.id).toBe("ask-1");
    await answerQuestion(dir, "ask-1", { behavior: "allow", updatedInput: { answer: "blue" } });
    await wait(dir, "waiting");
    await expect(answerQuestion(dir, "ask-1", {})).rejects.toThrow(/no longer pending/);
    expect(await readFile(join(dir, "events.ndjson"), "utf8")).toContain("blue");
    await finishSession(dir);
    await wait(dir, "completed"); absent(launch);
  }));
  it("allows only one concurrent prompt at the expected turn", { timeout: 30_000 }, () => fixture({}, async (dir) => {
    await wait(dir, "waiting");
    const results = await Promise.allSettled([sendPrompt(dir, 1, "one"), sendPrompt(dir, 1, "two")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await wait(dir, "waiting")).turn).toBe(2);
    await expect(finishSession(dir, 1)).rejects.toThrow(/expected turn/);
    const input = (await readFile(join(dir, "inputs.ndjson"), "utf8")).trim().split("\n");
    expect(input).toHaveLength(2);
  }));
  it("enforces turn deadlines without a polling CLI and cleans credentials", { timeout: 30_000 }, () => fixture({ prompt: { text: "HANG" }, limits: { turnTimeoutS: 1, responseTimeoutS: null, maxTurns: 5 } }, async (dir, launch) => {
    await sleep(4000);
    expect(await wait(dir, "failed")).toMatchObject({ detail: "agent turn timed out" });
    absent(launch);
    await expect(readFile(join(launch.credentialDir, "claude-token"))).rejects.toMatchObject({ code: "ENOENT" });
  }));
  it("enforces the supervisor response deadline", { timeout: 30_000 }, () => fixture({ limits: { turnTimeoutS: 30, responseTimeoutS: 1, maxTurns: 5 } }, async (dir, launch) => {
    await wait(dir, "waiting");
    expect(await wait(dir, "failed")).toMatchObject({ detail: "supervisor response timed out" }); absent(launch);
  }));
  it("cancels an active process and removes its container", { timeout: 30_000 }, () => fixture({ prompt: { text: "HANG" } }, async (dir, launch) => {
    await wait(dir, "running"); await stopSession(dir);
    expect(await getSessionStatus(dir)).toMatchObject({ state: "canceled" }); absent(launch);
  }));
  it("reports a lost host owner as interrupted and cleans up without restarting", { timeout: 30_000 }, () => fixture({}, async (dir, launch) => {
    const status = await wait(dir, "waiting");
    const evidence = await readFile(join(dir, "events.ndjson"), "utf8");
    const binary = Buffer.from([0, 255, 1, 128]);
    await writeFile(join(launch.credentialDir, "workspace/workspace/untracked.bin"), binary);
    process.kill(status.driverPid!, "SIGKILL"); await sleep(100);
    expect(await getSessionStatus(dir)).toMatchObject({ state: "interrupted" });
    await writeFile(join(dir, "recovered-workspace"), "collision");
    await expect(stopSession(dir)).rejects.toThrow("Expected a directory");
    expect(await readFile(join(launch.credentialDir, "workspace/workspace/hello.txt"), "utf8")).toBe("hi\n");
    await rm(join(dir, "recovered-workspace"));
    await stopSession(dir); absent(launch);
    expect(await getSessionStatus(dir)).toMatchObject({ state: "interrupted", artifacts: { workspace: "recovered-workspace" } });
    expect(await readFile(join(dir, "recovered-workspace/hello.txt"), "utf8")).toBe("hi\n");
    expect(await readFile(join(dir, "recovered-workspace/untracked.bin"))).toEqual(binary);
    expect((await lstat(join(dir, "recovered-workspace/.git"))).isDirectory()).toBe(true);
    expect(await readFile(join(dir, "events.ndjson"), "utf8")).toBe(evidence);
    await expect(lstat(launch.credentialDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(dir, "recovered-workspace/home"))).rejects.toMatchObject({ code: "ENOENT" });
    await stopSession(dir);
    expect(await getSessionStatus(dir)).toMatchObject({ state: "interrupted", artifacts: { workspace: "recovered-workspace" } });
  }));
  it("preserves working files when final diff capture fails", { timeout: 30_000 }, () => fixture({}, async (dir, launch) => {
    await wait(dir, "waiting");
    await rm(join(launch.credentialDir, "workspace/workspace/.git"), { recursive: true });
    await finishSession(dir);
    expect(await wait(dir, "failed")).toMatchObject({ artifacts: { workspace: "recovered-workspace" } });
    expect(await readFile(join(dir, "recovered-workspace/hello.txt"), "utf8")).toBe("hi\n");
    absent(launch);
    await expect(lstat(launch.credentialDir)).rejects.toMatchObject({ code: "ENOENT" });
  }));
  it("keeps status available while a large runtime directory is cleaned up", { timeout: 30_000 }, () => fixture({}, async (dir, launch) => {
    await wait(dir, "waiting");
    const cache = join(launch.credentialDir, "workspace/home/cache");
    await mkdir(cache);
    for (let batch = 0; batch < 40; batch++)
      await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(join(cache, `${batch}-${i}`), "cache")));
    await finishSession(dir);
    for (let i = 0; i < 2000; i++) {
      const status = await getSessionStatus(dir);
      expect(status.state).not.toBe("interrupted");
      if (status.state === "completed") { absent(launch); return; }
      expect(status.state).not.toBe("failed");
      await sleep(5);
    }
    throw new Error("cleanup did not complete");
  }));
  it("reports incomplete terminal cleanup and allows a retry after the driver exits", { timeout: 30_000 }, () => fixture({}, async (dir, launch) => {
    await wait(dir, "waiting");
    await rm(join(launch.credentialDir, "workspace/workspace/.git"), { recursive: true });
    await writeFile(join(dir, "recovered-workspace"), "collision");
    await finishSession(dir);
    const status = await wait(dir, "failed");
    expect(status.cleanupPending).toBe(true);
    expect(await readFile(join(launch.credentialDir, "workspace/workspace/hello.txt"), "utf8")).toBe("hi\n");
    for (let i = 0; i < 100; i++) {
      try { process.kill(status.driverPid!, 0); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") break; throw e; }
      await sleep(50);
    }
    await rm(join(dir, "recovered-workspace"));
    await stopSession(dir);
    expect(await getSessionStatus(dir)).toMatchObject({ state: "failed", cleanupPending: false, artifacts: { workspace: "recovered-workspace" } });
    absent(launch);
    await expect(lstat(launch.credentialDir)).rejects.toMatchObject({ code: "ENOENT" });
  }));
  it("reports native failures", { timeout: 30_000 }, () => fixture({ prompt: { text: "FAIL" } }, async (dir, launch) => {
    expect(await wait(dir, "failed")).toMatchObject({ state: "failed" }); absent(launch);
  }));
  it("cleans up a preparation failure before an agent starts", { timeout: 30_000 }, () => fixture({ workspace: { repo: "https://github.com/fail/prepare", ref: "master" } }, async (dir, launch) => {
    expect(await wait(dir, "failed")).toMatchObject({ turn: 0 }); absent(launch);
  }));
  it("starts without a repository and captures new files", { timeout: 30_000 }, () => fixture({ workspace: null }, async (dir, launch) => {
    await wait(dir, "waiting");
    await finishSession(dir);
    expect(await wait(dir, "completed")).toMatchObject({ artifacts: { diff: "diff.patch" } });
    expect(await readFile(join(dir, "diff.patch"), "utf8")).toContain("+hi");
    absent(launch);
  }));
});
