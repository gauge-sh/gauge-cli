import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { RunDefinitionSubmission } from "@withgauge/api-schemas/runDefinitions";
import { checkLocalRuntimeCompatibility } from "./localRuntimeCompatibility";
import {
  detachLocal,
  planLocal,
  prepareLocal,
  runLocal,
} from "./localExecutor";
import { openLocalStore } from "./localStore";

const definition = {
  resources: [],
  cases: [
    {
      path: "case.md",
      prompt: "Hello",
      config: { agents: [{ agent: "CLAUDE_CODE" }] },
    },
  ],
} as unknown as RunDefinitionSubmission;

async function fakeDocker(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "gauge-runtime-test-"));
  const original = process.env.PATH;
  const priorConfig = process.env.XDG_CONFIG_HOME;
  const priorKey = process.env.ANTHROPIC_API_KEY;
  const state = {
    imageId: `sha256:${"a".repeat(64)}`,
    output: "GAUGE_RUNTIME_COMPATIBLE\n",
    error: "",
  };
  const stateFile = join(root, "state.json");
  const log = join(root, "calls.jsonl");
  const save = () => writeFile(stateFile, JSON.stringify(state));
  await save();
  await writeFile(
    join(root, "docker"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2), state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'version') console.log(JSON.stringify({Os:'linux',Arch:'amd64'}));
