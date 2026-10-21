import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { BASE_COMMIT_MARKER, splitModel, WORKSPACE_DIR } from "./scripts.js";
import type { Question, SessionSpec } from "./types.js";

type Json = Record<string, any>;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function readLines(stream: AsyncIterable<Uint8Array>, accept: (line: string) => void): Promise<void> {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.write(Buffer.from(chunk));
    let lf: number;
    while ((lf = buffer.indexOf("\n")) >= 0) {
      if (Buffer.byteLength(buffer.slice(0, lf)) > 8 * 1024 * 1024) throw new Error("agent record exceeds 8 MiB");
      const line = buffer.slice(0, lf).replace(/\r$/, "");
      buffer = buffer.slice(lf + 1);
      if (line) accept(line);
    }
    if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) throw new Error("agent record exceeds 8 MiB");
  }
  buffer += decoder.end();
  if (buffer) throw new Error("agent disconnected with an incomplete record");
}

export function codexRecord(record: Json): Json | undefined {
  const p = record.params;
  if (!p) return;
  if (record.method === "thread/started") return { type: "thread.started", thread_id: p.thread.id };
  if (record.method === "turn/completed") return p.turn.status === "completed"
    ? { type: "turn.completed" }
    : { type: "turn.failed", error: { message: p.turn.error?.message ?? p.turn.status } };
  if (record.method === "thread/tokenUsage/updated") {
    const u = p.tokenUsage.last;
    return { type: "gauge.usage", input_tokens: u.inputTokens, output_tokens: u.outputTokens, cache_read_input_tokens: u.cachedInputTokens };
  }
  if (record.method !== "item/completed") return;
  const i = p.item;
  let item: Json;
  switch (i.type) {
    case "agentMessage": item = { ...i, type: "agent_message" }; break;
    case "reasoning": item = { ...i, text: [...(i.summary ?? []), ...(i.content ?? [])].join("\n") }; break;
    case "commandExecution": item = { ...i, type: "command_execution", aggregated_output: i.aggregatedOutput, exit_code: i.exitCode }; break;
    case "fileChange": item = { ...i, type: "file_change", changes: i.changes.map((c: Json) => ({ path: c.path, kind: c.kind?.type ?? c.kind })) }; break;
    case "mcpToolCall": item = { ...i, type: "mcp_tool_call" }; break;
    case "webSearch": item = { ...i, type: "web_search" }; break;
    default: return;
  }
  return { type: "item.completed", item };
}

export function exitError(status: number | string | null, stderr: string): Error {
  const last = stderr.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
  const reason = last && last.length > 300 ? `${last.slice(0, 300)}…` : last;
  return new Error(`agent connection exited (${status})${reason ? `: ${reason}` : ""}`);
}

export interface DriverCallbacks {
  record(raw: string, decoded?: string): void;
  question(question: Question): void;
  stderr(chunk: Buffer): void;
  failed(error: Error): void;
}

export class AgentDriver {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string | number, { resolve: (r: Json) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private questions = new Map<string, Json>();
  private nextId = 0;
  private stopping = false;
  private serverReady = false;
  private stderrTail = "";
  private eventStream?: ChildProcessWithoutNullStreams;
  private prepared?: () => void;
  baseCommit?: string;
  sessionId?: string;
  get pid(): number | undefined { return this.child?.pid; }

  constructor(private spec: SessionSpec, private callbacks: DriverCallbacks, private containerName: string) {}

  private fail(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.stopping) this.callbacks.failed(error);
  }

