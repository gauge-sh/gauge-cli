import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  saveLocalAnalysis,
  getLocalAnalysis,
  renderLocalAnalysisMarkdown,
} from "./localAnalysis";
import { openLocalStore, type LocalSessionSummary } from "./localStore";
import { CliError } from "./client";

export function sessionFixture(
  root: string,
  id = "run_one",
  criteria: { id: string }[] = [],
): LocalSessionSummary {
  const dir = join(root, "runs", id, "attempts", "1");
  mkdirSync(join(dir, "session"), { recursive: true });
  writeFileSync(
    join(dir, "session", "events.ndjson"),
    `${JSON.stringify({ turn: 1, payload: { type: "message", text: "Authentication requires a browser" } })}\n${JSON.stringify({ turn: 2, payload: { type: "message", text: "Used an API key" } })}\n`,
  );
  const summary: LocalSessionSummary = {
    id,
    batchId: "batch",
    case: "onboarding",
    agent: "codex",
    model: "gpt-6",
    attempt: 1,
    outcome: "completed",
    endedBy: "session",
    turns: 2,
    createdAt: "2026-10-01T00:00:00.000Z",
    endedAt: "2026-10-01T00:01:00.000Z",
    configuration: { case: { criteria } },
  };
  writeFileSync(
    join(dir, "spec.json"),
    JSON.stringify({
      attempt: { runId: id, n: 1, batchId: "batch" },
      agent: { kind: "codex", model: "gpt-6" },
      createdAt: summary.createdAt,
      case: { criteria, path: summary.case },
    }),
  );
  writeFileSync(
    join(dir, "result.json"),
    JSON.stringify({
      outcome: summary.outcome,
      endedBy: summary.endedBy,
      turns: summary.turns,
      endedAt: summary.endedAt,
    }),
  );
  const store = openLocalStore(root);
  try {
    store.upsertSession(summary);
  } finally {
    store.close();
  }
  return summary;
}

export function analysisFixture() {
  return {
    schemaVersion: 1,
    attempt: 1,
    instructionsVersion: "session-analysis/1",
    analyst: { name: "Codex" },
    assessability: "ASSESSED",
    findings: [
      {
        kind: "FRICTION",
        subject: "Login",
        label: "Browser authentication",
        detail: "A browser was required before using an API key.",
        basis: "OBSERVED",
        effect: "RECOVERED",
        cause: "ACCESS",
        tags: [],
        evidence: [
          { kind: "artifact", artifact: "session/events.ndjson", line: 1 },
        ],
      },
    ],
  };
}

test("analysis publication validates coverage/evidence and replaces the current revision atomically", () => {
  const root = mkdtempSync(join(tmpdir(), "gauge-analysis-"));
  try {
    sessionFixture(root, "run_one", [{ id: "login" }]);
    assert.equal(getLocalAnalysis(root, "run_one"), null);
    assert.throws(
      () => saveLocalAnalysis(root, "run_one", analysisFixture()),
      /Missing: login/,
    );
    const valid = {
      ...analysisFixture(),
      criteria: [
        {
          criterionId: "login",
          outcome: "PASS",
          label: "An API key worked",
          evidence: [
            { kind: "artifact", artifact: "session/events.ndjson", line: 2 },
          ],
        },
      ],
    };
    const first = saveLocalAnalysis(root, "run_one", valid);
    assert.equal(first.revision, 1);
    assert.match(first.evidenceDigest, /^sha256:/);
    assert.equal(getLocalAnalysis(root, "run_one")?.id, first.id);
    const broken = {
      ...valid,
      findings: [
        {
          ...valid.findings[0],
          evidence: [
            { kind: "artifact", artifact: "session/events.ndjson", line: 200 },
          ],
        },
      ],
    };
    assert.throws(() => saveLocalAnalysis(root, "run_one", broken), /exceeds/);
    assert.equal(getLocalAnalysis(root, "run_one")?.id, first.id);
    const second = saveLocalAnalysis(root, "run_one", {
      ...valid,
      findings: [],
    });
    assert.equal(second.revision, 2);
    assert.equal(getLocalAnalysis(root, "run_one")?.findings.length, 0);
    const store = openLocalStore(root);
    try {
      assert.equal(
        store.db.prepare("SELECT COUNT(*) AS count FROM session_analyses").get()
          ?.count,
        2,
      );
      assert.equal(
        store.db.prepare("SELECT COUNT(*) AS count FROM session_findings").get()
          ?.count,
        1,
      );
      store.repairSessionSummaries();
      assert.equal(store.getSession("run_one")?.currentAnalysisId, second.id);
    } finally {
      store.close();
    }
    assert.match(
      renderLocalAnalysisMarkdown(first),
      /FRICTION: Browser authentication/,
    );
    assert.match(
      renderLocalAnalysisMarkdown(second),
      /No findings were reported/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("analysis evidence cannot escape its attempt, invent sequence IDs or target a different attempt", () => {
  const root = mkdtempSync(join(tmpdir(), "gauge-analysis-evidence-"));
  try {
    sessionFixture(root);
    const payload = analysisFixture();
    const submit = (evidence: unknown[]) =>
      saveLocalAnalysis(root, "run_one", {
        ...payload,
        findings: [{ ...payload.findings[0], evidence }],
      });
    assert.throws(
      () => submit([{ kind: "artifact", artifact: "../../outside", line: 1 }]),
      /relative paths/,
    );
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "secret\n");
    symlinkSync(
      outside,
      join(root, "runs", "run_one", "attempts", "1", "escape"),
    );
    assert.throws(
      () => submit([{ kind: "artifact", artifact: "escape", line: 1 }]),
      /outside this attempt/,
    );
    assert.throws(
      () => submit([{ kind: "trace", seq: 1 }]),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.match(error.message, /sequence 1 does not exist/);
        assert.match(error.message, /do not use its array index or turn/);
        assert.match(error.hint ?? "", /"kind":"artifact"/);
        assert.match(error.hint ?? "", /"attempt":1,"line":1/);
        return true;
      },
    );
    assert.throws(
      () =>
        submit([
          {
            kind: "artifact",
            artifact: "session/events.ndjson",
            attempt: 2,
            line: 1,
          },
        ]),
      /targets attempt 1/,
    );
    assert.throws(
      () =>
        saveLocalAnalysis(root, "run_one", { ...payload, schemaVersion: 999 }),
      /upgrade Gauge/,
    );
    assert.equal(getLocalAnalysis(root, "run_one"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a new execution attempt clears the current analysis but preserves its historical revision", () => {
  const root = mkdtempSync(join(tmpdir(), "gauge-analysis-attempt-"));
  try {
    const summary = sessionFixture(root);
    saveLocalAnalysis(root, "run_one", analysisFixture());
    const store = openLocalStore(root);
    try {
      store.upsertSession({
        ...summary,
        attempt: 2,
        outcome: "running",
        endedAt: null,
      });
      assert.equal(store.getSession("run_one")?.analyzed, false);
      assert.equal(
        store.db.prepare("SELECT COUNT(*) AS count FROM session_analyses").get()
          ?.count,
        1,
      );
      store.upsertSession(summary);
      assert.equal(store.getSession("run_one")?.attempt, 2);
    } finally {
      store.close();
    }
    assert.equal(getLocalAnalysis(root, "run_one"), null);
    assert.throws(
      () => saveLocalAnalysis(root, "run_one", analysisFixture()),
      /Wait until it finishes/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
