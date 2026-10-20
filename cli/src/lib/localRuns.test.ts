import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { listLocalRuns, parseSince } from "./localRuns";
import { openLocalStore } from "./localStore";
import { saveLocalAnalysis } from "./localAnalysis";

const gaugeDir = mkdtempSync(join(tmpdir(), "gauge-runs-"));
after(() => rmSync(gaugeDir, { recursive: true, force: true }));
const store = openLocalStore(gaugeDir);
const evalId = store.createMeasurement("eval", {
  name: "Task",
  promptText: "Do the task",
}).id;
const preferenceId = store.createMeasurement("preference", {
  name: "Choice",
  promptText: "Choose a tool",
}).id;
store.updateMeasurement(evalId, { promptText: "Do the revised task" });

for (const [
  id,
  agent,
  batchId,
  attempt,
  createdAt,
  outcome,
  measurementId,
  measurementKind,
  measurementRevision,
] of [
  [
    "r1",
    "CLAUDE_CODE",
    "b1",
    2,
    "2026-10-01T00:00:00Z",
    "completed",
    evalId,
    "eval",
    1,
  ],
  [
    "r2",
    "CODEX_CLI",
    "b2",
    1,
    "2026-10-02T00:00:00Z",
    "completed",
    preferenceId,
    "preference",
    1,
  ],
  [
    "r3",
    "CLAUDE_CODE",
    "b1",
    1,
    "2026-10-03T00:00:00Z",
    "starting",
    evalId,
    "eval",
    2,
  ],
] as const) {
  const directory = join(gaugeDir, "runs", id, "attempts", String(attempt));
  mkdirSync(directory, { recursive: true });
  const metadata = {
    attempt: { runId: id, n: attempt, batchId },
    agent: {
      kind: agent === "CODEX_CLI" ? "codex" : "claude",
      model: `model-${attempt}`,
    },
    agentName: agent,
    createdAt,
    measurement: {
      id: measurementId,
      kind: measurementKind,
      revision: measurementRevision,
    },
    case: { path: "case.md", criteria: [] },
  };
  writeFileSync(join(directory, "spec.json"), JSON.stringify(metadata));
  if (outcome === "completed")
    writeFileSync(
      join(directory, "result.json"),
      JSON.stringify({
        outcome,
        endedBy: "supervisor_finish",
        turns: 1,
        endedAt: createdAt,
      }),
    );
  store.upsertSession({
    id,
    agent,
    batchId,
    attempt,
    model: `model-${attempt}`,
    createdAt,
    outcome,
    measurementId,
    measurementKind,
    measurementRevision,
    case: "case.md",
    endedBy: outcome === "completed" ? "supervisor_finish" : null,
    turns: outcome === "completed" ? 1 : null,
    endedAt: outcome === "completed" ? createdAt : null,
    configuration: { case: metadata.case },
  });
}
store.close();

