import type { DuplexProcess } from "./types.js";

type JsonRecord = Record<string, unknown>;
const RPC_RECORD_MAX_BYTES = 1024 * 1024;
const RPC_BUFFER_MAX_BYTES = 2 * RPC_RECORD_MAX_BYTES;
const RPC_REQUEST_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(record: JsonRecord, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}
interface RpcRecord {
  raw: string;
  parsed: unknown;
}

class AsyncRecordQueue {
  private records: RpcRecord[] = [];
  private waiters: ((value: RpcRecord) => void)[] = [];
  private failure?: Error;

  push(record: RpcRecord): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(record);
    else this.records.push(record);
  }

  clear(): void {
    this.records.length = 0;
  }

  fail(error: Error): void {
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter({
        raw: "",
        parsed: { type: "transport_error", error: error.message },
      });
    }
  }

  async next(): Promise<RpcRecord> {
    const record = this.records.shift();
    if (record) return record;
    if (this.failure) throw this.failure;
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

interface PendingRequest {
  command: string;
  resolve: (value: JsonRecord) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class PiRpcTransport {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly events = new AsyncRecordQueue();
  private nextId = 0;
  private closed?: Error;
  private readonly reader: Promise<void>;

  constructor(private readonly process: DuplexProcess) {
    this.reader = this.readLoop();
  }

  private async readLoop(): Promise<void> {
    let buffered = Buffer.alloc(0);
    try {
      for await (const chunk of this.process.stdout()) {
        if (buffered.length + chunk.length > RPC_BUFFER_MAX_BYTES) {
          throw new Error("Pi RPC stdout buffer exceeded 2 MiB");
        }
        buffered = Buffer.concat([buffered, chunk]);
        let lf = buffered.indexOf(0x0a);
        while (lf !== -1) {
          if (lf > RPC_RECORD_MAX_BYTES) {
            throw new Error("Pi RPC record exceeded 1 MiB");
          }
          let recordBytes = buffered.subarray(0, lf);
          buffered = buffered.subarray(lf + 1);
          if (recordBytes.at(-1) === 0x0d)
            recordBytes = recordBytes.subarray(0, -1);
          if (recordBytes.length > 0) this.accept(recordBytes.toString("utf8"));
          lf = buffered.indexOf(0x0a);
        }
        if (buffered.length > RPC_RECORD_MAX_BYTES) {
          throw new Error("Pi RPC unterminated record exceeded 1 MiB");
        }
      }
      if (buffered.length > 0) {
        throw new Error(
          "Pi RPC stdout disconnected with an unterminated record",
        );
      }
      throw new Error("Pi RPC stdout disconnected");
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private accept(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.events.push({ raw, parsed: null });
      return;
    }
    this.events.push({ raw, parsed });
    if (!isRecord(parsed) || parsed.type !== "response") return;
    const id = stringAt(parsed, "id");
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (parsed.command !== pending.command) {
      pending.reject(new Error(`Pi RPC response command mismatch for ${id}`));
    } else if (parsed.success !== true) {
      pending.reject(
        new Error(
          `Pi RPC ${pending.command} failed: ${String(parsed.error ?? "unknown error")}`,
        ),
      );
    } else {
      pending.resolve(parsed);
    }
  }

  private close(error: Error): void {
    if (this.closed) return;
    this.closed = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.events.fail(error);
  }

  async request(
    command: string,
    fields: JsonRecord = {},
    timeoutMs = RPC_REQUEST_TIMEOUT_MS,
  ): Promise<JsonRecord> {
    if (this.closed) throw this.closed;
    const id = `gauge-${++this.nextId}`;
    const response = new Promise<JsonRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC ${command} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { command, resolve, reject, timer });
    });
    void response.catch(() => {});
    await this.process.write(
      `${JSON.stringify({ id, type: command, ...fields })}\n`,
    );
    return response;
  }

  nextEvent(): Promise<RpcRecord> {
    return this.events.next();
  }

  discardEvents(): void {
    this.events.clear();
  }

  closeStdin(): void {
    this.process.closeStdin();
  }

  wait(): Promise<{ code: number | null; signal: string | null }> {
    return this.process.wait();
  }

  kill(signal: NodeJS.Signals): void {
    this.process.kill(signal);
  }

  stderrTail(): string {
    return this.process.stderrTail();
  }

  waitForReader(): Promise<void> {
    return this.reader;
  }
}
