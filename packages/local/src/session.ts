import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSessionCredential, type CredentialSources } from "./credentials.js";
import { DockerCli } from "./docker.js";
import { cleanupGateway, validateGateway } from "./gateway.js";
import { preserveWorkspace } from "./workspace.js";
import { readJson, writeJsonAtomic } from "./fsAtomic.js";
import { agentEnv, harnessCommand, prepareScript, shellQuote } from "./scripts.js";
import { terminal, type CommandReceipt, type LaunchRecord, type SessionCommand, type SessionSpec, type SessionStatus } from "./types.js";

export interface StartSessionOptions {
  directory: string;
  spec: SessionSpec;
  credentials: Omit<CredentialSources, "now">;
  blobsDirectory?: string;
  runtimeDirectory?: string;
}

export class SessionNotFoundError extends Error {
  constructor() { super("no supported session in this directory"); this.name = "SessionNotFoundError"; }
}

export class SessionUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "SessionUnavailableError";
  }
}

const socketUnavailable = (error: unknown) =>
  ["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException)?.code ?? "");

function driverExited(status: SessionStatus | null | undefined): boolean {
  const pid = status?.driverPid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

export function validateSpec(spec: SessionSpec): void {
  if (spec.gateway) {
    validateGateway(spec.gateway);
    if (process.getuid?.() === 65532) throw new Error("Host UID 65532 is reserved for the local gateway");
  }
  if (!["claude-code", "codex", "pi", "opencode"].includes(spec.agent.kind)) throw new Error("unsupported agent");
  if (!spec.image || !spec.agent.model || !spec.prompt.text) throw new Error("image, model and prompt are required");
  if (spec.workspace) {
    const url = new URL(spec.workspace.repo);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.search || url.hash || !/^\/[\w.-]+\/[\w.-]+\/?$/.test(url.pathname))
      throw new Error("workspace must be a public GitHub HTTPS repository URL");
    if (!spec.workspace.ref || spec.workspace.ref.startsWith("-")) throw new Error("invalid repository ref");
  }
  for (const value of [spec.limits.turnTimeoutS, spec.limits.maxTurns])
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("limits must be positive integers");
  if (spec.limits.responseTimeoutS !== null && (!Number.isSafeInteger(spec.limits.responseTimeoutS) || spec.limits.responseTimeoutS < 1))
    throw new Error("response timeout must be null or a positive integer");
  const names = new Set<string>();
  for (const r of spec.resources) {
    if (!["file", "archive"].includes(r.kind)) throw new Error("unsupported resource kind");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(r.name) || names.has(r.name)) throw new Error("invalid or duplicate resource name");
    if (!/^[\w.-]+$/.test(r.filename) || r.filename === "." || r.filename === "..") throw new Error("invalid resource filename");
    if (!/^sha256:[a-f0-9]{64}$/.test(r.digest)) throw new Error("invalid resource digest");
    if (r.use && r.kind !== "archive") throw new Error("resource use requires an archive");
    if (r.use && !["files", "skill", "npm-package"].includes(r.use.type)) throw new Error("unsupported resource use");
    if (r.use?.type === "npm-package" && (!/^[\w.-]+\.tgz$/.test(r.use.package) || !["environment", "workspace"].includes(r.use.install)))
      throw new Error("invalid npm input");
    names.add(r.name);
  }
}

