import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { Command } from "commander";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runEvalBodySchema,
  runVisibilityBodySchema,
} from "@withgauge/api-schemas/ownedConfigurations";
import { runDefinitionSubmissionSchema } from "@withgauge/api-schemas/runDefinitions";
import { register } from "./run";

type RecordedRequest = { url: string; method: string; body: unknown };

async function gauge(
  t: TestContext,
  args: string[],
  response: unknown | ((request: RecordedRequest) => unknown),
): Promise<{ requests: RecordedRequest[]; output: string[]; error?: unknown }> {
  const oldToken = process.env.GAUGE_API_TOKEN;
  const oldUrl = process.env.GAUGE_API_URL;
  process.env.GAUGE_API_TOKEN = "gauge_test";
  process.env.GAUGE_API_URL = "https://test.invalid";
  t.after(() => {
    if (oldToken === undefined) delete process.env.GAUGE_API_TOKEN;
    else process.env.GAUGE_API_TOKEN = oldToken;
    if (oldUrl === undefined) delete process.env.GAUGE_API_URL;
    else process.env.GAUGE_API_URL = oldUrl;
  });
  const requests: RecordedRequest[] = [];
  const output: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) =>
    output.push(args.join(" ")),
  );
  t.mock.method(console, "error", () => {});
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      const request = {
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      requests.push(request);
      return Response.json(
        typeof response === "function" ? response(request) : response,
      );
    },
  );
  const command = new Command()
    .option("--org <org>")
    .option("-o, --output <format>")
    .option("--hosted")
    .option("--local");
  register(command);
  try {
    await command.parseAsync(
      [
        ...(args.includes("--local") ? [] : ["--hosted"]),
        "--org",
        "8c7f0e1a-1111-4222-8333-944455556666",
        "-o",
        "json",
        ...args,
      ],
      {
        from: "user",
      },
    );
  } catch (error) {
    return { requests, output, error };
  }
  return { requests, output };
}

it("sends one-launch overrides with --eval", async (t) => {
  const { requests, error } = await gauge(
    t,
    [
      "run",
      "--eval",
      "e1",
      "--agent",
      "claude-code:sonnet",
      "--samples",
      "2",
      "--yes",
    ],
    { batchIds: [], runIds: [] },
  );
  assert.equal(error, undefined);
  assert.equal(
    requests[0]?.url,
    "https://test.invalid/api/v1/orgs/8c7f0e1a-1111-4222-8333-944455556666/eval-sets/e1/run",
  );
  assert.deepEqual(requests[0]?.body, {
    agents: [{ agent: "CLAUDE_CODE", models: ["sonnet"] }],
    sampleCount: 2,
  });
  assert.equal(
    requests.length,
    1,
    "ordinary launches must not fetch saved hooks",
  );
});

const savedLifecycle = {
  version: 1,
  setup: { source: "console.log('saved setup');", timeoutSeconds: 180 },
  teardown: { source: "console.log('saved teardown');", timeoutSeconds: 45 },
  params: { project: "original" },
};

function scriptFile(t: TestContext, source = "console.log('one-off setup');") {
  const root = mkdtempSync(join(tmpdir(), "gauge-launch-hooks-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "setup.ts");
  writeFileSync(path, source);
  return path;
}

function savedThenLaunch(request: RecordedRequest) {
  return request.method === "GET"
    ? { lifecycle: savedLifecycle }
    : { batchIds: [], runIds: [] };
}

function promptDirectory(t: TestContext): void {
  const cwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "gauge-prompt-hooks-"));
  process.chdir(root);
  t.after(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });
}

