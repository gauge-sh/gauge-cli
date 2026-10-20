import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Command } from "commander";
import { register } from "./run";
import { register as query } from "./query";
import { scaffoldWorkspace } from "../lib/scaffold";
import { openLocalStore } from "../lib/localStore";

test("coding agent analysis flows through publication, insight, run list and findings queries", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gauge-analysis-command-"));
  const before = process.cwd();
  t.after(() => {
    process.chdir(before);
    rmSync(root, { recursive: true, force: true });
  });
  scaffoldWorkspace(root, "local");
  process.chdir(root);
  const dir = join(root, ".gauge");
  const attempt = join(dir, "runs/r1/attempts/1");
  mkdirSync(join(attempt, "session"), { recursive: true });
  writeFileSync(
    join(attempt, "session/events.ndjson"),
    '{"seq":7,"turn":1,"payload":{"text":"Authentication blocked the task"}}\n',
  );
  const store = openLocalStore(dir);
  store.upsertSession({
    id: "r1",
    batchId: "b1",
    case: "task",
    agent: "CODEX_CLI",
    model: "gpt",
    attempt: 1,
    outcome: "failed",
    endedBy: "error",
    turns: 1,
    createdAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    configuration: { case: { criteria: [] } },
  });
  store.close();
  const payload = {
    schemaVersion: 1,
    attempt: 1,
    instructionsVersion: "session-analysis/1",
    analyst: { name: "coding agent" },
    assessability: "ASSESSED",
    findings: [
      {
        kind: "FRICTION",
        subject: "Login",
        label: "Blocked authentication",
        detail: "The task stopped at authentication.",
        basis: "OBSERVED",
        effect: "BLOCKED",
        cause: "ACCESS",
        tags: [],
        evidence: [
          { kind: "trace", seq: 7 },
        ],
      },
    ],
  };
  writeFileSync(join(root, "analysis.json"), JSON.stringify(payload));
  const lines: string[] = [];
  t.mock.method(console, "log", (s: unknown) => lines.push(String(s)));
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Local commands must not contact hosted Gauge");
  });
  const call = async (args: string[]) => {
    lines.length = 0;
    const program = new Command()
      .exitOverride()
      .option("--local")
      .option("--hosted")
      .option("-o, --output <format>", "output", "json");
    register(program);
    query(program);
    await program.parseAsync(args, { from: "user" });
    return JSON.parse(lines.join("\n"));
  };
  assert.equal((await call(["run", "list", "--unanalyzed"])).items.length, 1);
  const saved = await call([
    "run",
    "analysis",
    "save",
    "r1",
    "--file",
    "analysis.json",
  ]);
  assert.equal(saved.revision, 1);
  assert.match(
    readFileSync(join(dir, "runs/r1/results/session-analysis.md"), "utf8"),
    /FRICTION: Blocked authentication/,
  );
  assert.equal((await call(["run", "insight", "r1"])).analysis.id, saved.id);
  assert.equal((await call(["run", "list", "--unanalyzed"])).items.length, 0);
  const report = await call([
    "query",
    "--dataset",
    "findings",
    "-m",
    "finding_count,affected_runs",
  ]);
  assert.deepEqual(report.rows, [{ finding_count: 1, affected_runs: 1 }]);
  rmSync(join(dir, "runs/r1/results"), { recursive: true });
  writeFileSync(join(dir, "runs/r1/results"), "blocked report directory");
  const warnings: string[] = [];
  t.mock.method(console, "error", (s: unknown) => warnings.push(String(s)));
  writeFileSync(
    join(root, "analysis.json"),
    JSON.stringify({ ...payload, findings: [] }),
  );
  const second = await call([
    "run",
    "analysis",
    "save",
    "r1",
    "--file",
    "analysis.json",
  ]);
  assert.equal(second.revision, 2);
  assert.match(
    warnings[0],
    /was published in SQLite, but its Markdown report could not be written/,
  );
  const zero = await call([
    "query",
    "--dataset",
    "findings",
    "-m",
    "finding_count,affected_runs",
  ]);
  assert.deepEqual(zero.rows, [{ finding_count: 0, affected_runs: 0 }]);
  assert.deepEqual(zero.analysisCoverage, {
    sessions: 1,
    analyzedSessions: 1,
    unanalyzedSessions: 0,
  });
  writeFileSync(
    join(root, "analysis.json"),
    JSON.stringify({ ...payload, schemaVersion: 99 }),
  );
  await assert.rejects(
    call(["run", "analysis", "save", "r1", "--file", "analysis.json"]),
    /not supported/,
  );
  assert.equal((await call(["run", "insight", "r1"])).analysis.id, second.id);
});
