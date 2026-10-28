import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import type {
  RunCompareResponse,
  RunCompareStats,
} from "@withgauge/api-schemas/runs";
import { CliError } from "./client";
import type { LocalRun } from "./localRuns";
import {
  compareLocalRuns,
  compareWarnings,
  localCompareFilter,
  localCompareWarnings,
  parseCompareSide,
  printComparison,
} from "./runCompare";

describe("parseCompareSide", () => {
  it("maps keys to the wire side", () => {
    assert.deepEqual(
      parseCompareSide("--baseline", [
        "eval=e1",
        "revision=abc",
        "batch=b1,b2",
        "batch=b3",
        "agent=claude-code,codex",
        "model=sonnet",
        "since=7d",
      ]),
      {
        evalSet: "e1",
        evalRevision: "abc",
        batch: ["b1", "b2", "b3"],
        agent: ["CLAUDE_CODE", "CODEX_CLI"],
        model: ["sonnet"],
        since: "7d",
      },
    );
  });

  it("selects one optimization trial", () => {
    assert.deepEqual(parseCompareSide("--candidate", ["trial=t1"]), {
      trial: "t1",
    });
  });

  it("needs a selecting key", () => {
    assert.throws(
      () => parseCompareSide("--candidate", ["since=2h"]),
      /needs request=, batch=, eval=, experiment=, or trial=/,
    );
  });

  it("rejects unknown keys, empty values and repeats", () => {
    for (const pairs of [["foo=1"], ["request="], ["eval=a", "eval=b"]])
      assert.throws(() => parseCompareSide("--baseline", pairs), CliError);
  });
});

function stats(over: Partial<RunCompareStats> = {}): RunCompareStats {
  return {
    runs: 2,
    finished: 2,
    succeeded: 2,
    judged: 2,
    passed: 1,
    passRate: 0.5,
    medianTurns: 10,
    medianUsdCost: 1,
    medianDurationMs: 60_000,
    criteria: [{ name: "Works", judged: 2, passed: 1, passRate: 0.5 }],
    ...over,
  };
}

const RESULT: RunCompareResponse = {
  overall: {
    baseline: stats(),
    candidate: stats({ passed: 2, passRate: 1, medianTurns: 6 }),
    delta: {
      passRate: 0.5,
      medianTurns: -4,
      medianUsdCost: 0,
      medianDurationMs: 0,
      criteria: [{ name: "Works", passRate: 0.5 }],
    },
  },
  targets: [],
  sides: {
    baseline: {
      evalRevisions: ["aaa", "bbb", "ddd"],
      mixedRevisions: [
        { evalSetId: "e1", promptId: null, revisions: ["aaa", "bbb"] },
      ],
      truncated: false,
    },
    candidate: { evalRevisions: ["ccc"], mixedRevisions: [], truncated: true },
  },
};

function capture(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, "log", (line = "") => lines.push(line));
  return lines;
}

describe("comparison output", () => {
  it("warns about mixed revisions and capped sides", () => {
    const warnings = compareWarnings(RESULT);
    assert.equal(warnings.length, 2);
    assert.match(
      warnings[0],
      /baseline: eval e1 ran under 2 revisions \(aaa, bbb\)/,
    );
    assert.match(warnings[1], /candidate matched too many runs/);
  });

  it("warns about empty, unfinished, and unjudged sides", () => {
    const warnings = compareWarnings({
      ...RESULT,
      overall: {
        ...RESULT.overall,
        baseline: stats({ runs: 0, finished: 0, judged: 0, passed: 0 }),
        candidate: stats({ runs: 4, finished: 3, judged: 2 }),
      },
      sides: {
        baseline: { evalRevisions: [], truncated: false },
        candidate: { evalRevisions: ["ccc"], truncated: false },
      },
    });
    assert.deepEqual(
      warnings.map((w) => w.split(" ").slice(0, 4).join(" ")),
      [
        "baseline matched no runs.",
        "candidate has 1 of",
        "candidate has 1 finished",
      ],
    );
    assert.match(warnings[1], /gauge run wait/);
  });

  it("prints signed deltas", (t) => {
    const lines = capture(t);
    printComparison(RESULT);
    const text = lines.join("\n");
    assert.match(text, /50% \(1\/2\)\s+100% \(2\/2\)\s+\+50pp/);
    assert.match(text, /10 → 6 \(-4\)/);
    assert.match(text, /2\/2 → 2\/2/);
    assert.match(text, /\$1\.00 → \$1\.00 \(±\$0\.00\)/);
  });

  it("names the optimization trial behind a side's runs", (t) => {
    const lines = capture(t);
    printComparison({
      ...RESULT,
      sides: {
        ...RESULT.sides,
        candidate: {
          ...RESULT.sides.candidate,
          trials: [
            {
              optimizationId: "c1",
              trialId: "t1",
              key: "R1.1",
              title: "Tighter skill",
              kind: "EDIT_SKILL",
              runs: 2,
            },
          ],
        },
      },
    });
    assert.ok(
      lines.includes(
        'candidate: 2 runs from optimization trial R1.1 "Tighter skill" (EDIT_SKILL).',
      ),
    );
  });
});

function localRun(over: Partial<LocalRun> = {}): LocalRun {
  return {
    id: "r1",
    batchId: "b1",
    evalId: null,
    case: "gauge-cases/cli/install.md",
    agent: "CLAUDE_CODE",
    model: "sonnet",
    attempt: 1,
    outcome: "completed",
    endedBy: "supervisor_finish",
    turns: 10,
    endedAt: "2026-10-01T00:00:00Z",
    analyzed: false,
    attemptDir: "",
    resultsDir: "",
    ...over,
  };
}

