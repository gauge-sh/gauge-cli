import type { DuplexProcess } from "./types.js";

const SSE_RECORD_MAX_BYTES = 8 * 1024 * 1024;
const SSE_BUFFER_MAX_BYTES = 2 * SSE_RECORD_MAX_BYTES;
const SSE_QUEUE_MAX_BYTES = 4 * SSE_RECORD_MAX_BYTES;
const SSE_QUEUE_MAX_RECORDS = 2048;
const SSE_EVENT_TIMEOUT_MS = 60_000;
const SHUTDOWN_GRACE_MS = 2_000;
const SSE_REMOTE_CONTROL_MS = 15_000;

async function boundedSseWork<T>(
  work: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface SseRecord {
  raw: string;
  parsed: unknown;
}

class AsyncRecordQueue {
  private records: SseRecord[] = [];
  private queuedBytes = 0;
  private waiters: Array<{
    resolve: (record: SseRecord) => void;
    reject: (error: Error) => void;
  }> = [];
  private failure?: Error;

  private capacityWaiter?: () => void;

  async push(record: SseRecord): Promise<void> {
    const bytes = Buffer.byteLength(record.raw);
    if (bytes > SSE_QUEUE_MAX_BYTES)
      throw new Error("OpenCode SSE record exceeds queue byte bound");
    while (
      !this.failure &&
      (this.records.length >= SSE_QUEUE_MAX_RECORDS ||
        this.queuedBytes + bytes > SSE_QUEUE_MAX_BYTES)
    ) {
      await new Promise<void>((resolve) => {
        this.capacityWaiter = resolve;
      });
    }
    if (this.failure) throw this.failure;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(record);
    else {
      this.records.push(record);
      this.queuedBytes += bytes;
    }
  }

  private capacityAvailable(): void {
    const wake = this.capacityWaiter;
    this.capacityWaiter = undefined;
    wake?.();
  }

  clear(): void {
    this.records.length = 0;
    this.queuedBytes = 0;
    this.capacityAvailable();
  }

  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.clear();
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  next(timeoutMs: number): Promise<SseRecord> {
    const record = this.records.shift();
    if (record) {
      this.queuedBytes -= Buffer.byteLength(record.raw);
      this.capacityAvailable();
      return Promise.resolve(record);
    }
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("OpenCode SSE event timed out"));
      }, timeoutMs);
      timer.unref?.();
      waiter.resolve = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      waiter.reject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      this.waiters.push(waiter);
    });
  }
}

export class OpenCodeSseTransport {
  private readonly records = new AsyncRecordQueue();
  private readonly reader: Promise<void>;
  private cleanup?: Promise<void>;

  constructor(private readonly process: DuplexProcess) {
    this.reader = this.readLoop();
  }

  private async readLoop(): Promise<void> {
    let buffered = Buffer.alloc(0);
    let eventLines: string[] = [];
    let eventBytes = 0;
    try {
      for await (const chunk of this.process.stdout()) {
        if (buffered.length + chunk.length > SSE_BUFFER_MAX_BYTES) {
          throw new Error("OpenCode SSE pending buffer exceeded 16 MiB");
        }
        buffered = Buffer.concat([buffered, chunk]);
        let lf = buffered.indexOf(0x0a);
        while (lf !== -1) {
          if (lf > SSE_RECORD_MAX_BYTES) {
            throw new Error("OpenCode SSE line exceeded 8 MiB");
          }
          let lineBytes = buffered.subarray(0, lf);
          buffered = buffered.subarray(lf + 1);
          if (lineBytes.at(-1) === 0x0d) lineBytes = lineBytes.subarray(0, -1);
          const line = lineBytes.toString("utf8");
          if (line === "") {
            await this.accept(eventLines);
            eventLines = [];
            eventBytes = 0;
          } else {
            eventBytes += lineBytes.length;
            if (eventBytes > SSE_RECORD_MAX_BYTES) {
              throw new Error("OpenCode SSE event exceeded 8 MiB");
            }
            eventLines.push(line);
          }
          lf = buffered.indexOf(0x0a);
        }
        if (buffered.length > SSE_RECORD_MAX_BYTES) {
          throw new Error("OpenCode SSE unterminated line exceeded 8 MiB");
        }
      }
      if (buffered.length > 0 || eventLines.length > 0) {
        throw new Error("OpenCode SSE disconnected with an unterminated event");
      }
      throw new Error("OpenCode SSE disconnected");
    } catch (error) {
      this.records.fail(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private async accept(lines: string[]): Promise<void> {
    if (lines.length === 0 || lines.every((line) => line.startsWith(":"))) {
      return;
    }
    const data = lines
      .filter((line) => line === "data" || line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    const raw = data || lines.join("\n");
    let parsed: unknown = null;
    if (data) {
      try {
        parsed = JSON.parse(data);
      } catch {
      }
    }
    await this.records.push({ raw, parsed });
  }

  fail(error: Error): void {
    this.records.fail(error);
  }

  nextEvent(timeoutMs = SSE_EVENT_TIMEOUT_MS): Promise<SseRecord> {
    return this.records.next(timeoutMs);
  }

  discardEvents(): void {
    this.records.clear();
  }

  kill(signal?: NodeJS.Signals): void {
    this.records.fail(new Error("OpenCode SSE transport stopped"));
    this.process.kill(signal);
  }

  async stop(): Promise<void> {
    if (this.process.terminate) {
      this.records.fail(new Error("OpenCode SSE transport stopped"));
      try {
        await boundedSseWork(
          this.process.terminate("SIGTERM", SSE_REMOTE_CONTROL_MS),
          SSE_REMOTE_CONTROL_MS,
          "OpenCode SSE termination was not confirmed",
        );
      } catch (error) {
        this.kill("SIGKILL");
        throw error;
      } finally {
        this.cleanup = boundedSseWork(
          Promise.all([this.reader, this.process.wait()]).then(() => {}),
          SSE_REMOTE_CONTROL_MS,
          "OpenCode SSE cleanup did not finish",
        );
        void this.cleanup.catch(() => {});
      }
      return;
    }
    this.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([this.reader, this.process.wait()]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("OpenCode SSE reader did not stop")),
            SHUTDOWN_GRACE_MS,
          );
        }),
      ]);
    } catch (error) {
      this.kill("SIGKILL");
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  waitForCleanup(): Promise<void> {
    return this.cleanup ?? Promise.resolve();
  }

  stderrTail(): string {
    return this.process.stderrTail();
  }

  waitForReader(): Promise<void> {
    return this.reader;
  }
}