export async function startSession(options: StartSessionOptions): Promise<SessionStatus> {
  validateSpec(options.spec);
  const directory = resolve(options.directory);
  const credential = await resolveSessionCredential(options.spec, { ...options.credentials, now: new Date() });
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory, { mode: 0o700 });
  let credentialDir: string | undefined;
  let handedOff = false;
  const containerName = `gauge-session-${randomUUID()}`;
  try {
    const runtime = options.runtimeDirectory ?? tmpdir();
    await mkdir(runtime, { recursive: true });
    credentialDir = await mkdtemp(join(runtime, "gauge-"));
    await chmod(credentialDir, 0o700);
    await mkdir(join(credentialDir, "workspace"), { mode: 0o700 });
    const record: LaunchRecord = {
      version: 2, containerName, credentialDir,
      socketPath: join(credentialDir, "control.sock"), spec: options.spec,
      credentialExpiresAt: credential.expiresAt?.toISOString(),
      ...(options.spec.gateway ? { gatewayName: `${containerName}-gateway`, trustContainerName: `${containerName}-trust` } : {}),
    };
    if (Buffer.byteLength(record.socketPath) > 100) throw new Error("runtimeDirectory is too long for a Unix socket");
    await writeJsonAtomic(join(directory, "session.json"), record);
    const mounts = [{ type: "bind" as const, source: join(credentialDir, "workspace"), target: "/gauge/session", readonly: false }];
    for (const file of credential.files) {
      const source = join(credentialDir, file.name);
      await writeFile(source, file.contents, { mode: 0o600 });
      mounts.push({ type: "bind" as const, source, target: file.target, readonly: file.readonly });
    }
    for (const resource of options.spec.resources) {
      if (!options.blobsDirectory) throw new Error("blobsDirectory is required for resources");
      mounts.push({ type: "bind" as const, source: resolve(options.blobsDirectory, resource.digest.slice(7)), target: `/gauge/inputs/${resource.name}`, readonly: true });
    }
    const script = [prepareScript(options.spec), ...credential.exports,
      `exec ${harnessCommand(options.spec).map(shellQuote).join(" ")}`].join("\n");
    record.workload = {
      name: containerName, image: options.spec.image, interactive: true,
      user: `${process.getuid!()}:${process.getgid!()}`,
      labels: { "sh.gauge.session": containerName }, mounts,
      env: { ...agentEnv(options.spec.agent.kind), HOME: "/gauge/session/home" }, command: ["sh", "-c", script],
    };
    await writeJsonAtomic(join(directory, "session.json"), record);
    const initial = { state: "preparing", turn: 0, updatedAt: new Date().toISOString(), cleanupPending: true };
    await writeJsonAtomic(join(directory, "status.json"), { ...initial, driverPid: process.pid });
    const log = await open(join(directory, "driver.log"), "a", 0o600);
    try {
      const child = spawn(process.execPath, [fileURLToPath(new URL("./worker.js", import.meta.url)), directory], {
        detached: true, stdio: ["ignore", log.fd, log.fd],
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
          !/(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN)$/.test(key))),
      });
      const spawned = new Promise<void>((yes, no) => { child.once("spawn", yes); child.once("error", no); });
      await spawned;
      handedOff = true;
      child.unref();
      await writeJsonAtomic(join(directory, "status.json"), { ...initial, driverPid: child.pid });
      await writeFile(join(credentialDir, "handoff"), "ready\n", { mode: 0o600 });
    } finally { await log.close(); }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try { return await request<SessionStatus>(record.socketPath, { action: "status" }); }
      catch {
        const saved = await readJson<SessionStatus>(join(directory, "status.json"));
        if (saved && terminal(saved.state)) return saved;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    throw new Error("host session process did not start; see driver.log");
  } catch (error) {
    // Once spawned, only the worker (or explicit orphan cleanup) owns resources.
    if (handedOff) throw error;
    if (credentialDir) await rm(credentialDir, { recursive: true, force: true });
    await writeJsonAtomic(join(directory, "status.json"), { state: "failed", turn: 0, updatedAt: new Date().toISOString(), detail: String(error) });
    throw error;
  }
}

export async function request<T>(socketPath: string, command: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let bytes = "";
    socket.setEncoding("utf8");
    socket.setTimeout(35_000, () => socket.destroy(new Error("session command timed out; delivery may have succeeded")));
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify(command) + "\n"));
    socket.on("data", (chunk) => {
      bytes += chunk;
      if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) { socket.destroy(new Error("session response too large")); return; }
      if (bytes.includes("\n")) {
        try { resolve(JSON.parse(bytes.slice(0, bytes.indexOf("\n"))) as T); } catch (e) { reject(e); }
        socket.end();
      }
    });
    socket.on("end", () => { if (!bytes.includes("\n")) reject(new Error("session disconnected before acknowledging command")); });
  });
}

async function launchRecord(directory: string): Promise<LaunchRecord> {
  const record = await readJson<LaunchRecord>(join(directory, "session.json"));
  if (!record) throw new SessionNotFoundError();
  if (record.version !== 1 && record.version !== 2) throw new Error("Unsupported session record version");
  return record;
}

export async function getSessionStatus(directory: string): Promise<SessionStatus> {
  const record = await launchRecord(directory);
  const saved = await readJson<SessionStatus>(join(directory, "status.json"));
  if (saved && terminal(saved.state)) return saved;
  try { return await request(record.socketPath, { action: "status" }); }
  catch (error) {
    const latest = await readJson<SessionStatus>(join(directory, "status.json"));
    if (latest && terminal(latest.state)) return latest;
    if (!socketUnavailable(error) || !driverExited(latest))
      throw new SessionUnavailableError("Session status is unavailable; the driver may still be running. Check status again before taking action.", error);
    return { ...latest, state: "interrupted", turn: latest?.turn ?? 0, updatedAt: new Date().toISOString(), detail: "Host session process is unavailable. Stop this session to clean up; prompts are never replayed automatically." };
  }
}

