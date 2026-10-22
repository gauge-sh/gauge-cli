import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it, type TestContext } from "node:test";
import { promisify } from "node:util";
import {
  installationId,
  setTelemetryEnabled,
  telemetryStatus,
} from "./telemetryState";
import {
  REQUEST_TIMEOUT_MS,
  sendTelemetry,
  WORKER_TIMEOUT_MS,
} from "./telemetrySend";

const event = {
  command: "run list",
  timestamp: "2026-10-19T19:00:00.000Z",
  cliVersion: "0.21.0",
};

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "gauge-telemetry-"));
  const previous = process.env.GAUGE_TELEMETRY_DISABLED;
  delete process.env.GAUGE_TELEMETRY_DISABLED;
  t.after(async () => {
    if (previous === undefined) delete process.env.GAUGE_TELEMETRY_DISABLED;
    else process.env.GAUGE_TELEMETRY_DISABLED = previous;
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

it("publishes one stable UUID under concurrent first use", async (t) => {
  const directory = await fixture(t);
  const ids = await Promise.all(
    Array.from({ length: 20 }, () => installationId(directory)),
  );
  assert.equal(new Set(ids).size, 1);
  assert.equal(await installationId(directory), ids[0]);
  assert.deepEqual(await readdir(directory), ["telemetry-id"]);
  if (process.platform !== "win32")
    assert.equal(
      (await stat(join(directory, "telemetry-id"))).mode & 0o777,
      0o600,
    );
});

it("sends exactly the allowlisted payload and reuses identity", async (t) => {
  const directory = await fixture(t);
  const payloads: unknown[] = [];
  const capture: typeof fetch = async (url, options) => {
    assert.equal(String(url), "https://us.i.posthog.com/i/v0/e/?ip=0");
    assert.equal(options?.redirect, "error");
    assert.ok(options?.signal);
    payloads.push(JSON.parse(String(options?.body)));
    return new Response(null, { status: 200 });
  };
  const extra = { ...event, token: "secret", org: "private" };
  await sendTelemetry(extra, { directory, fetch: capture });
  await sendTelemetry(event, { directory, fetch: capture });
  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads[0], payloads[1]);
  assert.deepEqual(payloads[0], {
    api_key: "phc_ie28UsMXVQHo6fnwNV6oOu9bdOpAebflg3vMFxr8LES",
    event: "cli_command_invoked",
    distinct_id: await installationId(directory),
    timestamp: event.timestamp,
    properties: {
      command: "run list",
      cli_version: "0.21.0",
      $process_person_profile: false,
      $geoip_disable: true,
      $ip: "0.0.0.0",
    },
  });
});

it("opt-out and malformed preferences suppress identity creation and requests", async (t) => {
  const directory = await fixture(t);
  const capture = t.mock.fn<typeof fetch>(async () => new Response(null));
  assert.deepEqual(await telemetryStatus(directory), {
    enabled: true,
    source: "default",
  });
  await setTelemetryEnabled(false, directory);
  await sendTelemetry(event, { directory, fetch: capture });
  await setTelemetryEnabled(true, directory);
  process.env.GAUGE_TELEMETRY_DISABLED = "1";
  assert.deepEqual(await telemetryStatus(directory), {
    enabled: false,
    source: "environment",
  });
  await sendTelemetry(event, { directory, fetch: capture });
  delete process.env.GAUGE_TELEMETRY_DISABLED;
  for (const raw of ["{", "null", "{}", '{"enabled":"false"}']) {
    await writeFile(join(directory, "telemetry.json"), raw);
    assert.equal((await telemetryStatus(directory)).enabled, false);
    await sendTelemetry(event, { directory, fetch: capture });
  }
  assert.equal(capture.mock.callCount(), 0);
  assert.deepEqual(await readdir(directory), ["telemetry.json"]);
});

it("drops events on inaccessible storage or corrupt identity", async (t) => {
  const directory = await fixture(t);
  const capture = t.mock.fn<typeof fetch>(async () => new Response(null));
  const blocked = join(directory, "blocked");
  await writeFile(blocked, "not a directory");
  await sendTelemetry(event, { directory: blocked, fetch: capture });
  await writeFile(join(directory, "telemetry-id"), "invalid");
  await sendTelemetry(event, { directory, fetch: capture });
  assert.equal(capture.mock.callCount(), 0);
  assert.equal(
    await readFile(join(directory, "telemetry-id"), "utf8"),
    "invalid",
  );
});

it(
  "drops events when the config directory is read-only",
  {
    skip: process.platform === "win32" || process.getuid?.() === 0,
  },
  async (t) => {
    const directory = await fixture(t);
    const capture = t.mock.fn<typeof fetch>(async () => new Response(null));
    await chmod(directory, 0o500);
    try {
      await sendTelemetry(event, { directory, fetch: capture });
      assert.equal(capture.mock.callCount(), 0);
      assert.deepEqual(await readdir(directory), []);
    } finally {
      await chmod(directory, 0o700);
    }
  },
);

it("drops network and HTTP failures without retrying", async (t) => {
  const directory = await fixture(t);
  for (const status of [400, 429, 500]) {
    const capture = t.mock.fn<typeof fetch>(
      async () => new Response("failure", { status }),
    );
    await sendTelemetry(event, { directory, fetch: capture });
    assert.equal(capture.mock.callCount(), 1);
  }
  const capture = t.mock.fn<typeof fetch>(async () => {
    throw new Error("DNS/TLS failure");
  });
  await sendTelemetry(event, { directory, fetch: capture });
  assert.equal(capture.mock.callCount(), 1);
});

it("aborts a real hanging HTTP request", { timeout: 8_000 }, async (t) => {
  const directory = await fixture(t);
  let requests = 0;
  const server = createServer(() => {
    requests++;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const start = Date.now();
  await sendTelemetry(event, {
    directory,
    fetch: (_url, options) =>
      fetch(`http://127.0.0.1:${address.port}`, options),
  });
  assert.equal(requests, 1);
  assert.ok(Date.now() - start >= REQUEST_TIMEOUT_MS - 100);
  assert.ok(Date.now() - start < 6_000);
});

it(
  "worker lifetime is bounded even if its work never settles",
  { timeout: 25_000 },
  async (t) => {
    const directory = await fixture(t);
    const script = join(directory, "hung-worker.mjs");
    const moduleUrl = new URL("./telemetrySend.ts", import.meta.url).href;
    await writeFile(
      script,
      `import { runTelemetryWorker } from ${JSON.stringify(moduleUrl)}; await runTelemetryWorker(() => new Promise(() => {}));`,
    );
    const loader = fileURLToPath(
      new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url),
    );
    const start = Date.now();
    const result = await promisify(execFile)(
      process.execPath,
      ["--import", loader, script],
      // Allow for Node/tsx cold startup on slower CI runners before the
      // worker starts its unchanged three-second watchdog.
      { timeout: 20_000 },
    );
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.ok(Date.now() - start >= WORKER_TIMEOUT_MS);
    assert.ok(Date.now() - start < 20_000);
  },
);
