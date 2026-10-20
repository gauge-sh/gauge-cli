import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { getSessionStatus, stopSession, SessionNotFoundError, SessionUnavailableError } from "../src/session.js";
import { DockerCli } from "../src/docker.js";

it("identifies an absent session through the public error type", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gauge-missing-"));
  try { await expect(getSessionStatus(directory)).rejects.toBeInstanceOf(SessionNotFoundError); }
  finally { await rm(directory, { recursive: true, force: true }); }
});

async function withOwner(reply: (socket: Socket) => void, test: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "gauge-owner-"));
  const socketPath = join(directory, "control.sock");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", () => reply(socket));
  });
  try {
    await writeFile(join(directory, "session.json"), JSON.stringify({ version: 1, socketPath, containerName: "must-not-touch", credentialDir: directory }));
    await writeFile(join(directory, "status.json"), JSON.stringify({ state: "running", turn: 1, driverPid: process.pid, updatedAt: new Date().toISOString() }));
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    await test(directory);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

it("does not turn a malformed reply, disconnection, or rejected cancel into orphan cleanup", async () => {
  const stop = vi.spyOn(DockerCli.prototype, "stop").mockResolvedValue();
  const remove = vi.spyOn(DockerCli.prototype, "remove").mockResolvedValue();
  try {
    for (const reply of [(s: Socket) => s.end("invalid JSON\n"), (s: Socket) => s.end()]) {
      await withOwner(reply, async (directory) => {
        await expect(getSessionStatus(directory)).rejects.toBeInstanceOf(SessionUnavailableError);
        await expect(stopSession(directory)).rejects.toBeInstanceOf(SessionUnavailableError);
      });
    }
    await withOwner((s) => s.end('{"accepted":false,"error":"session is closing"}\n'), async (directory) => {
      await expect(stopSession(directory)).rejects.toThrow("session is closing");
    });
    expect(stop).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); }
});

it("treats missing sockets with a live or unknown owner as uncertain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gauge-unreachable-"));
  try {
    await writeFile(join(directory, "session.json"), JSON.stringify({ version: 1, socketPath: join(directory, "missing.sock") }));
    for (const driverPid of [process.pid, undefined]) {
      await writeFile(join(directory, "status.json"), JSON.stringify({ state: "running", turn: 1, driverPid }));
      await expect(getSessionStatus(directory)).rejects.toBeInstanceOf(SessionUnavailableError);
      await expect(stopSession(directory)).rejects.toBeInstanceOf(SessionUnavailableError);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("keeps cleanup with a live owner after transport and cancellation deadlines", { timeout: 45_000 }, async () => {
  const stop = vi.spyOn(DockerCli.prototype, "stop").mockResolvedValue();
  const remove = vi.spyOn(DockerCli.prototype, "remove").mockResolvedValue();
  try {
    await Promise.all([
      withOwner(() => {}, async (directory) => {
        await expect(getSessionStatus(directory)).rejects.toBeInstanceOf(SessionUnavailableError);
      }),
      withOwner(() => {}, async (directory) => {
        await expect(stopSession(directory)).rejects.toBeInstanceOf(SessionUnavailableError);
      }),
      withOwner((s) => s.end('{"accepted":true}\n'), async (directory) => {
        await expect(stopSession(directory)).rejects.toThrow("driver retains ownership");
      }),
    ]);
    expect(stop).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); }
});

it("observes a terminal result saved while its status connection is closing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gauge-status-"));
  const socketPath = join(directory, "control.sock");
  const final = { state: "completed", turn: 1, updatedAt: new Date().toISOString(), artifacts: { diff: "diff.patch" } };
  const server = createServer((socket) => {
    socket.on("data", () => {
      void writeFile(join(directory, "status.json"), JSON.stringify(final)).then(() => socket.end());
    });
  });
  try {
    await writeFile(join(directory, "session.json"), JSON.stringify({ version: 1, socketPath }));
    await writeFile(join(directory, "status.json"), JSON.stringify({ ...final, state: "running" }));
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    expect(await getSessionStatus(directory)).toEqual(final);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

it("refuses orphan cleanup with an unrelated container or unsafe runtime path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gauge-ownership-"));
  const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
  const stop = vi.spyOn(DockerCli.prototype, "stop").mockResolvedValue();
  try {
    await writeFile(join(directory, "status.json"), JSON.stringify({ state: "running", turn: 1, driverPid: 999999 }));
    await writeFile(join(directory, "session.json"), JSON.stringify({ version: 1, socketPath: join(directory, "control.sock"), containerName: "unrelated", credentialDir: directory }));
    await expect(stopSession(directory)).rejects.toThrow("ownership record");
    expect(stop).not.toHaveBeenCalled();
  } finally { kill.mockRestore(); vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); }
});

it("requires both Gauge's container label and matching credential mount for recovery", async () => {
  const run = vi.spyOn(DockerCli.prototype as unknown as { run(args: string[]): Promise<string> }, "run");
  const engine = new DockerCli();
  const name = "gauge-session-12345678-1234-1234-1234-123456789abc";
  try {
    run.mockResolvedValue(JSON.stringify([{ Config: { Labels: {} }, Mounts: [] }]));
    await expect(engine.assertSessionOwner(name, "/tmp/gauge-abc")).rejects.toThrow("ownership");
    run.mockResolvedValue(JSON.stringify([{ Config: { Labels: { "sh.gauge.session": name } }, Mounts: [{ Source: "/different/workspace", Destination: "/gauge/session" }] }]));
    await expect(engine.assertSessionOwner(name, "/tmp/gauge-abc")).rejects.toThrow("ownership");
    run.mockResolvedValue(JSON.stringify([{ Config: { Labels: { "sh.gauge.session": name } }, Mounts: [{ Source: "/tmp/gauge-abc/workspace", Destination: "/gauge/session" }] }]));
    await expect(engine.assertSessionOwner(name, "/tmp/gauge-abc")).resolves.toBeUndefined();
  } finally { vi.restoreAllMocks(); }
});