describe("local comparison", () => {
  it("maps a side to a local run filter", () => {
    const filter = localCompareFilter(
      "--baseline",
      parseCompareSide("--baseline", [
        "batch=b1",
        "eval=ev_saved",
        "revision=2",
        "agent=codex",
        "model=gpt",
        "since=2026-10-01T00:00:00Z",
        "until=2026-10-02T00:00:00Z",
      ]),
    );
    assert.deepEqual(filter, {
      batch: "b1",
      evalId: "ev_saved",
      measurementRevision: 2,
      agent: "CODEX_CLI",
      model: "gpt",
      since: new Date("2026-10-01T00:00:00Z"),
      until: new Date("2026-10-02T00:00:00Z"),
    });
  });

  it("rejects hosted-only selectors and lists", () => {
    assert.throws(
      () => localCompareFilter("--candidate", { trial: "t1", since: "2h" }),
      /--candidate trial= select hosted runs/,
    );
    assert.throws(
      () => localCompareFilter("--baseline", { batch: ["b1", "b2"] }),
      /one batch=/,
    );
  });

  it("computes completion and median turns per target", () => {
    const result = compareLocalRuns(
      [
        localRun({ turns: 10 }),
        localRun({ id: "r2", turns: 20, outcome: "failed" }),
        localRun({ id: "r3", agent: "CODEX_CLI", model: "gpt", turns: 7 }),
      ],
      [localRun({ id: "r4", turns: 6 }), localRun({ id: "r5", turns: 8 })],
    );
    assert.deepEqual(result.overall.baseline, {
      runs: 3,
      finished: 3,
      succeeded: 2,
      judged: 0,
      passed: 0,
      passRate: null,
      medianTurns: 10,
      medianUsdCost: null,
      medianDurationMs: null,
      criteria: [],
    });
    assert.equal(result.overall.candidate.medianTurns, 7);
    assert.equal(result.overall.delta.medianTurns, -3);
    assert.deepEqual(
      result.targets.map((t) => [t.agent, t.model, t.delta.medianTurns]),
      [
        ["CLAUDE_CODE", "sonnet", -8],
        ["CODEX_CLI", "gpt", null],
      ],
    );
    assert.equal(localCompareWarnings(result).length, 2);
    assert.ok(
      localCompareWarnings(result).every((warning) =>
        warning.includes("without a verdict"),
      ),
    );
  });

  it("excludes unknown metrics and unassessable judgments while counting in-progress runs accurately", () => {
    const result = compareLocalRuns(
      [
        localRun({
          id: "pass",
          turns: 10,
          durationMs: 1000,
          criterionResults: [{ id: "c1", name: "Works", outcome: "PASS" }],
        }),
        localRun({
          id: "unknown",
          turns: null,
          durationMs: null,
          criterionResults: [
            { id: "c1", name: "Works", outcome: "UNASSESSABLE" },
          ],
        }),
        localRun({ id: "unread", turns: null }),
        localRun({
          id: "active",
          outcome: "starting",
          turns: null,
          endedAt: "",
        }),
      ],
      [
        localRun({
          id: "fail",
          turns: 8,
          durationMs: 800,
          criterionResults: [{ id: "c1", name: "Works", outcome: "FAIL" }],
        }),
      ],
    );
    assert.equal(result.overall.baseline.finished, 3);
    assert.equal(result.overall.baseline.judged, 1);
    assert.equal(result.overall.baseline.passed, 1);
    assert.equal(result.overall.baseline.passRate, 1);
    assert.equal(result.overall.baseline.medianTurns, 10);
    assert.equal(result.overall.baseline.medianDurationMs, 1000);
    assert.equal(result.overall.delta.passRate, -1);
    assert.equal(result.overall.delta.medianDurationMs, -200);
    assert.deepEqual(result.overall.baseline.criteria, [
      { name: "Works", judged: 1, passed: 1, passRate: 1 },
    ]);
    assert.deepEqual(result.overall.delta.criteria, [
      { name: "Works", passRate: -1 },
    ]);
    assert.match(
      localCompareWarnings(result).join("\n"),
      /gauge run wait --batch <batch-id> --local/,
    );
    assert.equal(
      compareLocalRuns([localRun({ turns: null })], []).overall.baseline
        .medianTurns,
      null,
    );
  });

  it("reports mixed saved revisions and requires an integer local revision selector", () => {
    const result = compareLocalRuns(
      [
        localRun({ evalId: "ev_saved", measurementRevision: 1 }),
        localRun({ id: "r2", evalId: "ev_saved", measurementRevision: 2 }),
      ],
      [],
    );
    assert.deepEqual(result.sides.baseline.evalRevisions, ["1", "2"]);
    assert.match(
      localCompareWarnings(result).join("\n"),
      /ev_saved ran under 2 revisions/,
    );
    assert.match(localCompareWarnings(result).join("\n"), /revision=<number>/);
    assert.throws(
      () =>
        localCompareFilter("--baseline", {
          evalSet: "ev_saved",
          evalRevision: "abc",
        }),
      /positive integer/,
    );
  });

  it("warns about an empty local side and prints the table", (t) => {
    const result = compareLocalRuns([], [localRun()]);
    const warnings = localCompareWarnings(result);
    assert.match(warnings[0], /baseline matched no local runs/);
    assert.ok(!warnings.some((w) => w.includes("trial=")));
    const lines = capture(t);
    printComparison(result);
    assert.match(lines.join("\n"), /0 → 1\s+0\/0 → 1\/1/);
  });

  it("names the until= key in its parse error", () => {
    assert.throws(
      () =>
        localCompareFilter("--candidate", {
          batch: ["b1"],
          until: "yesterday",
        }),
      /invalid until= "yesterday"/,
    );
  });
});
