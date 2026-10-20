import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { answerQuestion, finishSession, getSessionStatus, sendPrompt, stopSession } from "../src/session.js";
import type { AgentKind, AuthMode, LaunchRecord, SessionStatus } from "../src/types.js";
import { spec } from "./fakes.js";

const enabled = process.env.GAUGE_DOCKER_TESTS === "1";
const selected = process.env.GAUGE_IT_AGENTS?.split(",");
const cases: { agent: AgentKind; model: string; auth: AuthMode; available: boolean }[] = [
  { agent: "claude-code", model: "claude-sonnet-5-5", auth: "api_key", available: !!process.env.ANTHROPIC_API_KEY },
  { agent: "claude-code", model: "claude-sonnet-5-5", auth: "access_token", available: process.env.GAUGE_IT_CLAUDE_LOGIN === "1" },
  { agent: "codex", model: "gpt-6.1-sol", auth: "api_key", available: !!process.env.OPENAI_API_KEY },
  { agent: "codex", model: "gpt-6-astra", auth: "access_token", available: process.env.GAUGE_IT_CHATGPT === "1" },
  { agent: "pi", model: "openai-codex/gpt-6-astra", auth: "access_token", available: process.env.GAUGE_IT_CHATGPT === "1" },
  { agent: "opencode", model: "openai/gpt-6-astra", auth: "access_token", available: process.env.GAUGE_IT_CHATGPT === "1" },
];
async function settle(directory: string): Promise<SessionStatus> {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const status = await getSessionStatus(directory);
    if (!["preparing", "running"].includes(status.state)) return status;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("session did not settle");
}

describe("persistent Docker sessions", () => {
  for (const c of cases) it.skipIf(!enabled || !c.available || (selected && !selected.includes(c.agent)))(
    `${c.agent} (${c.auth}): survives CLI exit, retains one container/process, takes another prompt, captures results`,
    { timeout: 600_000 }, async () => {
      const root = await mkdtemp(join(tmpdir(), "gauge-session-it-"));
      const directory = join(root, "session");
      const configuration = spec({ image: process.env.GAUGE_IT_IMAGE ?? "gauge-runtime:dev", agent: { kind: c.agent, model: c.model }, auth: { mode: c.auth },
        prompt: { text: "Remember the secret word kumquat for this conversation; do not write it to a file. Create hello.txt containing exactly hi. Reply DONE." } });
      try {
        const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
        execFileSync(process.execPath, ["--input-type=module", "-e", `
          const { startSession } = await import(${JSON.stringify(entry)});
          await startSession({ directory: ${JSON.stringify(directory)}, spec: ${JSON.stringify(configuration)},
            credentials: { env: process.env, homeDir: ${JSON.stringify(homedir())} }, runtimeDirectory: ${JSON.stringify(tmpdir())} });
        `], { timeout: 20_000, stdio: "pipe" });
        let status = await settle(directory);
        expect(status).toMatchObject({ state: "waiting", turn: 1 });
        const launch: LaunchRecord = JSON.parse(await readFile(join(directory, "session.json"), "utf8"));
        const inspect = () => JSON.parse(execFileSync("docker", ["inspect", launch.containerName], { encoding: "utf8" }))[0];
        const first = inspect();
        expect(first.State.Running).toBe(true);
        expect(first.Mounts.some((m: { Source: string }) => m.Source.startsWith(directory))).toBe(false);
        expect(first.Config.Env.join("\n")).not.toMatch(/eyJ[A-Za-z0-9_-]{20}/);
        const initialSessionId = status.sessionId;
        const firstDriver = status.driverPid;
        await sendPrompt(directory, 1, "What secret word did I ask you to remember? Reply with that word only.");
        await expect(sendPrompt(directory, 1, "This stale prompt must never be sent.")).rejects.toThrow();
        status = await settle(directory);
        expect(status).toMatchObject({ state: "waiting", turn: 2, sessionId: initialSessionId, driverPid: firstDriver });
        expect(inspect().State.Pid).toBe(first.State.Pid);
        expect(await readFile(join(directory, "events.ndjson"), "utf8")).toContain("kumquat");
        if (c.agent === "opencode" || c.agent === "claude-code") {
          await sendPrompt(directory, 2, `Use the ${c.agent === "claude-code" ? "AskUserQuestion" : "question"} tool now to ask me to choose between red and blue. Wait for my answer, then repeat my chosen color.`);
          status = await settle(directory);
          expect(status.state).toBe("blocked");
          const request = status.question!.request as { input: { questions: { question: string }[] } };
          const answer = c.agent === "opencode" ? [["blue"]] : {
            behavior: "allow", updatedInput: { ...request.input, answers: Object.fromEntries(request.input.questions.map((q) => [q.question, "blue"])) },
          };
          await answerQuestion(directory, status.question!.id, answer);
          status = await settle(directory);
          expect(status.state).toBe("waiting");
          expect(await readFile(join(directory, "events.ndjson"), "utf8")).toContain("blue");
        }
        await finishSession(directory);
        for (let i = 0; i < 100; i++) {
          status = await getSessionStatus(directory);
          if (status.state === "completed" || status.state === "failed") break;
          await new Promise((r) => setTimeout(r, 200));
        }
        expect(status).toMatchObject({ state: "completed", artifacts: { diff: "diff.patch" } });
        expect(await readFile(join(directory, "diff.patch"), "utf8")).toContain("+hi");
        expect(execFileSync("docker", ["ps", "-aq", "--filter", `name=^/${launch.containerName}$`], { encoding: "utf8" }).trim()).toBe("");
        await expect(readFile(join(launch.credentialDir, "control.sock"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await stopSession(directory).catch(() => {});
        if (process.env.GAUGE_IT_KEEP !== "1") await rm(root, { recursive: true, force: true });
      }
    },
  );
});
