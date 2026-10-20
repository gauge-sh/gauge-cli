import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "gauge-cli-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
let hangingPid;
try {
  const packed = await exec(
    npm,
    ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
    { cwd: join(root, "cli") },
  );
  const [archive] = JSON.parse(packed.stdout);
  assert.ok(
    archive.files.some(({ path }) => path === "dist/telemetryWorker.js"),
  );
  await writeFile(
    join(temporary, "package.json"),
    '{"private":true,"type":"module"}',
  );
  await exec(
    npm,
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(temporary, archive.filename),
    ],
    { cwd: temporary },
  );
  const installed = join(temporary, "node_modules/@withgauge/cli");
  for (const { path } of archive.files) {
    assert.match(path, /^(?:package\.json|README\.md|LICENSE|dist\/[\w.-]+\.js)$/, `Unexpected CLI artifact: ${path}`);
    const content = await readFile(join(installed, path), "utf8");
    assert.doesNotMatch(content,
      /github\.com\/gauge-sh\/(?!gauge-cli(?:[\/."\s]|$)|gauge-skills(?:[\/."\s]|$))[\w.-]+|@[\w-]+\/api-schemas|\b[A-Z]{2,}-\d{2,}\b|\/api\/(?:v1\/)?admin(?:\/|\b)|\/(?:home|Users)\/(?!node\/)[A-Za-z0-9_][\w.-]*\//,
      `Private or staff-only reference in public CLI artifact: ${path}`);
    if (path.endsWith(".js"))
      assert.doesNotMatch(content, /^\s*\/\/\s*(?:src\/|api-schemas\/|\.\.\/packages\/)/m,
        `Generated source path in CLI artifact: ${path}`);
  }
  assert.match(await readFile(join(installed, "LICENSE"), "utf8"), /MIT License/);
  const entry = join(temporary, "node_modules/@withgauge/cli/dist/index.js");
  const worker = join(
    temporary,
    "node_modules/@withgauge/cli/dist/telemetryWorker.js",
  );
  const capture = join(temporary, "capture.json");
  const preload = join(temporary, "capture.mjs");
  await writeFile(
    preload,
    `
import { writeFileSync } from "node:fs";
if (process.argv[1]?.endsWith("telemetryWorker.js")) {
  globalThis.fetch = async (url, options) => {
    writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ url, body: JSON.parse(options.body), pid: process.pid }));
    if (process.env.TEST_TELEMETRY_HANG === "1") return new Promise(() => {});
    return new Response(null);
  };
}
`,
  );
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: join(temporary, "config"),
    GAUGE_TELEMETRY_DISABLED: "0",
    NODE_OPTIONS: `--import=${JSON.stringify(preload)}`,
  };
  const run = (args, extra = {}) =>
    exec(process.execPath, [entry, ...args], {
      env: { ...env, ...extra },
      timeout: 8_000,
    });
  async function captured() {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        return JSON.parse(await readFile(capture, "utf8"));
      } catch {}
      await delay(20);
    }
    throw new Error("Packaged telemetry worker did not capture an event");
  }
  const baseline = await run(["instructions", "--list"], {
    GAUGE_TELEMETRY_DISABLED: "1",
  });
  const publicHelp = await run(["run", "--help"], { GAUGE_TELEMETRY_DISABLED: "1" });
  assert.doesNotMatch(publicHelp.stdout, /superuser|staff-only/i);
  const publicSchema = await run(["run", "--schema"], { GAUGE_TELEMETRY_DISABLED: "1" });
  assert.doesNotMatch(publicSchema.stdout, /superuser|staff-only/i);
  const start = Date.now();
  const active = await run(["instructions", "--list"], {
    TEST_TELEMETRY_HANG: "1",
  });
  assert.deepEqual(active, baseline, "Telemetry must not change stdout/stderr");
  assert.ok(Date.now() - start < 2_500, "CLI waited for the telemetry worker");
  const first = await captured();
  hangingPid = first.pid;
  process.kill(hangingPid, 0);
  process.kill(hangingPid);
  hangingPid = undefined;
  assert.equal(first.body.event, "cli_command_invoked");
  assert.equal(first.body.properties.command, "instructions");
  assert.deepEqual(Object.keys(first.body.properties).sort(), [
    "$geoip_disable",
    "$ip",
    "$process_person_profile",
    "cli_version",
    "command",
  ]);
  assert.equal(first.body.properties.$ip, "0.0.0.0");
  await rm(capture);
  await run(["instructions", "--list"]);
  assert.equal((await captured()).body.distinct_id, first.body.distinct_id);
  await rm(capture);

  const blocked = join(temporary, "blocked");
  await writeFile(blocked, "not a directory");
  assert.deepEqual(
    await run(["instructions", "--list"], { XDG_CONFIG_HOME: blocked }),
    baseline,
  );

  const failed = async (extra) => {
    try {
      await run(["instructions", "nonexistent-topic"], extra);
    } catch (error) {
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
    throw new Error("Expected command failure");
  };
  assert.deepEqual(
    await failed({}),
    await failed({ GAUGE_TELEMETRY_DISABLED: "1" }),
  );
  await captured();
  await rm(capture);
  const disabled = await run(["telemetry", "disable", "-o", "json"]);
  assert.deepEqual(JSON.parse(disabled.stdout), {
    enabled: false,
    source: "preference",
  });
  assert.deepEqual(await run(["instructions", "--list"]), baseline);
  await delay(3_200);
  await assert.rejects(readFile(capture), { code: "ENOENT" });
  await rename(worker, `${worker}.missing`);
  assert.deepEqual(await run(["instructions", "--list"]), baseline);
  console.log(
    "Isolated CLI tarball: telemetry delivery, stable identity, opt-out, output/exit isolation, missing worker, and blocked storage passed.",
  );
} finally {
  if (hangingPid) {
    try {
      process.kill(hangingPid);
    } catch {}
  }
  await rm(temporary, { recursive: true, force: true });
}