async function command(directory: string, value: SessionCommand): Promise<CommandReceipt> {
  const record = await launchRecord(directory);
  let receipt: CommandReceipt;
  try { receipt = await request<CommandReceipt>(record.socketPath, value); }
  catch (error) { throw new SessionUnavailableError("Session command was not acknowledged; delivery may have succeeded. Check status before retrying.", error); }
  if (!receipt.accepted) throw new Error(receipt.error ?? "session rejected command");
  return receipt;
}

export const sendPrompt = (directory: string, expectedTurn: number, text: string) =>
  command(directory, { action: "prompt", turn: expectedTurn, text });
export const answerQuestion = (directory: string, questionId: string, answer: unknown, expectedTurn?: number) =>
  command(directory, { action: "answer", questionId, answer, turn: expectedTurn });
export const finishSession = (directory: string, expectedTurn?: number) => command(directory, { action: "finish", turn: expectedTurn });

export async function stopSession(directory: string): Promise<void> {
  const record = await launchRecord(directory);
  let saved = await readJson<SessionStatus>(join(directory, "status.json"));
  if (saved && terminal(saved.state) && !saved.cleanupPending) return;
  let receipt: CommandReceipt;
  try {
    receipt = await request<CommandReceipt>(record.socketPath, { action: "cancel" });
  }
  catch (error) {
    saved = await readJson<SessionStatus>(join(directory, "status.json"));
    if (saved && terminal(saved.state) && !saved.cleanupPending) return;
    if (!socketUnavailable(error) || !driverExited(saved))
      throw new SessionUnavailableError("Cancellation was not acknowledged; the driver may still be running. Check status before retrying.", error);
    await cleanupOrphan(directory, record);
    return;
  }
  if (!receipt.accepted) throw new Error(receipt.error ?? "session rejected cancellation");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    saved = await readJson<SessionStatus>(join(directory, "status.json"));
    if (saved && terminal(saved.state)) {
      if (saved.cleanupPending) throw new Error(saved.detail ?? "Cleanup incomplete; call stopSession again after the driver exits");
      return;
    }
    if (driverExited(saved)) { await cleanupOrphan(directory, record); return; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new SessionUnavailableError("Cancellation was accepted but cleanup is still pending. Check status; the driver retains ownership of cleanup.");
}

async function cleanupOrphan(directory: string, record: LaunchRecord): Promise<void> {
  if (!/^gauge-session-[a-f0-9-]{36}$/.test(record.containerName) ||
      !isAbsolute(record.credentialDir) || !/^gauge-[A-Za-z0-9]+$/.test(basename(record.credentialDir)) ||
      record.socketPath !== join(record.credentialDir, "control.sock"))
    throw new Error("Refusing cleanup: invalid Gauge runtime ownership record");
  if (record.gatewayName && (record.gatewayName !== `${record.containerName}-gateway` || record.trustContainerName !== `${record.containerName}-trust`))
    throw new Error("Refusing cleanup: invalid gateway ownership record");
  try {
    if (!(await lstat(record.credentialDir)).isDirectory())
      throw new Error("Refusing cleanup: Gauge runtime is not a directory");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const engine = new DockerCli();
  try {
    await engine.assertSessionOwner(record.containerName, record.credentialDir);
    await engine.stop(record.containerName, 2);
    const workspace = await preserveWorkspace(directory, record.credentialDir);
    await engine.remove(record.containerName);
    await cleanupGateway(record, directory, engine);
    await rm(record.credentialDir, { recursive: true, force: true });
    const saved = await readJson<SessionStatus>(join(directory, "status.json"));
    await writeJsonAtomic(join(directory, "status.json"), {
      ...saved, state: saved && terminal(saved.state) ? saved.state : "interrupted",
      turn: saved?.turn ?? 0, updatedAt: new Date().toISOString(), question: undefined, cleanupPending: false,
      detail: saved && terminal(saved.state) && saved.state !== "interrupted" ? saved.detail : "Interrupted session cleaned up explicitly",
      artifacts: workspace ? { ...saved?.artifacts, workspace } : saved?.artifacts,
    });
  } catch (error) {
    const saved = await readJson<SessionStatus>(join(directory, "status.json"));
    await writeJsonAtomic(join(directory, "status.json"), {
      ...saved, state: saved && terminal(saved.state) ? saved.state : "interrupted",
      turn: saved?.turn ?? 0, updatedAt: new Date().toISOString(), cleanupPending: true,
      detail: `Cleanup incomplete: ${String(error)}; retry stopSession after resolving the error`,
    });
    throw error;
  }
}

export const readSessionEventsNdjson = (directory: string): Promise<string> => readFile(join(directory, "events.ndjson"), "utf8");
