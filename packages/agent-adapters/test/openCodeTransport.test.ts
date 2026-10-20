import { describe, expect, it } from "vitest";
import { OpenCodeSseTransport, type DuplexProcess } from "../src/index.js";
class FakeDuplex implements DuplexProcess {
  private chunks: Buffer[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;
  private exitResolve!: (value: {
    code: number | null;
    signal: string | null;
  }) => void;
  private readonly exited = new Promise<{
    code: number | null;
    signal: string | null;
  }>((resolve) => {
    this.exitResolve = resolve;
  });

  push(value: string): void {
    this.chunks.push(Buffer.from(value));
    this.waiters.shift()?.();
  }

  close(signal: string | null = null): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter();
    this.exitResolve({ code: signal ? null : 0, signal });
  }

  async *stdout(): AsyncIterable<Buffer> {
    while (!this.closed || this.chunks.length > 0) {
      const chunk = this.chunks.shift();
      if (chunk) yield chunk;
      else await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  write(): Promise<void> {
    return Promise.resolve();
  }
  closeStdin(): void {}
  wait() {
    return this.exited;
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.close(signal);
  }
  stderrTail(): string {
    return "";
  }
}

function sse(records: string[]): string {
  return records.map((record) => `data: ${record}\n\n`).join("");
}

it("preserves malformed SSE data and rejects oversized records", async () => {
  const malformedProcess = new FakeDuplex();
  const malformed = new OpenCodeSseTransport(malformedProcess);
  malformedProcess.push("data: {not-json}\n\n");
  await expect(malformed.nextEvent()).resolves.toEqual({
    raw: "{not-json}",
    parsed: null,
  });
  malformedProcess.close();

  const oversizedProcess = new FakeDuplex();
  const oversized = new OpenCodeSseTransport(oversizedProcess);
  oversizedProcess.push(`data: ${"x".repeat(8 * 1024 * 1024 + 1)}`);
  await expect(oversized.nextEvent()).rejects.toThrow(/exceeded 8 MiB/);
  oversizedProcess.close();
});
describe("OpenCode SSE burst backpressure", () => {
  it("delivers 3000 small records from one stdout chunk to an active consumer", async () => {
    const process = new FakeDuplex();
    const transport = new OpenCodeSseTransport(process);
    const first = transport.nextEvent();
    process.push(
      sse(Array.from({ length: 3000 }, (_, i) => JSON.stringify({ i }))),
    );
    expect((await first).parsed).toEqual({ i: 0 });
    for (let i = 1; i < 3000; i++)
      expect((await transport.nextEvent()).parsed).toEqual({ i });
    transport.kill();
    await transport.waitForReader();
  });
});

it("unblocks a capacity-waiting SSE producer on cancel", async () => {
  const process = new FakeDuplex();
  const transport = new OpenCodeSseTransport(process);
  process.push(
    sse(Array.from({ length: 3000 }, (_, i) => JSON.stringify({ i }))),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  transport.kill("SIGTERM");
  await transport.waitForReader();
  await expect(transport.nextEvent()).rejects.toThrow("transport stopped");
});
