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
  assert.deepEqual(await cleanupLocal(root), []);
});