  private async launch(): Promise<void> {
    const child = this.child = spawn("docker", ["start", "--attach", "--interactive", this.containerName], { stdio: "pipe" });
    child.on("error", (e) => this.fail(e));
    child.on("close", (code, signal) => this.fail(exitError(code ?? signal, this.stderrTail)));
    child.stdin.on("error", (e) => this.fail(e));
    const diagnostic = (chunk: Buffer) => {
      this.callbacks.stderr(chunk);
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-64 * 1024);
      if (this.stderrTail.includes("opencode server listening on")) this.serverReady = true;
    };
    child.stderr.on("data", diagnostic);
    const ready = new Promise<void>((resolve) => { this.prepared = resolve; });
    void readLines(child.stdout, (line) => {
      const base = new RegExp(`^${BASE_COMMIT_MARKER} ([0-9a-f]{40,64})$`).exec(line);
      if (!this.baseCommit && base) { this.baseCommit = base[1]; this.prepared?.(); return; }
      if (!this.baseCommit || this.spec.agent.kind === "opencode") diagnostic(Buffer.from(line + "\n"));
      else this.accept(line);
    }).catch((e) => this.fail(e));
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([ready, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Workspace preparation timed out")), 120_000);
      })]);
    } finally { clearTimeout(timer); }
  }

  private accept(raw: string): void {
    let r: Json;
    try { r = JSON.parse(raw); } catch { this.callbacks.record(raw); return; }
    if (!r || typeof r !== "object" || Array.isArray(r)) { this.callbacks.record(raw); return; }
    const codex = this.spec.agent.kind === "codex";
    if (r.id !== undefined && (codex ? !r.method : r.type === "response")) {
      const p = this.pending.get(r.id);
      if (p) {
        this.pending.delete(r.id);
        clearTimeout(p.timer);
        if (r.error || r.success === false) p.reject(new Error(`agent RPC failed: ${JSON.stringify(r.error)}`));
        else p.resolve(codex ? r.result : r);
      }
    }
    if (codex && r.method === "account/chatgptAuthTokens/refresh") {
      this.fail(new Error("Credential renewal required on the host"));
      return;
    }
    const question = codex ? r.id !== undefined && !!r.method
      : this.spec.agent.kind === "claude-code" ? r.type === "control_request"
      : this.spec.agent.kind === "pi" ? r.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(r.method)
      : r.type === "question.asked" && r.properties?.sessionID === this.sessionId;
    if (question) {
      const id = String(this.spec.agent.kind === "opencode" ? r.properties.id : r.request_id ?? r.id);
      this.questions.set(id, r);
      this.callbacks.question({ id, request: r });
    }
    const mapped = codex ? codexRecord(r) : undefined;
    this.callbacks.record(raw, codex ? JSON.stringify(mapped ?? {}) : undefined);
  }

  private write(record: Json): void {
    if (!this.child?.stdin.writable) throw new Error("agent stdin is closed");
    this.child.stdin.write(JSON.stringify(record) + "\n");
  }

  private rpc(method: string, params: Json = {}): Promise<Json> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write(this.spec.agent.kind === "pi" ? { id, type: method, ...params } : { id, method, params });
      } catch (e) {
        clearTimeout(timer); this.pending.delete(id); reject(e);
      }
    });
  }

  private async http(path: string, body?: unknown): Promise<Json> {
    const args = ["exec", "-i", this.containerName, "curl", "--fail-with-body", "-sS", "--max-time", "15",
      "-H", "content-type: application/json"];
    if (body !== undefined) args.push("-X", "POST", "--data-binary", "@-");
    args.push(`http://127.0.0.1:4096${path}?directory=${encodeURIComponent(WORKSPACE_DIR)}`);
    return new Promise((resolve, reject) => {
      const child = execFile("docker", args, { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        if (error) reject(new Error(`OpenCode ${path} request failed (${error.code})`));
        else { try { resolve(stdout ? JSON.parse(stdout) : {}); } catch (e) { reject(e); } }
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  async start(): Promise<void> {
    await this.launch();
    if (this.stopping) throw new Error("session stopped");
    const model = this.spec.agent.model;
    switch (this.spec.agent.kind) {
      case "claude-code":
        break;
      case "codex": {
        await this.rpc("initialize", { clientInfo: { name: "gauge", version: "0.0.0" }, capabilities: { experimentalApi: true } });
        this.write({ method: "initialized" });
        const r = await this.rpc("thread/start", { model, cwd: WORKSPACE_DIR, approvalPolicy: "never", sandbox: "danger-full-access" });
        this.sessionId = r.thread.id;
        break;
      }
      case "pi": {
        const r = await this.rpc("get_state");
        this.sessionId = r.data.sessionId;
        break;
      }
      case "opencode": {
        const deadline = Date.now() + 60_000;
        while (!this.serverReady) {
          if (this.child?.exitCode !== null || Date.now() > deadline) throw new Error("OpenCode did not become ready");
          await sleep(100);
        }
        if (!(await this.http("/global/health")).healthy) throw new Error("OpenCode health check failed");
        this.sessionId = (await this.http("/session", { title: "Gauge session" })).id;
        const stream = this.eventStream = spawn("docker", ["exec", this.containerName, "curl", "-sSN",
          `http://127.0.0.1:4096/event?directory=${encodeURIComponent(WORKSPACE_DIR)}`], { stdio: "pipe" });
        stream.on("error", (e) => this.fail(e));
        stream.stderr.on("data", this.callbacks.stderr);
        let connected!: () => void;
        const ready = new Promise<void>((r) => { connected = r; });
        void readLines(stream.stdout, (line) => {
          if (line.startsWith("data:")) {
            const raw = line.slice(5).trimStart();
            if (raw.includes('"server.connected"')) connected();
            this.accept(raw);
          }
        }).then(() => { if (!this.stopping) this.fail(new Error("OpenCode event stream disconnected")); })
          .catch((e) => { if (!this.stopping) this.fail(e); });
        let timer: NodeJS.Timeout | undefined;
        try { await Promise.race([ready, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("OpenCode event stream connection timed out")), 15_000);
        })]); } finally { clearTimeout(timer); }
        break;
      }
    }
  }

  async prompt(text: string): Promise<void> {
    switch (this.spec.agent.kind) {
      case "claude-code": this.write({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: this.sessionId ?? "" }); break;
      case "codex": await this.rpc("turn/start", { threadId: this.sessionId, input: [{ type: "text", text, text_elements: [] }] }); break;
      case "pi": await this.rpc("prompt", { message: text }); break;
      case "opencode": {
        const model = splitModel(this.spec.agent.model);
        await this.http(`/session/${this.sessionId}/prompt_async`, { model: { providerID: model.provider, modelID: model.model }, agent: "build", parts: [{ type: "text", text }] });
      }
    }
  }

  async answer(id: string, answer: unknown): Promise<void> {
    const q = this.questions.get(id);
    if (!q) throw new Error("question is no longer pending");
    switch (this.spec.agent.kind) {
      case "claude-code": this.write({ type: "control_response", response: { subtype: "success", request_id: q.request_id, response: answer } }); break;
      case "codex": this.write({ id: q.id, result: answer }); break;
      case "pi": this.write({ type: "extension_ui_response", id: q.id, ...(answer as Json) }); break;
      case "opencode": await this.http(`/question/${encodeURIComponent(id)}/reply`, { answers: answer }); break;
    }
    this.questions.delete(id);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.fail(new Error("session stopped"));
    this.prepared?.();
    await promisify(execFile)("docker", ["stop", "--time", "2", this.containerName], { timeout: 15_000 });
    this.eventStream?.kill();
    this.child?.kill();
  }
}
