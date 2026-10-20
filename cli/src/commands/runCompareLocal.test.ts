import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { Command } from "commander";
import type { RunCompareResponse } from "@withgauge/api-schemas/runs";
import { openLocalStore } from "../lib/localStore";
import { register } from "./run";

function localWorkspace(t: TestContext): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gauge-cmp-")));
  const cwd = process.cwd();
  t.after(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "gauge.json"), '{"version":2}\n');
  const store = openLocalStore(join(root, ".gauge"));
  try {
    for (const [
      id,
      batchId,
      measurementId,
      measurementRevision,
      outcome,
      turns,
    ] of [
      ["r1", "b1", "ev_saved", 1, "completed", 10],
      ["r2", "b1", "ev_other", 1, "failed", 20],
      ["r3", "b2", "ev_saved", 2, "completed", 6],
    ] as const)
      store.upsertSession({
        id,
        batchId,
        measurementId,
        measurementKind: "eval",
        measurementRevision,
        case: "case.md",
        agent: "CLAUDE_CODE",
        model: "sonnet",
        attempt: 1,
        outcome,
        turns,
        endedBy: "supervisor_finish",
        createdAt: "2026-10-01T00:00:00Z",
        endedAt: "2026-10-01T00:00:01Z",
      });
  } finally {
    store.close();
  }
  mkdirSync(join(root, "sub"));
  return root;
}

async function compare(
  t: TestContext,
  args: string[],
): Promise<RunCompareResponse> {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => lines.push(String(line)));
  t.mock.method(console, "error", () => {});
  const program = new Command()
    .exitOverride()
    .option("--org <org>")
    .option("-o, --output <format>")
    .option("--hosted")
    .option("--local");
  register(program);
  await program.parseAsync(
    ["run", "compare", "--local", "-o", "json", ...args],
    { from: "user" },
  );
  return JSON.parse(lines.join("\n"));
}

it("compares SQLite-backed local batches without Git", async (t) => {
  process.chdir(localWorkspace(t));
  const result = await compare(t, [
    "--baseline",
    "batch=b1",
    "--candidate",
    "batch=b2",
  ]);
  assert.equal(result.overall.baseline.runs, 2);
  assert.equal(result.overall.baseline.succeeded, 1);
  assert.equal(result.overall.baseline.medianTurns, 15);
  assert.equal(result.overall.candidate.runs, 1);
  assert.equal(result.overall.delta.medianTurns, -9);
  assert.equal(result.targets[0].agent, "CLAUDE_CODE");
});

it("selects stable eval identity and revision from a nested workspace directory", async (t) => {
  const root = localWorkspace(t);
  process.chdir(join(root, "sub"));
  const result = await compare(t, [
    "--baseline",
    "eval=ev_saved",
    "--baseline",
    "revision=1",
    "--baseline",
    "agent=claude-code",
    "--candidate",
    "eval=ev_saved",
    "--candidate",
    "revision=2",
  ]);
  assert.equal(result.overall.baseline.runs, 1);
  assert.equal(result.overall.candidate.runs, 1);
  assert.equal(result.overall.delta.medianTurns, -4);
  assert.deepEqual(result.sides.baseline.evalRevisions, ["1"]);
  assert.deepEqual(result.sides.candidate.evalRevisions, ["2"]);
});
