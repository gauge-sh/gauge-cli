import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { Command } from "commander";
import { register } from "./run";

async function gauge(
  t: TestContext,
  args: string[],
  response: unknown,
): Promise<{ requests: { url: string; body: unknown }[]; error?: unknown }> {
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
  const requests: { url: string; body: unknown }[] = [];
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json(response);
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
        "my-org",
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
    "https://test.invalid/api/v1/orgs/my-org/eval-sets/e1/run",
  );
  assert.deepEqual(requests[0]?.body, {
    agents: [{ agent: "CLAUDE_CODE", models: ["sonnet"] }],
    sampleCount: 2,
  });
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
  assert.match(String(error), /Hosted saved measurements do not take project inputs/);
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
    "https://test.invalid/api/v1/orgs/my-org/runs/compare",
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
