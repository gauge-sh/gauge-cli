import assert from "node:assert/strict";
import {
  existsSync,
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
import { register as registerInit } from "../commands/init";
import { register as registerEval } from "../commands/eval";
import { register as registerPreference } from "../commands/preference";
import { register as registerRun } from "../commands/run";
import { CliError } from "./client";
import { openLocalStore } from "./localStore";
import { saveLocalAnalysis } from "./localAnalysis";
import { localMeasurementSpec } from "./localMeasurements";

test("workspace CLI creates, edits, tags, plans and queries saved measurements without Git", async () => {
  const root = mkdtempSync(join(tmpdir(), "gauge-measurement-cli-"));
  const cwd = process.cwd();
  const original = { ...process.env };
  const log = console.log;
  const error = console.error;
  const output: string[] = [];
  const program = () => {
    const command = new Command()
      .option("--local")
      .option("--hosted")
      .option("--org <org>")
      .option("-o, --output <format>")
      .exitOverride();
    registerInit(command, { cwd: root });
    registerEval(command);
    registerPreference(command);
    registerRun(command);
    return command;
  };
  const run = async (...args: string[]): Promise<any> => {
    output.length = 0;
    await program().parseAsync(["--local", "-o", "json", ...args], {
      from: "user",
    });
    return output.length ? JSON.parse(output.join("\n")) : undefined;
  };
  try {
    process.chdir(root);
    process.env.XDG_CONFIG_HOME = join(root, "user-config");
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin", "docker"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    process.env.PATH = `${join(root, "bin")}:${original.PATH}`;
    console.log = (...args) => {
      output.push(args.join(" "));
    };
    console.error = () => {};
    await run("init");
    assert.equal(existsSync(join(root, ".git")), false);
    assert.equal(existsSync(join(root, "gauge-cases")), false);
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, "gauge.json"), "utf8")),
      { version: 2, inputs: {} },
    );
    await assert.rejects(() => run("run", "--dry-run"), (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "not_found");
      assert.match(error.hint ?? "", /gauge eval create.*gauge preference create/);
      assert.match(error.hint ?? "", /gauge run --eval <id>.*--preference <id>/);
      return true;
    });
    for (const kind of ["eval", "preference"]) {
      await assert.rejects(
        () =>
          run(
            kind,
            "create",
            "--name",
            "MCP",
            "--text",
            "Use the tools",
            "--agent",
            "codex",
            "--mcp",
            "tools@v1",
            ...(kind === "eval"
              ? ["--criterion", "Works: Uses the tools"]
              : ["--kind", "open-ended"]),
          ),
        (error: unknown) => {
          assert.ok(error instanceof CliError);
          assert.match(error.message, /mcpRefs requires hosted Gauge/);
          assert.match(
            error.hint ?? "",
            /supplied files cannot test the live server/,
          );
          assert.match(error.hint ?? "", /gauge onboard/);
          return true;
        },
      );
      assert.deepEqual(await run(kind, "list"), []);
    }
    const evaluation = await run(
      "eval",
      "create",
      "--name",
      " Setup ",
      "--text",
      " Install the SDK ",
      "--criterion",
      "Install: The SDK is configured",
      "--agent",
      "codex",
      "--tag",
      "onboarding",
    );
    assert.equal(evaluation.name, "Setup");
    const criterion = evaluation.criteria[0].id;
    const edited = await run(
      "eval",
      "edit",
      evaluation.id,
      "--name",
      "Quickstart",
    );
    assert.equal(edited.id, evaluation.id);
    assert.equal(edited.revision, 2);
    assert.equal(edited.criteria[0].id, criterion);
    const tagged = await run("eval", "edit", evaluation.id, "--tag", "docs");
    assert.deepEqual(tagged.tags, ["docs"]);
    assert.equal(tagged.criteria[0].id, criterion);
    assert.equal(tagged.revision, 3);
    const retrieved = await run("eval", "get", evaluation.id);
    assert.equal(retrieved.name, "Quickstart");
    assert.equal(retrieved.stats.runCount, 0);
    await run("init");
    assert.equal((await run("eval", "get", evaluation.id)).revision, 3);
    const evalPlan = await run("run", "--eval", evaluation.id, "--dry-run");
    assert.equal(evalPlan.mode, "local");
    assert.equal(evalPlan.expectedSessions, 1);
    assert.equal(evalPlan.cases[0].criteria, 1);
    assert.deepEqual(evalPlan.inputSnapshots, []);
    writeFileSync(
      join(root, "gauge.json"),
      JSON.stringify({
        version: 2,
        inputs: { docs: { type: "files", paths: ["docs/**/*.md"] } },
      }),
    );
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "guide.md"), "Guide");
    mkdirSync(join(root, "draft"));
    writeFileSync(join(root, "draft", "a.md"), "A");
    writeFileSync(join(root, "draft", "notes.txt"), "Notes");
    for (const [binding, source, path] of [
      ["docs", "working-tree", root],
      ["docs=draft", "override", join(root, "draft")],
      ["docs=draft/*.md", "override", join(root, "draft", "*.md")],
    ]) {
      const plan = await run(
        "run",
        "--eval",
        evaluation.id,
        "--input",
        binding,
        "--dry-run",
      );
      assert.deepEqual(
        plan.inputSnapshots.map((s: any) => [s.name, s.source, s.path]),
        [["docs", source, path]],
      );
    }
    await assert.rejects(
      () =>
        run("run", "--eval", evaluation.id, "--input", "other", "--dry-run"),
      /^CliError: Unknown input: other$/,
    );
    await assert.rejects(
      () => run("eval", "edit", evaluation.id, "--input", "docs"),
      /unknown option '--input'/,
    );

    const preference = await run(
      "preference",
      "create",
      "--name",
      "Database choice",
      "--kind",
      "head-to-head",
      "--brand-a",
      "Zeta",
      "--brand-b",
      "alpha",
      "--text",
      "Choose a database",
      "--agent",
      "codex",
    );
    assert.equal(preference.brandA, "alpha");
    assert.equal(preference.brandB, "Zeta");
    assert.equal(preference.scenarios.length, 1);
    const scenario = preference.scenarios[0].id;
    await run(
      "preference",
      "edit",
      preference.id,
      "--name",
      "New database choice",
    );
    assert.equal(
      (await run("preference", "get", preference.id)).scenarios[0].id,
      scenario,
    );
    const taggedPreference = await run(
      "preference",
      "edit",
      preference.id,
      "--tag",
      "choice",
    );
    assert.deepEqual(taggedPreference.tags, ["choice"]);
    const clearedPreference = await run(
      "preference",
      "edit",
      preference.id,
      "--clear-tags",
    );
    assert.deepEqual(clearedPreference.tags, []);
    assert.equal(clearedPreference.scenarios[0].id, scenario);
    const second = await run(
      "preference",
      "scenarios",
      "add",
      preference.id,
      "--repo",
      "https://github.com/acme/demo.git",
      "--ref",
      "main",
    );
    const scenarios = await run(
      "preference",
      "scenarios",
      "list",
      preference.id,
    );
    assert.equal(scenarios.length, 2);
    assert.equal(scenarios[0].id, scenario);
    const preferencePlan = await run(
      "run",
      "--preference",
      preference.id,
      "--scenario",
      second.id,
      "--dry-run",
    );
    assert.equal(preferencePlan.expectedSessions, 1);
    assert.equal(preferencePlan.cases[0].criteria, 0);
    await assert.rejects(
      () =>
        run(
          "preference",
          "scenarios",
          "add",
          preference.id,
          "--repo",
          "https://github.com/acme/demo.git",
          "--ref",
          "main",
        ),
      /already has the same scenario/,
    );
    await run(
      "preference",
      "scenarios",
      "rm",
      preference.id,
      "--scenario",
      second.id,
    );
    await run(
      "preference",
      "scenarios",
      "rm",
      preference.id,
      "--scenario",
      scenario,
    );
    await assert.rejects(
      () => run("run", "--preference", preference.id, "--dry-run"),
      /no scenarios/,
    );
    await assert.rejects(
      () =>
        run(
          "preference",
          "create",
          "--name",
          "Invalid",
          "--kind",
          "head-to-head",
          "--brand-a",
          "ACME",
          "--brand-b",
          " acme ",
          "--text",
          "Choose",
        ),
      /two different/,
    );
    await assert.rejects(
      () =>
        run(
          "eval",
          "create",
          "--name",
          "Daily",
          "--text",
          "Install",
          "--criterion",
          "Works: Works",
          "--agent",
          "codex",
          "--cadence",
          "daily",
        ),
      /managed schedules/,
    );
    const criteriaPath = join(root, "criteria.json");
    writeFileSync(
      criteriaPath,
      JSON.stringify([{ id: "unknown", name: "Unknown", rubric: "Unknown" }]),
    );
    await assert.rejects(
      () => run("eval", "edit", evaluation.id, "--criteria-file", criteriaPath),
      /Unknown criterion ID/,
    );
    assert.equal((await run("eval", "get", evaluation.id)).revision, 3);
    const frozen = localMeasurementSpec(program(), "eval", evaluation.id, {
      agent: [],
      inputs: [],
    });
    assert.deepEqual(frozen.measurement.criterionIds, [criterion]);
    await run("eval", "rm", evaluation.id);
    await assert.rejects(() => run("eval", "get", evaluation.id), /not found/);
  } finally {
    process.chdir(cwd);
    process.env = original;
    console.log = log;
    console.error = error;
    rmSync(root, { recursive: true, force: true });
  }
});

