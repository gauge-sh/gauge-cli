import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openLocalStore } from "./localStore";

test("opening SQLite suppresses only its import notice and restores warning delivery", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gauge-store-warnings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "--input-type=module", "-e",
    `
      import assert from "node:assert/strict";
      import { openLocalStore } from ${JSON.stringify(new URL("./localStore.ts", import.meta.url).href)};
      const original = process.emitWarning;
      const store = openLocalStore(${JSON.stringify(root)});
      assert.equal(process.emitWarning, original);
      assert.throws(() => store.db.exec("INVALID SQL"), /syntax error/);
      store.close();
      process.emitWarning("Other experimental feature", "ExperimentalWarning");
      process.emitWarning("Ordinary warning");
      process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
    `,
  ], { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "", NODE_OPTIONS: "" } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Other experimental feature/);
  assert.match(result.stderr, /Ordinary warning/);
  assert.equal(result.stderr.match(/SQLite is an experimental feature/g)?.length, 1);
});
test("measurement identity survives revision, rename, workspace move and removal", () => {
  const root = mkdtempSync(join(tmpdir(), "gauge-store-"));
  let store = openLocalStore(join(root, ".gauge"));
  try {
    const first = store.createMeasurement("eval", {
      name: "Onboarding",
      promptText: "Install the SDK",
      tags: ["onboarding", "onboarding"],
      criteria: [{ id: "install", name: "Install", rubric: "SDK works" }],
    });
    assert.deepEqual(first.tags, ["onboarding"]);
    const revised = store.updateMeasurement(first.id, {
      name: "Quickstart",
      promptText: "Install and configure the SDK",
    });
    assert.equal(revised.id, first.id);
    assert.equal(revised.revision, 2);
    assert.equal(
      store.getMeasurementRevision(first.id, 1)?.promptText,
      "Install the SDK",
    );
    const launch = store.recordLaunch({
      measurementId: first.id,
      measurementRevision: 1,
      configuration: { prompt: "Install the SDK" },
      provenance: { source: "saved" },
    });
    assert.equal(store.getLaunch(launch.id)?.measurementRevision, 1);
    assert.throws(
      () =>
        store.recordLaunch({
          ...launch,
          configuration: { prompt: "overwrite" },
        }),
      /UNIQUE/,
    );
    assert.throws(
      () =>
        store.recordLaunch({
          measurementId: first.id,
          measurementRevision: 100,
          configuration: {},
          provenance: {},
        }),
      /existing measurement revision/,
    );
    store.close();
    renameSync(join(root, ".gauge"), join(root, "moved"));
    store = openLocalStore(join(root, "moved"));
    assert.equal(store.getMeasurement(first.id)?.revision, 2);
    store.deleteMeasurement(first.id);
    assert.equal(store.getMeasurement(first.id), undefined);
    assert.equal(store.getMeasurementRevision(first.id, 1)?.name, "Onboarding");
    assert.equal(store.getLaunch(launch.id)?.measurementId, first.id);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("repair reads execution summaries without replaying transcripts or deleting authored records", () => {
  const root = mkdtempSync(join(tmpdir(), "gauge-store-repair-"));
  const store = openLocalStore(root);
  try {
    const measurement = store.createMeasurement("preference", {
      name: "Database",
      promptText: "Choose a database",
      kind: "RECOMMEND",
    });
    const attempt = join(root, "runs", "run_one", "attempts", "1");
    mkdirSync(join(attempt, "session"), { recursive: true });
    writeFileSync(
      join(attempt, "spec.json"),
      JSON.stringify({
        attempt: { runId: "run_one", n: 1, batchId: "batch" },
        measurement: { id: measurement.id, kind: "preference", revision: 1 },
        agent: { kind: "codex", model: "gpt-6" },
        createdAt: "2026-10-01T00:00:00.000Z",
        case: { path: "preference", criteria: [] },
      }),
    );
    writeFileSync(
      join(attempt, "session", "status.json"),
      JSON.stringify({ state: "running", turn: 2 }),
    );
    writeFileSync(
      join(attempt, "session", "events.ndjson"),
      "not valid transcript data",
    );
    assert.deepEqual(store.repairSessionSummaries(), {
      repaired: 1,
      skipped: [],
    });
    assert.equal(store.getSession("run_one")?.outcome, "running");
    assert.equal(store.getSession("run_one")?.measurementId, measurement.id);
    writeFileSync(
      join(attempt, "result.json"),
      JSON.stringify({
        outcome: "completed",
        endedBy: "session",
        turns: 3,
        endedAt: "2026-10-01T00:01:00.000Z",
      }),
    );
    assert.equal(store.repairSessionSummaries().repaired, 1);
    assert.equal(store.getSession("run_one")?.turns, 3);
    assert.equal(store.getSession("run_one")?.inputTokens, null);
    assert.equal(store.getMeasurement(measurement.id)?.name, "Database");
    assert.equal(
      readFileSync(join(attempt, "session", "events.ndjson"), "utf8"),
      "not valid transcript data",
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("newer database versions fail intact and invalid edits are atomic", () => {
  const root = mkdtempSync(join(tmpdir(), "gauge-store-version-"));
  const store = openLocalStore(root);
  try {
    const measurement = store.createMeasurement("eval", {
      name: "Install",
      promptText: "Install it",
    });
    assert.throws(
      () => store.updateMeasurement(measurement.id, { name: "" }),
      /nonempty/,
    );
    assert.equal(store.requireMeasurement(measurement.id).revision, 1);
    store.db.exec("PRAGMA user_version = 999");
    assert.throws(() => openLocalStore(root), /Upgrade Gauge/);
    assert.equal(store.requireMeasurement(measurement.id).name, "Install");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
