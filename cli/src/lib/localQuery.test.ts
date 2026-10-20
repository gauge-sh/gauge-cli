import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { queryLocal, localQueryMetadata } from "./localQuery";
import { saveLocalAnalysis } from "./localAnalysis";
import { openLocalStore } from "./localStore";

function sessions(root: string) {
  const store = openLocalStore(root);
  try {
    for (const id of ["one", "two", "three"]) {
      store.upsertSession({
        id,
        batchId: id === "three" ? "other" : "batch",
        case: null,
        agent: "codex",
        model: "gpt-6",
        attempt: 1,
        outcome: "completed",
        endedBy: "session",
        turns: id === "three" ? null : 2,
        createdAt: "2026-10-01T00:00:00.000Z",
        endedAt: "2026-10-01T00:01:00.000Z",
        measurementId: "eval_a",
        measurementKind: "eval",
        measurementRevision: id === "three" ? 2 : 1,
      });
      const dir = join(root, "runs", id, "attempts", "1", "session");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "events.ndjson"),
        '{"turn":1,"text":"Login required a browser"}\n',
      );
    }
  } finally {
    store.close();
  }
}
function analysis() {
  const finding = {
    kind: "FRICTION",
    subject: "Login",
    label: "Browser authentication",
    detail: "Browser login blocked setup.",
    basis: "OBSERVED",
    effect: "BLOCKED",
    cause: "ACCESS",
    evidence: [
      { kind: "artifact", artifact: "session/events.ndjson", line: 1 },
    ],
  };
  return {
    schemaVersion: 1,
    instructionsVersion: "analysis/1",
    analyst: { name: "Codex" },
    assessability: "ASSESSED",
    findings: [
      finding,
      { ...finding, effect: "EXTRA_WORK", label: "Extra configuration" },
    ],
  };
}

