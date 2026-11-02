import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startSession, stopSession, getSessionStatus } from "../dist/index.js";
import type { LaunchRecord, SessionSpec } from "../src/types.js";
import { spec } from "./fakes.js";

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fixture = { version: 1 as const, searches: [], scopes: ["https://example.com/docs"], pages: [
  { url: "https://example.com/docs", body: "fixture ✓", status: 200, contentType: "text/plain" },
] };
const gateway: NonNullable<SessionSpec["gateway"]> = {
  image: process.env.GAUGE_GATEWAY_IMAGE ?? "ghcr.io/gauge-sh/gauge-gateway:0.1.0", fixture,
  digest: `sha256:${createHash("sha256").update(JSON.stringify(fixture)).digest("hex")}`,
};
async function session(test: (directory: string, launch: LaunchRecord) => Promise<void>, overrides: Partial<SessionSpec> = {}) {
  const root = await mkdtemp(join(tmpdir(), "gauge-gateway-test-"));
  const directory = join(root, "session");
  try {
    await startSession({ directory, runtimeDirectory: tmpdir(), spec: spec({ image: "gauge-session-fixture:test", workspace: null, prompt: { text: "HANG" }, gateway, ...overrides }), credentials: { env: { CLAUDE_CODE_OAUTH_TOKEN: "fixture-only" }, homeDir: root } });
    await test(directory, JSON.parse(await readFile(join(directory, "session.json"), "utf8")));
  } finally {
    await stopSession(directory).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}
async function wait(directory: string, state: string) {
  for (let n = 0; n < 300; n++) {
    const status = await getSessionStatus(directory);
    if (status.state === state) return status;
    if (["failed", "interrupted"].includes(status.state)) throw new Error(JSON.stringify(status));
    await sleep(100);
  }
  throw new Error(`Session did not reach ${state}`);
}
function absent(launch: LaunchRecord) {
  for (const name of [launch.containerName, launch.gatewayName!, launch.trustContainerName!])
    expect(docker("ps", "-aq", "--filter", `name=^/${name}$`)).toBe("");
}

describe.skipIf(process.env.GAUGE_DOCKER_FIXTURES !== "1")("transparent gateway lifecycle without inference", () => {
  it("intercepts trusted TLS in curl and Node, handles HEAD and scoped misses, and keeps private keys out of the workload", { timeout: 60_000 }, () => session(async (directory, launch) => {
    await wait(directory, "running");
    const curl = (...args: string[]) => docker("exec", launch.containerName, "curl", "--noproxy", "*", "--max-time", "10", "--resolve", "example.com:443:192.0.2.1", "-sS", ...args);
    expect(curl("https://example.com/docs")).toBe("fixture ✓");
    expect(curl("-I", "https://example.com/docs")).toMatch(/content-length: 11/i);
    expect(curl("-w", "%{http_code}", "https://example.com/docs/missing")).toContain("404");
    expect(curl("-X", "POST", "-w", "%{http_code}", "https://example.com/docs")).toContain("404");
    expect(docker("exec", launch.containerName, "node", "-e", "require('https').get('https://example.com/docs', {lookup: (_h,_o,cb)=>cb(null,[{address:'192.0.2.1',family:4}])}, r=>r.pipe(process.stdout)).on('error', e=>{console.error(e);process.exitCode=1})")).toBe("fixture ✓");
    const config = JSON.parse(docker("inspect", launch.containerName))[0];
    expect(config.HostConfig.NetworkMode).toBe(`container:${docker("inspect", "--format", "{{.Id}}", launch.gatewayName!)}`);
    expect(config.HostConfig.CapDrop).toContain("ALL");
    expect(config.Mounts.some((m: { Destination: string }) => m.Destination.includes("private"))).toBe(false);
    expect(docker("exec", launch.containerName, "cat", "/gauge/certs/gateway.crt")).not.toContain("PRIVATE KEY");
    await stopSession(directory);
    absent(launch);
    expect(await readFile(join(directory, "gateway.log"), "utf8")).toContain('"action": "blocked"');
  }));
  it("gateway death fails the attempt and removes every container", { timeout: 60_000 }, () => session(async (directory, launch) => {
    await wait(directory, "running");
    docker("kill", launch.gatewayName!);
    const status = await wait(directory, "failed");
    expect(status.detail).toContain("Gateway exited");
    expect(status.cleanupPending).toBe(false);
    absent(launch);
  }));
  it("rewrites HTTPS origins with verified upstream TLS and streams ordinary traffic", { timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "gauge-origin-"));
    const name = `gauge-test-origin-${randomUUID()}`;
    const routed = { ...fixture, origins: [
      { origin: "https://rewrite.example.com", upstream: "https://upstream.example.test" },
      { origin: "https://bad.example.com", upstream: "https://wrong.example.test" },
    ] };
    try {
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=upstream.example.test", "-addext", "subjectAltName=DNS:upstream.example.test", "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem")], { stdio: "ignore" });
      await copyFile(new URL("./gateway-origin.py", import.meta.url), join(root, "server.py"));
      docker("run", "-d", "--name", name, "--mount", `type=bind,source=${root},target=/origin,readonly`, "--entrypoint", "python", gateway.image, "/origin/server.py");
      const ip = docker("inspect", "--format", "{{(index .NetworkSettings.Networks \"bridge\").IPAddress}}", name);
      await session(async (directory, launch) => {
        await wait(directory, "running");
        // Trust only this test origin in this disposable gateway. Shipping
        // gateways retain mitmproxy's standard upstream verification defaults.
        docker("cp", join(root, "cert.pem"), `${launch.gatewayName}:/tmp/test-origin.pem`);
        docker("exec", "-u", "0", launch.gatewayName!, "python", "-c", "import certifi,sys; open(certifi.where(),'a').write(open('/tmp/test-origin.pem').read()); open('/etc/hosts','a').write('\\n'+sys.argv[1]+' upstream.example.test wrong.example.test\\n')", ip);
        const curl = (host: string, path: string, ...args: string[]) => docker("exec", launch.containerName, "curl", "--noproxy", "*", "--max-time", "10", "--resolve", `${host}:443:${host === "upstream.example.test" ? ip : "192.0.2.1"}`, "-sS", ...args, `https://${host}${path}`);
        expect(JSON.parse(curl("rewrite.example.com", "/a%2Fb?q=%2F"))).toEqual({ path: "/a%2Fb?q=%2F", host: "upstream.example.test" });
        expect(curl("bad.example.com", "/", "-w", "%{http_code}")).toContain("502");
        expect(JSON.parse(curl("upstream.example.test", "/ordinary"))).toEqual({ path: "/ordinary", host: "upstream.example.test" });
        expect(curl("rewrite.example.com", "/large", "-o", "/tmp/large", "-w", "%{size_download}")).toBe(String(12 * 1024 * 1024));
        try { curl("upstream.example.test", "/stream", "--max-time", "1", "--no-buffer"); throw new Error("Expected the slow stream to time out"); }
        catch (error) { expect(String((error as { stdout?: string }).stdout)).toContain("data: first"); }
      }, { gateway: { ...gateway, fixture: routed, digest: `sha256:${createHash("sha256").update(JSON.stringify(routed)).digest("hex")}` } });
    } finally {
      try { docker("rm", "-f", name); } finally { await rm(root, { recursive: true, force: true }); }
    }
  });
  it("does not remove gateway or workload when controller status is unavailable", { timeout: 60_000 }, () => session(async (directory, launch) => {
    const status = await wait(directory, "running");
    try {
      process.kill(status.driverPid!, "SIGKILL");
      await sleep(200);
      await expect(getSessionStatus(directory)).rejects.toMatchObject({ name: "SessionUnavailableError" });
      await expect(stopSession(directory)).rejects.toMatchObject({ name: "SessionUnavailableError" });
      for (const name of [launch.containerName, launch.gatewayName!])
        expect(docker("inspect", "--format", "{{.Name}}", name)).toBe(`/${name}`);
    } finally {
      for (const name of [launch.containerName, launch.trustContainerName!, launch.gatewayName!]) docker("rm", "-f", name);
      await rm(launch.credentialDir, { recursive: true, force: true });
    }
  }));
  it("cancellation during preparation leaves no companion containers", { timeout: 60_000 }, () => session(async (directory, launch) => {
    await stopSession(directory);
    expect((await getSessionStatus(directory)).state).toBe("canceled");
    absent(launch);
  }));
  it("a missing gateway image fails before the workload starts and cleans up", { timeout: 60_000 }, () => session(async (directory, launch) => {
    expect((await wait(directory, "failed")).turn).toBe(0);
    absent(launch);
  }, { gateway: { ...gateway, image: "gauge-missing-gateway:test" } }));
});
