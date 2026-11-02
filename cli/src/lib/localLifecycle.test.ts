import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  batchDirectory,
  cancelLocal,
  cancellationRequested,
  cleanupLocal,
  localSessions,
  localStatus,
  localBatchStatus,
} from "./localLifecycle";

test("batch cancellation is durable before any worker exists; unsafe IDs are refused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lifecycle-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(batchDirectory(root, "b_empty"), { recursive: true });
  assert.deepEqual(await cancelLocal(root, { batch: "b_empty" }), []);
  assert.equal(cancellationRequested(batchDirectory(root, "b_empty")), true);
  await assert.rejects(
    cancelLocal(root, { batch: "../elsewhere" }),
    /Invalid local ID/,
  );
  await assert.rejects(cancelLocal(root, {}), /run ID or/);
  await assert.rejects(cancelLocal(root, { id: "missing" }), /not found/);
});

test("batch status preserves last recorded progress without inferring liveness from a PID", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lifecycle-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = batchDirectory(root, "b_one");
  await mkdir(directory, { recursive: true });
  for (const supervisorPid of [process.pid, 2 ** 30, undefined]) {
    const saved = { state: "running", supervisorPid, expectedSessions: 3, finishedSessions: 1 };
    await writeFile(join(directory, "status.json"), JSON.stringify(saved));
    const status = await localBatchStatus(root, "b_one");
    assert.equal(status.state, "unavailable");
    assert.equal(status.lastKnownState, "running");
    assert.equal(status.finishedSessions, 1);
  }
  await writeFile(join(directory, "status.json"), JSON.stringify({ state: "completed" }));
  assert.equal((await localBatchStatus(root, "b_one")).state, "completed");
});

test("discovery ignores linked runs and malformed records; failed preparation stays visible", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lifecycle-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const attempt = join(root, "runs/r_one/attempts/1");
  await mkdir(attempt, { recursive: true });
  await writeFile(
    join(attempt, "spec.json"),
    JSON.stringify({ attempt: { runId: "r_one", n: 1, batchId: "b_one" } }),
  );
  await writeFile(
    join(attempt, "result.json"),
    JSON.stringify({ outcome: "failed", turns: 0, detail: "no credentials" }),
  );
  await symlink(join(root, "runs/r_one"), join(root, "runs/r_link"));
  const bad = join(root, "runs/r_bad/attempts/1");
  await mkdir(bad, { recursive: true });
  await writeFile(join(bad, "spec.json"), "{");
  assert.equal((await localSessions(root)).length, 1);
  assert.equal((await localStatus(root))[0].state, "failed");
  assert.equal((await localStatus(root))[0].stderrLog, undefined);
  await mkdir(join(attempt, "session"));
  await writeFile(join(attempt, "session/agent.stderr.log"), "refused as root\n");
  assert.equal(
    (await localStatus(root))[0].stderrLog,
    join(attempt, "session/agent.stderr.log"),
  );
  await writeFile(
    join(attempt, "session/session.json"),
    JSON.stringify({ version: 1, socketPath: join(root, "absent.sock") }),
  );
  await writeFile(
    join(attempt, "session/status.json"),
    JSON.stringify({ state: "canceled", turn: 1 }),
  );
  assert.equal((await localStatus(root))[0].detail, "no credentials");
  await rm(join(attempt, "session"), { recursive: true });
  assert.deepEqual(await cleanupLocal(root), []);
});