test("findings count only current analyses and distinguish affected sessions and incomplete analysis", () => {
  const root = mkdtempSync(join(tmpdir(), "gauge-query-"));
  try {
    sessions(root);
    saveLocalAnalysis(root, "one", analysis());
    saveLocalAnalysis(root, "two", { ...analysis(), findings: [] });
    const result = queryLocal(root, {
      dataset: "findings" as never,
      dimensions: ["kind", "eval"],
      metrics: ["finding_count", "affected_runs"],
    });
    assert.deepEqual(
      result.rows.map((row) => ({ ...row })),
      [
        {
          kind: "FRICTION",
          eval: "eval_a",
          finding_count: 2,
          affected_runs: 1,
        },
      ],
    );
    assert.deepEqual(result.analysisCoverage, {
      sessions: 3,
      analyzedSessions: 2,
      unanalyzedSessions: 1,
    });
    saveLocalAnalysis(root, "one", {
      ...analysis(),
      findings: [analysis().findings[0]],
    });
    const revised = queryLocal(root, {
      dataset: "findings" as never,
      metrics: ["finding_count", "affected_runs"],
      where: [
        { dimension: "batch", op: "eq", value: "batch" },
        { dimension: "effect", op: "eq", value: "BLOCKED" },
      ],
    });
    assert.deepEqual(
      { ...revised.rows[0] },
      { finding_count: 1, affected_runs: 1 },
    );
    assert.deepEqual(revised.analysisCoverage, {
      sessions: 2,
      analyzedSessions: 2,
      unanalyzedSessions: 0,
    });
    const empty = queryLocal(root, {
      dataset: "findings" as never,
      metrics: ["finding_count"],
      where: [{ dimension: "effect", op: "eq", value: "RECOVERED" }],
    });
    assert.equal(empty.rows[0].finding_count, 0);
    assert.equal(empty.analysisCoverage.unanalyzedSessions, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("summary queries retain missing metrics, bind literals, and group UTC dates", () => {
  const root = mkdtempSync(join(tmpdir(), "gauge-query-runs-"));
  try {
    sessions(root);
    const result = queryLocal(root, {
      dataset: "runs",
      dimensions: ["date"],
      granularity: "week",
      metrics: ["run_count", "avg_turns", "input_tokens", "avg_duration_ms"],
    });
    assert.deepEqual(
      { ...result.rows[0] },
      {
        date: "2026-09-28",
        run_count: 3,
        avg_turns: 2,
        input_tokens: null,
        avg_duration_ms: null,
      },
    );
    const revised = queryLocal(root, {
      metrics: ["run_count"],
      where: [{ dimension: "measurement_revision", op: "eq", value: "2" }],
    });
    assert.equal(revised.rows[0].run_count, 1);
    const injection = queryLocal(root, {
      metrics: ["run_count"],
      where: [{ dimension: "model", op: "eq", value: "' OR 1=1; --" }],
    });
    assert.equal(injection.rows[0].run_count, 0);
    const boolean = queryLocal(root, {
      dimensions: ["analyzed"],
      metrics: ["run_count"],
    });
    assert.equal(boolean.rows[0].analyzed, false);
    const date = queryLocal(root, {
      metrics: ["run_count"],
      dateRange: { since: "2026-10-02" },
    });
    assert.equal(date.rows[0].run_count, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capabilities reject unsupported requests without dropping predicates", () => {
  const root = mkdtempSync(join(tmpdir(), "gauge-query-errors-"));
  try {
    assert.deepEqual(
      localQueryMetadata().datasets.map((dataset) => dataset.name),
      ["runs", "findings"],
    );
    assert.throws(
      () => queryLocal(root, { dataset: "tokens", metrics: ["input_tokens"] }),
      /not supported by the local backend/,
    );
    assert.throws(
      () => queryLocal(root, { metrics: ["not_a_metric"] }),
      /Metric "not_a_metric"/,
    );
    assert.throws(
      () =>
        queryLocal(root, {
          metrics: ["run_count"],
          where: [{ dimension: "language", op: "eq", value: "ts" }],
        }),
      /Dimension "language"/,
    );
    assert.throws(
      () =>
        queryLocal(root, {
          metrics: ["run_count"],
          filters: { branded: false },
        }),
      /Filter "branded"/,
    );
    assert.throws(
      () =>
        queryLocal(root, { metrics: ["run_count"], dimensions: ["toString"] }),
      /Dimension "toString"/,
    );
    assert.throws(
      () =>
        queryLocal(root, {
          metrics: ["run_count"],
          orderBy: [{ key: "evil", dir: "asc" }],
        }),
      /must be one of/,
    );
    assert.throws(
      () => queryLocal(root, { metrics: ["run_count"], limit: 0 }),
      /integer from 1/,
    );
    assert.throws(
      () =>
        queryLocal(root, {
          metrics: ["run_count"],
          dateRange: { since: "tomorrow" },
        }),
      /Invalid date/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findings reject future analysis contracts in the selected cohort without changing data", () => {
  const root = mkdtempSync(join(tmpdir(), "gauge-query-version-"));
  try {
    sessions(root);
    const saved = saveLocalAnalysis(root, "one", analysis());
    const store = openLocalStore(root);
    try {
      store.db
        .prepare(
          "UPDATE session_analyses SET schema_version = 999 WHERE id = ?",
        )
        .run(saved.id);
      const before = store.db
        .prepare("SELECT payload FROM session_analyses WHERE id = ?")
        .get(saved.id)?.payload;
      assert.throws(
        () =>
          queryLocal(root, { dataset: "findings", metrics: ["finding_count"] }),
        /Upgrade Gauge before querying these findings/,
      );
      assert.equal(
        queryLocal(root, {
          dataset: "findings",
          metrics: ["finding_count"],
          where: [{ dimension: "batch", op: "eq", value: "other" }],
        }).rows[0].finding_count,
        0,
      );
      assert.equal(
        store.db
          .prepare("SELECT schema_version FROM session_analyses WHERE id = ?")
          .get(saved.id)?.schema_version,
        999,
      );
      assert.equal(
        store.db
          .prepare("SELECT payload FROM session_analyses WHERE id = ?")
          .get(saved.id)?.payload,
        before,
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
