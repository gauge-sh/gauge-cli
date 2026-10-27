import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { RUNTIME_IMAGE } from "../lib/localRuntime";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const enabled = process.env.GAUGE_DOCKER_FIXTURES === "1";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (done(value)) return value;
    await sleep(100);
  }
  throw new Error("Timed out waiting for lifecycle state");
}

async function fixture(t: test.TestContext, prompt: string, samples = 6) {
  const root = await mkdtemp(join(tmpdir(), "gauge-cli-lifecycle-"));
  execFileSync("git", ["init", "-q", root]);
  await mkdir(join(root, "bin"));
  const docker = execFileSync("which", ["docker"], { encoding: "utf8" }).trim();
  const wrapper = join(root, "bin/docker");
  await writeFile(
    wrapper,
    `#!/usr/bin/env node\nconst {spawnSync}=require('node:child_process');if(process.env.GAUGE_TEST_CREATE_DELAY && process.argv[2]==='create') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1500);const r=spawnSync(${JSON.stringify(docker)},process.argv.slice(2).map(a=>a===${JSON.stringify(RUNTIME_IMAGE)}?'gauge-session-fixture:test':a),{stdio:'inherit'});process.exit(r.status ?? 1);\n`,
  );
  await chmod(wrapper, 0o755);
  await writeFile(
    join(root, "gauge.json"),
    JSON.stringify({ version: 2, inputs: {} }),
  );
  await mkdir(join(root, "gauge-cases"));
  await writeFile(
    join(root, "gauge-cases/task.md"),
    `---\ncriteria:\n  - name: Works\n    rubric: Completes the task\nconfig:\n  sampleCount: ${samples}\n  agents:\n    - agent: CLAUDE_CODE\n---\n${prompt}\n`,
  );
  const env = {
    ...process.env,
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    CLAUDE_CODE_OAUTH_TOKEN: "fixture-only",
    ANTHROPIC_API_KEY: "",
    XDG_CONFIG_HOME: root,
    GAUGE_TELEMETRY_DISABLED: "1",
  };
  const invoke = async (...args: string[]) => {
    try {
      const { stdout } = await exec(
        process.execPath,
        [cli, ...args, "--local", "-o", "json"],
        { cwd: root, env, timeout: 45_000 },
      );
      return JSON.parse(stdout);
    } catch (error) {
      throw new Error(
        `${String(error)}\n${(error as { stdout?: string }).stdout ?? ""}`,
      );
    }
  };
  t.after(async () => {
    const batches = await readdir(join(root, ".gauge/batches")).catch(() => []);
    for (const batch of batches) {
      await invoke("run", "cancel", "--batch", batch).catch(() => {});
      // Cancellation stops sessions before the supervisor finishes persisting
      // results. Let the batch settle before removing its workspace.
      await invoke("run", "wait", "--batch", batch);
    }
    await invoke("cleanup").catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const status = () => invoke("run", "status");
  const sessionDir = (id: string) =>
    join(root, ".gauge/runs", id, "attempts/1/session");
  const clean = async (id: string) => {
    const directory = sessionDir(id);
    const record = JSON.parse(
      await readFile(join(directory, "session.json"), "utf8"),
    );
    assert.equal(existsSync(record.credentialDir), false);
    for (const name of [record.containerName, record.gatewayName, record.trustContainerName].filter(Boolean)) assert.equal(
      execFileSync(
        docker,
        ["ps", "-aq", "--filter", `name=^/${name}$`],
        { encoding: "utf8" },
      ).trim(),
      "",
    );
    assert.ok(existsSync(join(directory, "status.json")));
  };
  return { root, env, invoke, status, sessionDir, clean };
}

test("packaged CLI freezes fixture overrides and uses the gateway in a detached batch", { skip: !enabled, timeout: 60_000 }, async (t) => {
  const f = await fixture(t, "HANG", 1);
  await writeFile(join(f.root, "gauge.json"), JSON.stringify({ version: 2, inputs: { docs: { type: "web-fixture", path: "missing.json" } } }));
  await writeFile(join(f.root, "docs.json"), JSON.stringify({ version: 1, pages: [{ url: "https://example.com/docs", body: "frozen CLI fixture" }] }));
  const image = process.env.GAUGE_GATEWAY_IMAGE ? ["--gateway-image", process.env.GAUGE_GATEWAY_IMAGE] : [];
  const plan = await f.invoke("run", "--dry-run", "--input", "docs=docs.json", ...image);
  assert.equal(plan.gateway.ready, true);
  assert.deepEqual(plan.webFixtures["gauge-cases/task.md"].pages, ["https://example.com/docs"]);
  const batch = await f.invoke("run", "--detach", "--input", "docs=docs.json", ...image);
  await writeFile(join(f.root, "docs.json"), "changed after launch");
  const status = await until(f.status, (s) => s.runs.length === 1 && s.runs[0].state === "running");
  const id = status.runs[0].id;
  const launch = JSON.parse(await readFile(join(f.sessionDir(id), "session.json"), "utf8"));
  assert.equal(launch.spec.gateway.digest, plan.webFixtures["gauge-cases/task.md"].digest);
  assert.equal(execFileSync("docker", ["exec", launch.containerName, "curl", "-fsS", "--noproxy", "*", "--max-time", "10", "--resolve", "example.com:443:192.0.2.1", "https://example.com/docs"], { encoding: "utf8" }), "frozen CLI fixture");
  await f.invoke("run", "cancel", "--batch", batch.batchId);
  await f.clean(id);
  assert.match(await readFile(join(f.sessionDir(id), "gateway.log"), "utf8"), /"action": "hit"/);
});

test(
  "foreground Ctrl+C stops active sessions and never starts the rest",
  { skip: !enabled, timeout: 60_000 },
  async (t) => {
    const f = await fixture(t, "HANG");
    const child = spawn(
      process.execPath,
      [cli, "run", "--local", "-o", "json"],
      { cwd: f.root, env: f.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGTERM");
    });
    await until(
      f.status,
      (s) =>
        s.runs.length === 4 && s.runs.every((r: any) => r.state === "running"),
    );
    child.kill("SIGINT");
    assert.equal(await exited, 130, stderr);
    const result = JSON.parse(stdout);
    assert.equal(result.canceled, true);
    assert.equal(result.runs.length, 4);
    for (const run of result.runs) {
      assert.equal(run.outcome, "canceled", JSON.stringify(run));
      await f.clean(run.id);
    }
  },
);

test(
  "detached batch survives its CLI, finishes its queue and cleans containers",
  { skip: !enabled, timeout: 60_000 },
  async (t) => {
    const f = await fixture(t, "HELLO");
    const detached = await f.invoke("run", "--detach");
    assert.match(detached.stop, new RegExp(detached.batchId));
    assert.match(detached.status, /run status/);
    assert.match(detached.wait, /run wait --batch/);
    const final = await f.invoke("run", "wait", "--batch", detached.batchId);
    assert.equal(final.batch.state, "completed");
    assert.match(final.next, /session-analysis/);
    assert.equal(final.runs.length, 6);
    for (const run of final.runs) {
      assert.equal(run.state, "completed");
      await f.clean(run.id);
    }
    const results = await f.invoke("run", "list", "--batch", detached.batchId);
    assert.ok(JSON.stringify(results).includes("completed"));
  },
);

test(
  "local run and batch cancellation use no hosted API; cleanup leaves live sessions alone",
  { skip: !enabled, timeout: 90_000 },
  async (t) => {
    const f = await fixture(t, "HANG");
    const detached = await f.invoke("run", "--detach");
    let current = await until(
      f.status,
      (s) =>
        s.runs.length === 4 && s.runs.every((r: any) => r.state === "running"),
    );
    const first = current.runs[0].id;
    await f.invoke("run", "cancel", first);
    await f.clean(first);
    current = await until(
      f.status,
      (s) =>
        s.runs.length === 5 &&
        s.runs.filter((r: any) => r.state === "running").length === 4,
    );
    const cleanup = await f.invoke("cleanup");
    assert.deepEqual(
      cleanup.sessions,
      [],
      "cleanup leaves live sessions alone",
    );
    await f.invoke("run", "cancel", "--batch", detached.batchId);
    const final = await until(
      () => f.invoke("run", "status", "--batch", detached.batchId),
      (s) => s.batch.state === "canceled",
    );
    for (const run of final.runs) await f.clean(run.id);
    await f.invoke("cleanup");
  },
);

test(
  "recovery cleans an interrupted batch without replaying work",
  { skip: !enabled, timeout: 60_000 },
  async (t) => {
    const f = await fixture(t, "HANG", 1);
    const detached = await f.invoke("run", "--detach");
    const current = await until(
      () => f.invoke("run", "status", "--batch", detached.batchId),
      (s) => s.runs.length === 1 && s.runs[0].state === "running",
    );
    const id = current.runs[0].id;
    const saved = JSON.parse(
      await readFile(join(f.sessionDir(id), "status.json"), "utf8"),
    );
    process.kill(current.batch.supervisorPid, "SIGKILL");
    process.kill(saved.driverPid, "SIGKILL");
    await until(
      () => f.invoke("run", "status", "--batch", detached.batchId),
      (s) =>
        s.batch.state === "interrupted" && s.runs[0].state === "interrupted",
    );
    const cleaned = await f.invoke("cleanup");
    assert.equal(cleaned.sessions[0].status, "cleaned");
    await f.clean(id);
    await f.invoke("cleanup");
    assert.equal((await f.status()).runs.length, 1);
    assert.ok(
      JSON.stringify(
        await f.invoke("run", "list", "--batch", detached.batchId),
      ).includes("interrupted"),
    );
    const queried = await f.invoke(
      "query",
      "--metrics",
      "run_count",
      "--dimensions",
      "outcome",
      "--where",
      `batch=${detached.batchId}`,
    );
    assert.deepEqual(queried.rows, [{ outcome: "interrupted", run_count: 1 }]);
  },
);

test(
  "Ctrl+C during container creation waits for startup and cancels it",
  { skip: !enabled, timeout: 60_000 },
  async (t) => {
    const f = await fixture(t, "HANG");
    const child = spawn(
      process.execPath,
      [cli, "run", "--local", "-o", "json"],
      {
        cwd: f.root,
        env: { ...f.env, GAUGE_TEST_CREATE_DELAY: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGTERM");
    });
    await until(
      async () => {
        const ids = await readdir(join(f.root, ".gauge/runs")).catch(() => []);
        return ids.filter((id) =>
          existsSync(join(f.sessionDir(id), "session.json")),
        );
      },
      (ids) => ids.length === 4,
    );
    child.kill("SIGINT");
    assert.equal(await exited, 130, stderr);
    const result = JSON.parse(stdout);
    assert.equal(result.runs.length, 4);
    for (const run of result.runs) {
      assert.equal(run.outcome, "canceled", JSON.stringify(run));
      await f.clean(run.id);
    }
  },
);
