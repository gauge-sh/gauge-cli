import { spawn } from "node:child_process";
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { open, readFile, readdir, rm, rmdir, type FileHandle } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { NativeSession, type EvidencePayload } from "@withgauge/agent-adapters";
import { AgentDriver } from "./driver.js";
import { DockerCli } from "./docker.js";
import { cleanupGateway, prepareGateway } from "./gateway.js";
import { preserveWorkspace } from "./workspace.js";
import { captureScript } from "./scripts.js";
import { terminal, type LaunchRecord, type Question, type SessionCommand, type SessionStatus } from "./types.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runHostSession(directory: string): Promise<void> {
  const launch: LaunchRecord = JSON.parse(await readFile(join(directory, "session.json"), "utf8"));
  const { spec } = launch;
  if (launch.version === 2) {
    const deadline = Date.now() + 10_000;
    while (true) {
      try { await readFile(join(launch.credentialDir, "handoff")); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() >= deadline) throw new Error("Session handoff did not complete; stop this session to clean up");
        await sleep(50);
      }
    }
  }
  let status: SessionStatus = { state: "preparing", turn: 0, driverPid: process.pid, updatedAt: new Date().toISOString() };
  let native: NativeSession | undefined;
  let fatal: Error | undefined;
  let finish: "completed" | "canceled" | undefined;
  let closing = false;
  let gatewayReady = false;
  let turnDeadline = Infinity;
  let remainingTurnMs = spec.limits.turnTimeoutS * 1000;
  let waitingSince = Date.now();
  let nextSeq = 0;
  const questions = new Map<string, Question>();
  const persist = (patch: Partial<SessionStatus>) => {
    status = { ...status, ...patch, updatedAt: new Date().toISOString() };
    const path = join(directory, "status.json");
    writeFileSync(`${path}.tmp`, JSON.stringify(status) + "\n", { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  };
  const append = (file: string, record: unknown) => appendFileSync(join(directory, file), JSON.stringify(record) + "\n", { mode: 0o600 });
  const evidence = (payload: EvidencePayload) => append("events.ndjson", { seq: nextSeq++, turn: status.turn, observedAt: new Date().toISOString(), payload });
  const driver = new AgentDriver(spec, {
    stderr: (chunk) => appendFileSync(join(directory, "agent.stderr.log"), chunk, { mode: 0o600 }),
    failed: (error) => { if (!closing) fatal ??= error; },
    question: (question) => {
      if (closing) return;
      questions.set(question.id, question);
      if (status.state !== "blocked") {
        remainingTurnMs = Math.max(0, turnDeadline - Date.now());
        waitingSince = Date.now();
      }
      persist({ state: "blocked", question: questions.values().next().value });
    },
    record: (raw, decoded) => {
      append("agent.ndjson", { turn: status.turn, observedAt: new Date().toISOString(), raw });
      if (!native || closing) return;
      try {
        const projected = decoded ? JSON.parse(decoded) : undefined;
        if (projected?.type === "gauge.usage") {
          evidence({ type: "usage", input_tokens: projected.input_tokens, output_tokens: projected.output_tokens, cache_read_input_tokens: projected.cache_read_input_tokens });
          return;
        }
        const observed = native.observe(decoded ?? raw, new Date().toISOString());
        for (const payload of observed.payloads) evidence(payload);
        if (observed.state.sessionId && observed.state.sessionId !== status.sessionId) {
          driver.sessionId = observed.state.sessionId;
          persist({ sessionId: observed.state.sessionId });
        }
        if (observed.terminal) {
          if (observed.terminal.status === "failed") fatal = new Error(observed.terminal.reason);
          else {
            questions.clear(); waitingSince = Date.now();
            persist({ state: "waiting", question: undefined });
          }
        }
      } catch (e) { fatal = e instanceof Error ? e : new Error(String(e)); }
    },
  }, launch.containerName);

  const prompt = async (text: string) => {
    if (status.turn >= spec.limits.maxTurns) throw new Error("session turn limit reached");
    if (launch.credentialExpiresAt && Date.parse(launch.credentialExpiresAt) - Date.now() < (spec.limits.turnTimeoutS + 300) * 1000)
      throw new Error("Credential renewal required on the host before starting another turn");
    if (status.turn) native!.beginTurn();
    remainingTurnMs = spec.limits.turnTimeoutS * 1000;
    turnDeadline = Date.now() + remainingTurnMs;
    persist({ state: "running", turn: status.turn + 1, question: undefined });
    append("inputs.ndjson", { turn: status.turn, observedAt: new Date().toISOString(), text });
    try { await driver.prompt(text); }
    catch (e) {
      fatal = e instanceof Error ? e : new Error(String(e));
      throw e;
    }
  };

  const handle = async (command: SessionCommand) => {
    if (command.action === "cancel") {
      if (!closing && !finish && !fatal) finish = "canceled";
      return;
    }
    if (closing || finish || fatal) throw new Error("session is closing");
    switch (command.action) {
      case "prompt":
        if (status.state !== "waiting" || command.turn !== status.turn) throw new Error("session is not waiting at the expected turn");
        if (typeof command.text !== "string" || !command.text.trim()) throw new Error("prompt must be nonempty text");
        await prompt(command.text); break;
      case "answer": {
        if (status.state !== "blocked" || !questions.has(command.questionId) || command.turn !== undefined && command.turn !== status.turn) throw new Error("question is no longer pending");
        append("inputs.ndjson", { turn: status.turn, observedAt: new Date().toISOString(), questionId: command.questionId, answer: command.answer });
        try { await driver.answer(command.questionId, command.answer); }
        catch (e) { fatal = e instanceof Error ? e : new Error(String(e)); throw e; }
        questions.delete(command.questionId);
        if (status.state === "blocked") {
          if (questions.size) persist({ question: questions.values().next().value });
          else { turnDeadline = Date.now() + remainingTurnMs; persist({ state: "running", question: undefined }); }
        }
        break;
      }
      case "finish":
        if (status.state !== "waiting") throw new Error("finish requires an idle agent; use stop to cancel active work");
        if (command.turn !== undefined && command.turn !== status.turn) throw new Error("session is not waiting at the expected turn");
        finish = "completed"; break;
      default: throw new Error("unknown command");
    }
  };

  let commands: Promise<unknown> = Promise.resolve();
  const server = createServer((socket) => {
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    socket.setTimeout(40_000, () => socket.destroy());
    let buffer = "";
    let received = false;
    socket.on("data", (chunk) => {
      if (received) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1024 * 1024) { socket.destroy(); return; }
      if (!buffer.includes("\n")) return;
      received = true;
      let value: SessionCommand | { action: "status" };
      try { value = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))); }
      catch { socket.end(JSON.stringify({ accepted: false, error: "invalid command JSON" }) + "\n"); return; }
      if (value?.action === "status") { socket.end(JSON.stringify(status) + "\n"); return; }
      const action = value as SessionCommand;
      commands = commands.then(() => handle(action)).then(
        () => socket.end(JSON.stringify({ accepted: true }) + "\n"),
        (e) => socket.end(JSON.stringify({ accepted: false, error: e instanceof Error ? e.message : String(e) }) + "\n"),
      );
    });
  });
  persist({});
  writeFileSync(join(directory, "events.ndjson"), "", { mode: 0o600 });
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(launch.socketPath, yes); });
  const signal = () => { finish = "canceled"; };
  process.on("SIGTERM", signal);
  process.on("SIGINT", signal);
  const boot = (async () => {
    if (launch.version === 2) {
      if (spec.gateway) {
        await prepareGateway(launch, () => closing || !!finish || !!fatal);
        gatewayReady = true;
      }
      if (closing || finish || fatal) return;
      if (!launch.workload || await new DockerCli().create(launch.workload) !== "created") throw new Error("Session container already exists or its launch specification is missing");
      if (closing || finish || fatal) return;
    }
    await driver.start();
    if (closing || finish || fatal) return;
    native = new NativeSession(spec.agent.kind, driver.sessionId);
    persist({ sessionId: driver.sessionId, workspaceCommit: driver.baseCommit });
    await prompt(spec.prompt.text);
  })().catch((e) => { if (!closing && !finish) fatal = e instanceof Error ? e : new Error(String(e)); });

  try {
    let nextGatewayCheck = 0;
    while (!finish && !fatal) {
      const now = Date.now();
      if (launch.gatewayName && gatewayReady && now >= nextGatewayCheck) {
        nextGatewayCheck = now + 1_000;
        try { if (!await new DockerCli().ready(launch.gatewayName)) fatal = new Error("Gateway exited or became unhealthy; rerun to start a fresh session"); }
        catch (error) { fatal = new Error(`Gateway health could not be verified: ${String(error)}`); }
      }
      if (status.state === "running" && now > turnDeadline) fatal = new Error("agent turn timed out");
      if (["waiting", "blocked"].includes(status.state) && spec.limits.responseTimeoutS !== null && now - waitingSince > spec.limits.responseTimeoutS * 1000)
        fatal = new Error("supervisor response timed out");
      if (launch.credentialExpiresAt && now >= Date.parse(launch.credentialExpiresAt) - 60_000)
        fatal = new Error("Credential renewal required on the host before continuing");
      await sleep(100);
    }
  } finally {
    closing = true;
    let artifacts: SessionStatus["artifacts"];
    let cleanupPending = false;
    // Stop preparation before removing anything it could still create. Driver
    // stop releases its protocol waits; gateway preparation checks cancellation
    // between bounded Docker operations.
    if (status.state === "preparing") {
      try {
        await new DockerCli().assertSessionOwner(launch.containerName, launch.credentialDir);
        await driver.stop();
      }
      catch (error) { fatal ??= error instanceof Error ? error : new Error(String(error)); }
    }
    await boot;
    if (driver.baseCommit && status.state !== "preparing") {
      let out: FileHandle | undefined;
      let err: FileHandle | undefined;
      try {
        out = await open(join(directory, "diff.patch.tmp"), "w", 0o600);
        err = await open(join(directory, "capture.stderr.log"), "a", 0o600);
        await new Promise<void>((yes, no) => {
          const child = spawn("docker", ["exec", launch.containerName, "sh", "-c", captureScript(driver.baseCommit!)], { stdio: ["ignore", out!.fd, err!.fd] });
          const timer = setTimeout(() => { child.kill("SIGKILL"); no(new Error("diff capture timed out")); }, 20_000);
          child.once("error", (e) => { clearTimeout(timer); no(e); });
          child.once("close", (code) => { clearTimeout(timer); code === 0 ? yes() : no(new Error(`diff capture exited ${code}`)); });
        });
        renameSync(join(directory, "diff.patch.tmp"), join(directory, "diff.patch"));
        artifacts = { diff: "diff.patch" };
      } catch (e) { fatal ??= e instanceof Error ? e : new Error(String(e)); }
      finally { await out?.close().catch(() => {}); await err?.close().catch(() => {}); }
    }
    try {
      await new DockerCli().assertSessionOwner(launch.containerName, launch.credentialDir);
      await driver.stop();
      if (!artifacts?.diff) {
        const workspace = await preserveWorkspace(directory, launch.credentialDir);
        if (workspace) artifacts = { workspace };
      }
      await new DockerCli().remove(launch.containerName);
      await cleanupGateway(launch, directory);
      for (const entry of await readdir(launch.credentialDir)) {
        if (entry !== basename(launch.socketPath)) await rm(join(launch.credentialDir, entry), { recursive: true, force: true });
      }
    } catch (e) {
      cleanupPending = true;
      fatal = new Error(`${fatal ? `${fatal.message}; ` : ""}cleanup incomplete: ${String(e)}; run stopSession again`);
    }
    persist({ state: fatal ? "failed" : finish ?? "failed", detail: fatal?.message, artifacts, question: undefined, cleanupPending });
    await commands;
    await new Promise<void>((yes) => server.close(() => yes()));
    try { await rmdir(launch.credentialDir); }
    catch (e) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e; }
    process.off("SIGTERM", signal); process.off("SIGINT", signal);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHostSession(process.argv[2]!).catch((error) => { console.error(error); process.exitCode = 1; });
}