describe("local runs", () => {
  it("lists current attempts from SQLite and preserves unknown active-run metrics", () => {
    const runs = listLocalRuns(gaugeDir);
    assert.deepEqual(
      runs.map((run) => run.id),
      ["r3", "r2", "r1"],
    );
    assert.equal(runs[2].attempt, 2);
    assert.equal(runs[2].model, "model-2");
    assert.equal(runs[0].turns, null);
    assert.equal(runs[0].durationMs, null);
  });

  it("filters canonical agents, saved identities, revisions, times, and outcomes", () => {
    const ids = (filter: Parameters<typeof listLocalRuns>[1]) =>
      listLocalRuns(gaugeDir, filter).map((run) => run.id);
    assert.deepEqual(ids({ batch: "b1" }), ["r3", "r1"]);
    assert.deepEqual(ids({ agent: "CODEX_CLI" }), ["r2"]);
    assert.deepEqual(ids({ evalId, measurementRevision: 1 }), ["r1"]);
    assert.deepEqual(ids({ preferenceId }), ["r2"]);
    assert.deepEqual(ids({ since: new Date("2026-10-01T12:00:00Z") }), [
      "r3",
      "r2",
    ]);
    assert.deepEqual(ids({ ids: ["r1"] }), ["r1"]);
    assert.deepEqual(ids({ until: new Date("2026-10-01T12:00:00Z") }), ["r1"]);
    assert.deepEqual(ids({ case: "nope.md" }), []);
    assert.deepEqual(ids({ outcome: "completed" }), ["r2", "r1"]);
  });

  it("counts only published analysis and preserves it through explicit repair", () => {
    const results = join(gaugeDir, "runs", "r2", "results");
    mkdirSync(results, { recursive: true });
    writeFileSync(
      join(results, "session-analysis.md"),
      "# Analysis\nNo findings.",
    );
    assert.equal(listLocalRuns(gaugeDir, { ids: ["r2"] })[0].analyzed, false);
    saveLocalAnalysis(gaugeDir, "r2", {
      schemaVersion: 1,
      instructionsVersion: "test-v1",
      analyst: { name: "Coding agent" },
      assessability: "ASSESSED",
      findings: [],
      products: [],
      criteria: [],
    });
    const repaired = openLocalStore(gaugeDir);
    try {
      assert.deepEqual(repaired.repairSessionSummaries().skipped, []);
      assert.equal(repaired.requireMeasurement(evalId).revision, 2);
    } finally {
      repaired.close();
    }
    assert.deepEqual(
      listLocalRuns(gaugeDir, { analyzed: true }).map((run) => run.id),
      ["r2"],
    );
    assert.equal(listLocalRuns(gaugeDir, { agent: "CODEX_CLI" })[0].id, "r2");
    assert.deepEqual(
      listLocalRuns(gaugeDir, { analyzed: false }).map((run) => run.id),
      ["r3", "r1"],
    );
  });

  it("reads criterion judgments from the current published analysis with frozen names", () => {
    const directory = join(gaugeDir, "runs", "r_judged", "attempts", "1");
    mkdirSync(join(directory, "session"), { recursive: true });
    writeFileSync(
      join(directory, "session", "events.ndjson"),
      '{"seq":1,"turn":1,"text":"Task complete"}\n',
    );
    const records = openLocalStore(gaugeDir);
    try {
      records.upsertSession({
        id: "r_judged",
        batchId: "b_judged",
        case: "task.md",
        agent: "CODEX_CLI",
        model: "model-1",
        attempt: 1,
        outcome: "completed",
        turns: 1,
        createdAt: "2026-10-04T00:00:00Z",
        endedAt: "2026-10-04T00:00:01Z",
        endedBy: "supervisor_finish",
        configuration: {
          case: {
            criteria: [
              {
                id: "c1",
                name: "File created",
                rubric: "The requested file exists",
              },
            ],
          },
        },
      });
    } finally {
      records.close();
    }
    const analysis = {
      schemaVersion: 1,
      instructionsVersion: "test-v1",
      analyst: { name: "Coding agent" },
      assessability: "ASSESSED",
      criteria: [
        {
          criterionId: "c1",
          outcome: "PASS",
          label: "The file exists",
          evidence: [
            { kind: "artifact", artifact: "session/events.ndjson", line: 1 },
          ],
        },
      ],
    };
    saveLocalAnalysis(gaugeDir, "r_judged", analysis);
    assert.deepEqual(
      listLocalRuns(gaugeDir, { ids: ["r_judged"] })[0].criterionResults,
      [{ id: "c1", name: "File created", outcome: "PASS" }],
    );
    saveLocalAnalysis(gaugeDir, "r_judged", {
      ...analysis,
      criteria: [
        {
          ...analysis.criteria[0],
          outcome: "FAIL",
          label: "Revised assessment",
        },
      ],
    });
    assert.deepEqual(
      listLocalRuns(gaugeDir, { ids: ["r_judged"] })[0].criterionResults,
      [{ id: "c1", name: "File created", outcome: "FAIL" }],
    );
  });

  it("parses relative and absolute --since windows", () => {
    const now = Date.parse("2026-10-15T00:00:00Z");
    assert.equal(
      parseSince("2d", now).toISOString(),
      "2026-10-13T00:00:00.000Z",
    );
    assert.equal(
      parseSince("2026-10-01", now).toISOString(),
      "2026-10-01T00:00:00.000Z",
    );
    assert.throws(() => parseSince("soon"), /invalid --since/);
  });
});
