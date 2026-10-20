import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Command } from "commander";
import { register } from "./query";
import { openLocalStore } from "../lib/localStore";

test("query command routes local metadata, filters and reports without hosted credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "gauge-query-command-"));
  const cwd = process.cwd();
  const log = console.log;
  const error = console.error;
  const output: string[] = [];
  const run = async (...args: string[]) => {
    output.length = 0;
    const program = new Command()
      .option("--local")
      .option("--hosted")
      .option("-o, --output <format>");
    register(program);
    await program.parseAsync(["node", "gauge", "-o", "json", ...args]);
    return JSON.parse(output.join("\n"));
  };
  try {
    writeFileSync(join(root, "gauge.json"), '{"version":2,"inputs":{}}');
    process.chdir(root);
    console.log = (...args) => {
      output.push(args.join(" "));
    };
    console.error = () => {};
    const store = openLocalStore(join(root, ".gauge"));
    store.upsertSession({
      id: "run",
      batchId: "batch",
      measurementId: "eval_one",
      measurementKind: "eval",
      measurementRevision: 1,
      case: null,
      agent: "codex",
      model: "gpt-6",
      attempt: 1,
      outcome: "completed",
      endedBy: "session",
      turns: 2,
      createdAt: "2026-10-01T00:00:00.000Z",
      endedAt: "2026-10-01T00:01:00.000Z",
    });
    store.close();
    assert.deepEqual(
      (await run("--local", "query", "datasets")).map(
        (row: { name: string }) => row.name,
      ),
      ["runs", "findings"],
    );
    const query = await run(
      "--local",
      "query",
      "--metrics",
      "run_count",
      "--eval",
      "eval_one",
    );
    assert.equal(query.rows[0].run_count, 1);
    const fields = await run(
      "--local",
      "query",
      "fields",
      "--dataset",
      "findings",
    );
    assert.ok(
      fields.metrics.some(
        (field: { name: string }) => field.name === "affected_runs",
      ),
    );
    await assert.rejects(
      () =>
        run(
          "--local",
          "query",
          "--metrics",
          "run_count",
          "--where",
          "language=ts",
        ),
      /not supported/,
    );
    await assert.rejects(
      () => run("--hosted", "query", "search", "authentication"),
      /not supported by the hosted query backend/,
    );
    await assert.rejects(
      () =>
        run(
          "--local",
          "query",
          "--metrics",
          "run_count",
          "--order-by",
          "run_count:random",
        ),
      /Invalid --order-by/,
    );
  } finally {
    process.chdir(cwd);
    console.log = log;
    console.error = error;
    rmSync(root, { recursive: true, force: true });
  }
});