for (const dryRun of [false, true]) {
  it(`${dryRun ? "previews" : "launches"} a hosted prompt with uploaded hooks and no saved measurement`, async (t) => {
    promptDirectory(t);
    const setup = scriptFile(t, "console.log('prepare');");
    const teardown = scriptFile(t, "console.log('clean up');");
    const { requests, error } = await gauge(
      t,
      [
        "run",
        "Build a dashboard",
        "--agent",
        "codex:gpt-test",
        "--setup-file",
        setup,
        "--teardown-file",
        teardown,
        "--setup-timeout",
        "180",
        "--teardown-timeout",
        "45",
        "--lifecycle-params",
        '{"feature":"temporary-test"}',
        ...(dryRun ? ["--dry-run"] : ["--yes"]),
      ],
      {},
    );
    assert.equal(error, undefined);
    assert.equal(
      requests.length,
      1,
      "no saved configuration is read or written",
    );
    assert.equal(requests[0].method, "POST");
    assert.match(
      requests[0].url,
      new RegExp(`/run-definitions/${dryRun ? "plan" : "run"}$`),
    );
    const body = runDefinitionSubmissionSchema.parse(requests[0].body);
    assert.deepEqual(body.lifecycle, {
      version: 1,
      setup: { source: "console.log('prepare');", timeoutSeconds: 180 },
      teardown: { source: "console.log('clean up');", timeoutSeconds: 45 },
      params: { feature: "temporary-test" },
    });
    assert.equal(body.cases.length, 1);
    assert.equal(body.cases[0].prompt, "Build a dashboard");
    assert.deepEqual(body.cases[0].preference, {
      kind: "open-ended",
      branded: false,
    });
    assert.deepEqual(body.cases[0].config.agents, [
      { agent: "CODEX_CLI", models: ["gpt-test"] },
    ]);
    assert.equal("lifecycle" in body.cases[0].config, false);
  });
}

it("keeps a hosted prompt without hook flags unchanged", async (t) => {
  promptDirectory(t);
  const { requests, error } = await gauge(
    t,
    ["run", "Build a dashboard", "--agent", "claude-code", "--yes"],
    {},
  );
  assert.equal(error, undefined);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/run-definitions\/run$/);
  const body = runDefinitionSubmissionSchema.parse(requests[0].body);
  assert.equal("lifecycle" in body, false);
  assert.equal(body.cases[0].prompt, "Build a dashboard");
});

for (const withHooks of [true, false]) {
  it(`shows ${withHooks ? "hook deadlines without source or params" : "no hook summary for an ordinary prompt"} in a preview`, async (t) => {
    promptDirectory(t);
    const script = scriptFile(t, "console.log('script-content-marker');");
    const { output, requests, error } = await gauge(
      t,
      [
        "run",
        "Build a dashboard",
        "--dry-run",
        "-o",
        "table",
        ...(withHooks
          ? [
              "--setup-file",
              script,
              "--teardown-file",
              script,
              "--setup-timeout",
              "180",
              "--teardown-timeout",
              "45",
              "--lifecycle-params",
              '{"value":"parameter-content-marker"}',
            ]
          : []),
      ],
      {
        source: { verification: "LOCAL" },
        expectedRuns: 1,
        cases: [],
        resources: [],
        ...(withHooks
          ? {
              lifecycle: {
                setupTimeoutSeconds: 180,
                teardownTimeoutSeconds: 45,
              },
            }
          : {}),
      },
    );
    assert.equal(error, undefined);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/run-definitions\/plan$/);
    const text = output.join("\n");
    assert.match(text, /Expected sessions: 1/);
    if (withHooks) {
      assert.match(text, /Setup hook: 180s deadline/);
      assert.match(text, /Teardown hook: 45s deadline/);
    } else {
      assert.doesNotMatch(text, /Setup hook:|Teardown hook:/);
    }
    assert.doesNotMatch(text, /script-content-marker|parameter-content-marker/);
  });
}

it("validates prompt scripts before making API requests", async (t) => {
  const { requests, error } = await gauge(
    t,
    [
      "run",
      "Build a dashboard",
      "--setup-file",
      "/nonexistent/gauge-hook.ts",
      "--yes",
    ],
    {},
  );
  assert.match(String(error), /could not read --setup-file/);
  assert.equal(requests.length, 0);
});

