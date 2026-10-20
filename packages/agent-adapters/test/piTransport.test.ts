import { describe, expect, it } from "vitest";
import { PiRpcTransport, type DuplexProcess } from "../src/index.js";
class FakeDuplex implements DuplexProcess {
  readonly writes: string[] = [];
  private chunks: (Buffer | null)[] = [];
  private waiters: ((value: Buffer | null) => void)[] = [];
  private exitResolve!: (value: {
    code: number | null;
    signal: string | null;
  }) => void;
  private readonly exit = new Promise<{
    code: number | null;
    signal: string | null;
  }>((resolve) => {
    this.exitResolve = resolve;
  });

  constructor(
    private readonly onCommand?: (command: Record<string, unknown>) => void,
    private readonly beforeWrite?: () => Promise<void>,
  ) {}

  pushRaw(value: string): void {
    this.push(Buffer.from(value));
  }

  pushJson(value: unknown): void {
    this.pushRaw(`${JSON.stringify(value)}\n`);
  }

  private push(value: Buffer | null): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.chunks.push(value);
  }

  async *stdout(): AsyncIterable<Buffer> {
    while (true) {
      const queued = this.chunks.shift();
      const value =
        queued !== undefined
          ? queued
          : await new Promise<Buffer | null>((resolve) =>
              this.waiters.push(resolve),
            );
      if (value === null) return;
      yield value;
    }
  }

  async write(data: string): Promise<void> {
    this.writes.push(data);
    this.onCommand?.(JSON.parse(data));
    await this.beforeWrite?.();
  }

  closeStdin(): void {
    this.push(null);
    this.exitResolve({ code: 0, signal: null });
  }

  wait() {
    return this.exit;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.push(null);
    this.exitResolve({ code: null, signal });
  }

  stderrTail(): string {
    return "";
  }
}

describe("Pi strict RPC transport", () => {
  it("correlates out-of-order responses and preserves U+2028 within one LF record", async () => {
    const process = new FakeDuplex();
    const rpc = new PiRpcTransport(process);
    const first = rpc.request("get_state");
    const second = rpc.request("get_session_stats");
    await Promise.resolve();
    const commands = process.writes.map((line) => JSON.parse(line));
    process.pushRaw(
      `${JSON.stringify({ type: "message_start", text: "before\u2028after" })}\n`,
    );
    process.pushJson({
      type: "response",
      id: commands[1].id,
      command: "get_session_stats",
      success: true,
    });
    process.pushJson({
      type: "response",
      id: commands[0].id,
      command: "get_state",
      success: true,
    });
    await expect(first).resolves.toMatchObject({ command: "get_state" });
    await expect(second).resolves.toMatchObject({
      command: "get_session_stats",
    });
    const event = await rpc.nextEvent();
    expect(event.raw).toContain("before after");
    process.closeStdin();
  });

  it("preserves malformed records without desynchronizing the next response", async () => {
    const process = new FakeDuplex();
    const rpc = new PiRpcTransport(process);
    const request = rpc.request("get_state");
    await Promise.resolve();
    const command = JSON.parse(process.writes[0]);
    process.pushRaw("{malformed}\n");
    process.pushJson({
      type: "response",
      id: command.id,
      command: "get_state",
      success: true,
    });
    expect((await rpc.nextEvent()).parsed).toBeNull();
    await expect(request).resolves.toMatchObject({ success: true });
    process.closeStdin();
  });

  it("fails a pending request on a disconnected unterminated record", async () => {
    const process = new FakeDuplex();
    const rpc = new PiRpcTransport(process);
    const request = rpc.request("get_state");
    process.pushRaw('{"type":');
    process.closeStdin();
    await expect(request).rejects.toThrow(/unterminated record/);
  });

  it("fails closed when one unterminated record exceeds the 1 MiB bound", async () => {
    const process = new FakeDuplex();
    const rpc = new PiRpcTransport(process);
    const request = rpc.request("get_state");
    process.pushRaw("x".repeat(1024 * 1024 + 1));
    await expect(request).rejects.toThrow(/exceeded 1 MiB/);
    process.closeStdin();
  });

  it("observes a response timeout while the process write is pending", async () => {
    let releaseWrite!: () => void;
    const writeBlocked = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const fakeProcess = new FakeDuplex(undefined, () => writeBlocked);
    const rpc = new PiRpcTransport(fakeProcess);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const request = rpc.request("abort_bash", {}, 10);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(unhandled).toEqual([]);
      releaseWrite();
      await expect(request).rejects.toThrow(/abort_bash timed out/);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      releaseWrite();
      fakeProcess.closeStdin();
    }
  });
});
