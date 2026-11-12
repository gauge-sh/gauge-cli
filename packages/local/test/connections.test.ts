import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { validateGatewayConnections, workerEnvironment } from "../src/connections.js";
import { prepareGateway } from "../src/gateway.js";
import { DockerCli, type ContainerSpec } from "../src/docker.js";
import { startSession, stopSession } from "../src/session.js";
import type { LaunchRecord } from "../src/types.js";
import { spec } from "./fakes.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn }));
vi.mock("node:net", async (original) => { const net = await original<typeof import("node:net")>(); return { ...net, createConnection: vi.fn(net.createConnection) }; });
afterEach(() => vi.restoreAllMocks());
const connection = { name: "example", origin: "https://api.example.com", header: "Authorization", value: "Bearer fixture-connection-secret" };
const fixture = { version: 1 as const, searches: [], pages: [] };
const gateway = { image: "gateway:test", fixture, digest: `sha256:${createHash("sha256").update(JSON.stringify(fixture)).digest("hex")}` };

it("validates and canonicalizes credentials without mutating input", () => {
  expect(validateGatewayConnections([{ ...connection, origin: "https://API.example.com:443/" }])[0].origin).toBe(connection.origin);
  expect(connection.origin).toBe("https://api.example.com");
});
it.each([
  { origin: "https://192.0.2.1" }, { origin: "https://[::1]" },
  { origin: "https://*.example.com" }, { origin: "https://%61pi.example.com" }, { origin: "https://api.example.com:" }, { origin: "http://api.example.com" }, { origin: "https://api.example.com:444" },
  { origin: "https://api.example.com/path" }, { origin: "https://api.example.com?" },
  { origin: "https://api.example.com#" }, { origin: "https://user@api.example.com" },
  { origin: "https://api.example.com\\other" }, { header: "Host" }, { header: "Connection" },
  { header: "X-Forwarded-Anything" }, { header: "Proxy-Authorization" }, { header: "Content-Length" },
  { header: "bad header" }, { value: "secret\r\nInjected: yes" }, { value: "" },
  { value: "secret\tvalue" }, { value: "secret\u007f" }, { value: "secreté" },
])("rejects unsafe descriptors without echoing credential values", (override) => {
  try { validateGatewayConnections([{ ...connection, ...override }]); throw new Error("not rejected"); }
  catch (error) {
    expect(String(error)).not.toContain(connection.value);
    expect(String(error)).not.toContain("not rejected");
    if (override.value) expect(String(error)).not.toContain(override.value);
  }
});
it("rejects duplicate names and origin/header assignments", () => {
  expect(() => validateGatewayConnections([connection, connection])).toThrow("duplicate");
  expect(() => validateGatewayConnections([connection, { ...connection, name: "other", header: "authorization" }])).toThrow("Duplicate");
});
it("removes arbitrarily named connection source variables from worker environment", () => {
  expect(workerEnvironment({ PATH: "/bin", ODD_NAME: connection.value, SOME_API_KEY: "another" }, ["ODD_NAME"]))
    .toEqual({ PATH: "/bin" });
});
it("mounts the connection file read-only into only the gateway", async () => {
  const root = await mkdtemp(join(tmpdir(), "gauge-"));
  try {
    const launch: LaunchRecord = { version: 2, containerName: "session", credentialDir: root, socketPath: join(root, "sock"), spec: spec({ gateway }), gatewayName: "gateway", trustContainerName: "trust", hasGatewayConnections: true,
      workload: { name: "session", image: "test", labels: {}, mounts: [], env: {}, command: [] } };
    const created: ContainerSpec[] = [];
    const docker = new DockerCli();
    vi.spyOn(docker, "create").mockImplementation(async (s) => { created.push(s); return "created"; });
    vi.spyOn(docker, "start").mockResolvedValue();
    vi.spyOn(docker, "ready").mockResolvedValue(true);
    vi.spyOn(docker, "copy").mockImplementation(async (_name, source, target) => { await writeFile(target, source.endsWith("connections-ready") ? "1\n" : "-----BEGIN CERTIFICATE-----\nfixture\n"); });
    vi.spyOn(docker, "remove").mockResolvedValue();
    await prepareGateway(launch, () => false, docker);
    expect(created[0].mounts).toContainEqual({ type: "bind", source: join(root, "connections.json"), target: "/gateway/connections.json", readonly: true });
    expect(JSON.stringify(created[1])).not.toContain("connections.json");
    expect(JSON.stringify(launch.workload)).not.toContain("connections.json");
    expect(JSON.stringify(created)).not.toContain(connection.value);
    vi.mocked(docker.copy).mockRejectedValue(new Error("missing marker"));
    const oldLaunch = { ...launch, workload: { ...launch.workload!, mounts: [], env: {} } };
    await expect(prepareGateway(oldLaunch, () => false, docker)).rejects.toThrow("does not support local connections");
    expect(oldLaunch.workload.mounts).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("keeps connection values in a private temporary file and cleans up on launch failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "gauge-c-"));
  const directory = join(root, "session");
  const runtimeDirectory = join(root, "runtime");
  let inspected = false;
  spawn.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => { void (async () => {
      const record = JSON.parse(await readFile(join(directory, "session.json"), "utf8"));
      expect(record.hasGatewayConnections).toBe(true);
      expect(JSON.stringify(record)).not.toContain(connection.value);
      expect(JSON.stringify(record)).not.toContain("ODD_NAME");
      expect((await stat(record.credentialDir)).mode & 0o777).toBe(0o700);
      const path = join(record.credentialDir, "connections.json");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, connections: [connection] });
      inspected = true;
      child.emit("error", new Error("launch failed"));
    })().catch((error) => child.emit("error", error)); });
    return child;
  });
  try {
    await expect(startSession({ directory, runtimeDirectory, spec: spec({ gateway }), credentials: { env: { CLAUDE_CODE_OAUTH_TOKEN: "fixture-only" }, homeDir: root }, gatewayConnections: [connection], connectionEnvNames: ["ODD_NAME"] })).rejects.toThrow("launch failed");
    expect(inspected).toBe(true);
    expect(await readdir(runtimeDirectory)).toEqual([]);
    expect(await readFile(join(directory, "status.json"), "utf8")).not.toContain(connection.value);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("removes the private connection file during terminal recovery cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "gauge-c-"));
  const runtime = await mkdtemp(join(tmpdir(), "gauge-"));
  const containerName = "gauge-session-12345678-1234-1234-1234-123456789abc";
  vi.spyOn(DockerCli.prototype, "assertSessionOwner").mockResolvedValue();
  vi.spyOn(DockerCli.prototype, "assertCompanionOwner").mockResolvedValue();
  vi.spyOn(DockerCli.prototype, "stop").mockResolvedValue();
  vi.spyOn(DockerCli.prototype, "remove").mockResolvedValue();
  vi.spyOn(DockerCli.prototype, "logs").mockResolvedValue("");
  try {
    await writeFile(join(runtime, "connections.json"), JSON.stringify({ version: 1, connections: [connection] }), { mode: 0o600 });
    await writeFile(join(root, "session.json"), JSON.stringify({ version: 2, containerName, credentialDir: runtime, socketPath: join(runtime, "control.sock"), hasGatewayConnections: true, gatewayName: `${containerName}-gateway`, trustContainerName: `${containerName}-trust`, spec: spec({ workspace: null }) }));
    await writeFile(join(root, "status.json"), JSON.stringify({ state: "failed", turn: 0, cleanupPending: true }));
    vi.mocked(createConnection).mockImplementationOnce(() => { throw Object.assign(new Error("socket absent"), { code: "ENOENT" }); });
    await stopSession(root);
    await expect(stat(runtime)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(runtime, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