for (const target of ["eval", "preference"] as const) {
  it(`uploads hooks for one --${target} launch without editing the saved configuration`, async (t) => {
    const path = scriptFile(t);
    const { requests, error } = await gauge(
      t,
      [
        "run",
        `--${target}`,
        "saved-id",
        "--setup-file",
        path,
        "--agent",
        "codex:gpt-test",
        "--samples",
        "2",
        "--yes",
        ...(target === "preference" ? ["--scenario", "scenario-1"] : []),
      ],
      savedThenLaunch,
    );
    assert.equal(error, undefined);
    assert.deepEqual(
      requests.map((r) => r.method),
      ["GET", "POST"],
    );
    const route = target === "eval" ? "eval-sets" : "visibility-prompts";
    assert.match(requests[0].url, new RegExp(`/${route}/saved-id$`));
    assert.equal(requests[1].url, `${requests[0].url}/run`);
    const body = {
      agents: [{ agent: "CODEX_CLI", models: ["gpt-test"] }],
      sampleCount: 2,
      ...(target === "preference"
        ? { visibilityScenarioIds: ["scenario-1"] }
        : {}),
      lifecycle: {
        ...savedLifecycle,
        setup: { source: "console.log('one-off setup');", timeoutSeconds: 180 },
      },
    };
    assert.deepEqual(requests[1].body, body);
    assert.deepEqual(
      (target === "eval" ? runEvalBodySchema : runVisibilityBodySchema).parse(
        body,
      ),
      body,
    );
    assert.equal(savedLifecycle.setup.source, "console.log('saved setup');");
  });

  it(`disables saved hooks only for this --${target} launch`, async (t) => {
    const { requests, error } = await gauge(
      t,
      ["run", `--${target}`, "saved-id", "--clear-lifecycle", "--yes"],
      savedThenLaunch,
    );
    assert.equal(error, undefined);
    assert.deepEqual(
      requests.map((r) => r.method),
      ["GET", "POST"],
    );
    assert.deepEqual(requests[1].body, { lifecycle: null });
  });
}

it("applies timeout, parameters, and phase clearing to the launch snapshot", async (t) => {
  const { requests, error } = await gauge(
    t,
    [
      "run",
      "--eval",
      "saved-id",
      "--clear-setup",
      "--teardown-timeout",
      "60",
      "--lifecycle-params",
      '{"project":"temporary"}',
      "--yes",
    ],
    savedThenLaunch,
  );
  assert.equal(error, undefined);
  assert.deepEqual(
    requests.map((r) => r.method),
    ["GET", "POST"],
  );
  assert.deepEqual(requests[1].body, {
    lifecycle: {
      version: 1,
      teardown: { ...savedLifecycle.teardown, timeoutSeconds: 60 },
      params: { project: "temporary" },
    },
  });
});

it("can add the first hook to a one-off launch", async (t) => {
  const path = scriptFile(t);
  const { requests, error } = await gauge(
    t,
    [
      "run",
      "--eval",
      "saved-id",
      "--setup-file",
      path,
      "--setup-timeout",
      "30",
      "--yes",
    ],
    (request: RecordedRequest) =>
      request.method === "GET"
        ? { lifecycle: null }
        : { batchIds: [], runIds: [] },
  );
  assert.equal(error, undefined);
  assert.deepEqual(requests[1].body, {
    lifecycle: {
      version: 1,
      setup: { source: "console.log('one-off setup');", timeoutSeconds: 30 },
      params: {},
    },
  });
});

it("does not launch when a hook file cannot be read", async (t) => {
  const { requests, error } = await gauge(
    t,
    [
      "run",
      "--eval",
      "saved-id",
      "--setup-file",
      "/nonexistent/gauge-hook.ts",
      "--yes",
    ],
    savedThenLaunch,
  );
  assert.match(String(error), /could not read --setup-file/);
  assert.deepEqual(
    requests.map((r) => r.method),
    ["GET"],
  );
});