test("local eval statistics use current published verdicts and preserve unknown results", async () => {
  const root = mkdtempSync(join(tmpdir(), "gauge-measurement-stats-"));
  const cwd = process.cwd();
  const output: string[] = [];
  const log = console.log;
  try {
    process.chdir(root);
    writeFileSync(join(root, "gauge.json"), '{"version":2,"inputs":{}}');
    const gaugeDir = join(root, ".gauge");
    const store = openLocalStore(gaugeDir);
    const measurement = store.createMeasurement("eval", {
      name: "Install",
      promptText: "Install",
      agents: [{ agent: "CODEX_CLI", models: [] }],
      criteria: [{ id: "criterion", name: "Install", rubric: "Works" }],
    });
    for (const [id, outcome] of [
      ["pass", "PASS"],
      ["fail", "FAIL"],
      ["unknown", "UNASSESSABLE"],
      ["pending", null],
    ] as const) {
      const directory = join(gaugeDir, "runs", id, "attempts", "1", "session");
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "events.ndjson"),
        '{"turn":1,"text":"Evidence"}\n',
      );
      store.upsertSession({
        id,
        batchId: "batch",
        measurementId: measurement.id,
        measurementKind: "eval",
        measurementRevision: 1,
        case: null,
        agent: "CODEX_CLI",
        model: "gpt-6",
        attempt: 1,
        outcome: "completed",
        endedBy: "session",
        turns: 1,
        createdAt: "2026-10-01T00:00:00Z",
        endedAt: "2026-10-01T00:01:00Z",
        configuration: { case: { criteria: measurement.criteria } },
      });
      if (outcome)
        saveLocalAnalysis(gaugeDir, id, {
          schemaVersion: 1,
          instructionsVersion: "v1",
          analyst: { name: "Codex" },
          assessability: "ASSESSED",
          criteria: [
            {
              criterionId: "criterion",
              outcome,
              label: "Evidence",
              evidence: [
                {
                  kind: "artifact",
                  artifact: "session/events.ndjson",
                  line: 1,
                },
              ],
            },
          ],
        });
    }
    store.close();
    console.log = (...args) => {
      output.push(args.join(" "));
    };
    const program = new Command()
      .option("--local")
      .option("-o, --output <format>");
    registerEval(program);
    await program.parseAsync(["--local", "-o", "json", "eval", "list"], {
      from: "user",
    });
    const rows = JSON.parse(output.join("\n"));
    assert.equal(rows[0].stats.runCount, 4);
    assert.equal(rows[0].stats.judgedRuns, 2);
    assert.equal(rows[0].stats.passedRuns, 1);
    assert.equal(rows[0].stats.passRates.length, 1);
  } finally {
    process.chdir(cwd);
    console.log = log;
    rmSync(root, { recursive: true, force: true });
  }
});