else if (args[0] === 'image') console.log(JSON.stringify([{Id:state.imageId,Os:'linux',Architecture:'amd64',Config:{Labels:{'sh.gauge.contract':'1'}}}]));
else if (args[0] === 'run') { process.stdout.write(state.output); if(state.error) { process.stderr.write(state.error); process.exitCode = 1; } }
else if (args[0] !== 'rm') process.exitCode = 1;
`,
  );
  await chmod(join(root, "docker"), 0o755);
  process.env.PATH = `${root}:${original}`;
  process.env.XDG_CONFIG_HOME = root;
  process.env.ANTHROPIC_API_KEY = "runtime-test-only";
  t.after(async () => {
    process.env.PATH = original;
    if (priorConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorConfig;
    if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorKey;
    await rm(root, { recursive: true, force: true });
  });
  const calls = async (): Promise<string[][]> =>
    (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  return { root, state, save, calls };
}

test("custom-image dry run reports identity without starting or pulling containers", async (t) => {
  const f = await fakeDocker(t);
  const plan = await planLocal(definition, { runtimeImage: "custom:test" });
  assert.equal(plan.runtime.reference, "custom:test");
  assert.equal(plan.runtime.imageId, f.state.imageId);
  assert.equal(plan.runtimeProbe, "not_run");
  assert.ok(
    (await f.calls()).every((args) => ["version", "image"].includes(args[0])),
  );
});

test("local cases reject hosted settings before credential or runtime preflight", async () => {
  for (const [field, value] of [
    ["profileId", "persona-1"],
    ["skillRefs", ["docs@latest"]],
    ["mcpRefs", ["tools@latest"]],
    ["connectionIds", ["connection-1"]],
    ["addons", { browser: { session: "test", projectId: 1, region: "us" } }],
  ] as const) {
    const unsupported = {
      ...definition,
      cases: [
        {
          ...definition.cases[0],
          config: { ...definition.cases[0].config, [field]: value },
        },
      ],
    };
    await assert.rejects(
      planLocal(unsupported),
      new RegExp(`config\\.${field} requires hosted Gauge`),
    );
    if (field === "mcpRefs")
      await assert.rejects(planLocal(unsupported), (error: unknown) => {
        const hint = (error as { hint: string }).hint;
        assert.match(hint, /no local MCP configuration/);
        assert.match(
          hint,
          /Do not issue hosted commands for a local-only request/,
        );
        assert.match(
          hint,
          /Login and static verification do not establish server reachability or access/,
        );
        return true;
      });
  }
  await assert.rejects(
    planLocal({
      ...definition,
      cases: [
        {
          ...definition.cases[0],
          config: { ...definition.cases[0].config, repoRef: "main" },
        },
      ],
    }),
    /repoRef requires config.repoUrl/,
  );
  await assert.rejects(
    planLocal({
      ...definition,
      cases: [
        {
          ...definition.cases[0],
          config: { ...definition.cases[0].config, inputs: ["missing"] },
        },
      ],
    }),
    /input missing is missing/,
  );
});

test("GitHub trigger rules and empty hosted settings do not change an interactive local case", async (t) => {
  await fakeDocker(t);
  const configured = {
    ...definition,
    cases: [
      {
        ...definition.cases[0],
        config: {
          ...definition.cases[0].config,
          profileId: null,
          skillRefs: [],
          mcpRefs: [],
          connectionIds: [],
          addons: {},
          checks: { paths: ["unrelated/**"] },
        },
      },
    ],
  };
  assert.equal((await planLocal(configured)).expectedSessions, 1);
});

test("probe honors entrypoint, passes no credentials, disables networking, and cleans up", async (t) => {
  const f = await fakeDocker(t);
  await checkLocalRuntimeCompatibility(f.state.imageId, ["codex", "pi"]);
  const calls = await f.calls();
  const run = calls.find((args) => args[0] === "run")!;
  assert.equal(run[run.indexOf("--network") + 1], "none");
  assert.equal(run[run.indexOf("--pull") + 1], "never");
  assert.equal(
    run[run.indexOf("--user") + 1],
    `${process.getuid!()}:${process.getgid!()}`,
  );
  assert.ok(!run.includes("--entrypoint"));
  assert.ok(!run.some((arg) => /TOKEN|API_KEY|auth\.json/.test(arg)));
  assert.match(run.at(-1)!, /codex --version/);
  assert.match(run.at(-1)!, /pi --version/);
  assert.ok(calls.some((args) => args[0] === "rm" && args[1] === "--force"));
});

test("probe rejects ignored commands and broken tools with actionable errors", async (t) => {
  const f = await fakeDocker(t);
  f.state.output = "custom entrypoint banner\n";
  await f.save();
  await assert.rejects(
    checkLocalRuntimeCompatibility(f.state.imageId, ["codex"]),
    /did not execute Gauge/,
  );
  f.state.error = "missing or broken harness: codex";
  await f.save();
  await assert.rejects(
    checkLocalRuntimeCompatibility(f.state.imageId, ["codex"]),
    /missing or broken harness: codex/,
  );
  assert.equal((await f.calls()).filter((args) => args[0] === "rm").length, 2);
});

test("a prepared batch preserves immutable runtime identity when its tag moves", async (t) => {
  const f = await fakeDocker(t);
  const gaugeDir = join(f.root, ".gauge");
  const frozenId = f.state.imageId;
  const batchId = await prepareLocal(definition, [], gaugeDir, {
    runtimeImage: "custom:moving",
  });
  f.state.imageId = `sha256:${"b".repeat(64)}`;
  await f.save();
  await runLocal(definition, [], gaugeDir, () => {}, { batchId });
  const [runId] = await readdir(join(gaugeDir, "runs"));
  const spec = JSON.parse(
    await readFile(
      join(gaugeDir, "runs", runId, "attempts/1/spec.json"),
      "utf8",
    ),
  );
  const status = JSON.parse(
    await readFile(join(gaugeDir, "batches", batchId, "status.json"), "utf8"),
  );
  assert.equal(spec.session.image, frozenId);
  assert.equal(spec.runtime.reference, "custom:moving");
  assert.equal(status.runtime.imageId, frozenId);
  assert.equal(
    (await f.calls()).filter((args) => args[0] === "image").length,
    1,
  );
  const store = openLocalStore(gaugeDir);
  try {
    const session = store.getSession(runId)!;
    assert.equal(session.launchId, batchId);
    assert.equal(session.agent, "CLAUDE_CODE");
    assert.equal(session.outcome, "failed");
    assert.ok(session.durationMs !== null && session.durationMs !== undefined);
    assert.deepEqual(store.getLaunch(batchId)?.configuration, definition);
  } finally {
    store.close();
  }
});

test("failed sessions preserve measurement revision, frozen criterion IDs, and repairable provenance", async (t) => {
  const f = await fakeDocker(t);
  const gaugeDir = join(f.root, ".gauge");
  const store = openLocalStore(gaugeDir);
  const saved = store.createMeasurement("eval", {
    name: "Checkout",
    promptText: "Make checkout work",
  });
  store.close();
  const source = {
    repoUrl: null,
    commit: null,
    digest: `sha256:${"c".repeat(64)}`,
    verification: "LOCAL" as const,
  };
  const captured: RunDefinitionSubmission = {
    ...definition,
    source,
    cases: [
      {
        ...definition.cases[0],
        criteria: [{ name: "Checkout", rubric: "Checkout completes" }],
      },
    ],
  };
  const measurement = {
    id: saved.id,
    kind: "eval" as const,
    revision: saved.revision,
    criterionIds: ["checkout-completes"],
  };
  const batchId = await prepareLocal(captured, [], gaugeDir, { measurement });
  let observedStarting = false;
  const result = await runLocal(captured, [], gaugeDir, () => {}, {
    batchId,
    measurement,
    onStart: () => {
      const reader = openLocalStore(gaugeDir);
      try {
        assert.equal(
          reader.getLaunch(batchId)?.measurementRevision,
          saved.revision,
        );
        observedStarting = true;
      } finally {
        reader.close();
      }
    },
  });
  assert.equal(observedStarting, true);
  const runId = result.runs[0].id;
  const spec = JSON.parse(
    await readFile(
      join(gaugeDir, "runs", runId, "attempts/1/spec.json"),
      "utf8",
    ),
  );
  assert.equal(spec.case.criteria[0].id, "checkout-completes");
  assert.deepEqual(spec.measurement, measurement);
  assert.deepEqual(spec.provenance, source);
  const reader = openLocalStore(gaugeDir);
  try {
    const before = reader.getSession(runId)!;
    assert.equal(before.measurementId, saved.id);
    assert.equal(before.measurementRevision, 1);
    assert.equal(before.outcome, "failed");
    reader.db.prepare("DELETE FROM sessions WHERE id = ?").run(runId);
    assert.deepEqual(reader.repairSessionSummaries(), {
      repaired: 1,
      skipped: [],
    });
    const repaired = reader.getSession(runId)!;
    assert.equal(repaired.measurementId, saved.id);
    assert.equal(repaired.agent, "CLAUDE_CODE");
    assert.deepEqual(repaired.configuration, before.configuration);
    assert.deepEqual(repaired.provenance, before.provenance);
  } finally {
    reader.close();
  }
});

test(
  "detached workers retain saved measurement identity in SQLite",
  { timeout: 20_000 },
  async (t) => {
    const f = await fakeDocker(t);
    const gaugeDir = join(f.root, ".gauge");
    const store = openLocalStore(gaugeDir);
    const saved = store.createMeasurement("preference", {
      name: "Database choice",
      promptText: "Choose a database",
    });
    store.close();
    const measurement = {
      id: saved.id,
      kind: "preference" as const,
      revision: 1,
    };
    const batch = await detachLocal(definition, [], gaugeDir, { measurement });
    const statusPath = join(gaugeDir, "batches", batch.batchId, "status.json");
    const deadline = Date.now() + 10_000;
    for (;;) {
      const status = JSON.parse(await readFile(statusPath, "utf8"));
      if (["completed", "failed", "canceled"].includes(status.state)) break;
      assert.ok(Date.now() < deadline, "background worker did not settle");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const reader = openLocalStore(gaugeDir);
    try {
      const sessions = reader.listSessions();
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].measurementId, saved.id);
      assert.equal(sessions[0].measurementKind, "preference");
      assert.equal(sessions[0].measurementRevision, 1);
      assert.equal(sessions[0].launchId, batch.batchId);
      assert.equal(reader.getLaunch(batch.batchId)?.measurementId, saved.id);
    } finally {
      reader.close();
    }
  },
);

test(
  "derived Python runtime passes the real credential-free probe",
  {
    skip: !process.env.GAUGE_CUSTOM_RUNTIME_TEST_IMAGE,
    timeout: 90_000,
  },
  async () => {
    const image = process.env.GAUGE_CUSTOM_RUNTIME_TEST_IMAGE!;
    await checkLocalRuntimeCompatibility(image, [
      "claude-code",
      "codex",
      "pi",
      "opencode",
    ]);
    const { stdout } = await promisify(execFile)("docker", [
      "run",
      "--rm",
      "--network",
      "none",
      image,
      "python3",
      "--version",
    ]);
    assert.match(stdout, /^Python 3\./);
  },
);