for (const args of [
  ["--local", "run", "--eval", "e1"],
  ["run"],
  ["run", "--apply", "missing.json"],
  ["--local", "run", "Build a dashboard"],
  ["run", "Build a dashboard", "--schema"],
  ["run", "--schema"],
  ["run", "--example"],
  ["run", "--verify"],
  ["run", "--eval", "e1", "--dry-run"],
]) {
  it(`rejects lifecycle flags before file IO or API calls for ${args.join(" ")}`, async (t) => {
    const { requests, error } = await gauge(
      t,
      [...args, "--setup-file", "/nonexistent/gauge-hook.ts"],
      {},
    );
    assert.match(
      String(error),
      /Lifecycle (hooks require hosted Gauge|flags apply only)/,
    );
    assert.equal(requests.length, 0);
  });
}

it("rejects hook launch flags on a run read subcommand", async (t) => {
  const { requests, error } = await gauge(
    t,
    ["run", "get", "r1", "--clear-lifecycle"],
    {},
  );
  assert.match(String(error), /--clear-lifecycle is a launch flag/);
  assert.equal(requests.length, 0);
});

it("rejects a repeated --eval instead of dropping ids", async (t) => {
  const { requests, error } = await gauge(
    t,
    ["run", "--eval", "e1", "--eval", "e2", "--yes"],
    {},
  );
  assert.match(String(error), /--eval takes one id/);
  assert.equal(requests.length, 0);
});

it("rejects project inputs on a hosted saved eval", async (t) => {
  const { requests, error } = await gauge(
    t,
    ["run", "--eval", "e1", "--input", "docs", "--yes"],
    {},
  );
  assert.match(
    String(error),
    /Hosted saved measurements do not take project inputs/,
  );
  assert.equal(requests.length, 0);
});

it("rejects --samples without a saved eval set or preference prompt", async (t) => {
  const { requests, error } = await gauge(
    t,
    ["run", "--samples", "2", "--yes"],
    {},
  );
  assert.match(
    String(error),
    /--agent and --samples apply with --eval or --preference/,
  );
  assert.equal(requests.length, 0);
});

it("routes run list --agent to the list filter, not the launch flag", async (t) => {
  const { error } = await gauge(t, ["run", "list", "--agent", "claude-code"], {
    items: [],
  });
  assert.match(String(error), /--agent works only on local runs/);
});

it("posts compare sides", async (t) => {
  const { requests, error } = await gauge(
    t,
    [
      "run",
      "compare",
      "--baseline",
      "request=r1",
      "--candidate",
      "eval=e1",
      "--candidate",
      "since=2h",
    ],
    {},
  );
  assert.equal(error, undefined);
  assert.equal(
    requests[0]?.url,
    "https://test.invalid/api/v1/orgs/8c7f0e1a-1111-4222-8333-944455556666/runs/compare",
  );
  assert.deepEqual(requests[0]?.body, {
    baseline: { runRequest: "r1" },
    candidate: { evalSet: "e1", since: "2h" },
  });
});

it("rejects hosted-only compare selectors in local mode", async (t) => {
  const { requests, error } = await gauge(
    t,
    [
      "--local",
      "run",
      "compare",
      "--baseline",
      "request=r1",
      "--candidate",
      "request=r2",
    ],
    {},
  );
  assert.match(String(error), /--baseline request= select hosted runs/);
  assert.equal(requests.length, 0);
});

it("rejects a request ID for local wait", async (t) => {
  const { requests, error } = await gauge(
    t,
    ["--local", "run", "wait", "r1"],
    {},
  );
  assert.match(String(error), /Local wait takes --batch/);
  assert.equal(requests.length, 0);
});

it("rejects --batch for hosted wait", async (t) => {
  const { requests, error } = await gauge(
    t,
    ["--hosted", "run", "wait", "--batch", "b1"],
    {},
  );
  assert.match(String(error), /--batch is local only/);
  assert.equal(requests.length, 0);
});
