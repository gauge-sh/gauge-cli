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
import { register } from "./run";

type RecordedRequest = { url: string; method: string; body: unknown };

async function gauge(
  t: TestContext,
  args: string[],
  response: unknown | ((request: RecordedRequest) => unknown),
): Promise<{ requests: RecordedRequest[]; error?: unknown }> {
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
  t.mock.method(console, "log", () => {});
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
    return { requests, error };
  }
  return { requests };
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
  ["run", "Build a dashboard"],
  ["--local", "run", "Build a dashboard"],
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
