import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { Command } from "commander";
import { register } from "./run";
import { SMALL_DOG_LOGO } from "../lib/logo";

async function gauge(
  t: TestContext,
  args: string[],
  response: unknown,
): Promise<{
  requests: { url: string; body: unknown }[];
  output: unknown[];
  notices: string[];
  error?: unknown;
}> {
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
  const output: unknown[] = [];
  const notices: string[] = [];
  t.mock.method(console, "log", (chunk: unknown) => output.push(chunk));
  t.mock.method(console, "error", (chunk: unknown) => notices.push(String(chunk)));
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
    return { requests, output, notices, error };
  }
  return { requests, output, notices };
}

it("sends one-launch overrides with --eval", async (t) => {
  const { requests, output, notices, error } = await gauge(
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
    { batchIds: ["b1"], runIds: ["r1"] },
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
  assert.deepEqual(output.map((chunk) => JSON.parse(String(chunk))), [
    { batchIds: ["b1"], runIds: ["r1"] },
  ]);
  assert.equal(notices.length, 1);
  assert.ok(notices[0].includes(SMALL_DOG_LOGO));
  assert.match(notices[0], /"Watch running sessions" link immediately to its right/);
  assert.match(notices[0], /gauge watch/);
});

for (const flag of ["--eval", "--preference"] as const) {
  it(`does not add launch reminders when ${flag} enqueues no sessions`, async (t) => {
    const result = await gauge(t, ["run", flag, "saved1", "--yes"], {
      batchIds: [],
      runIds: [],
    });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.notices, []);
  });
}

it("reminds for an accepted eval request before sessions are created", async (t) => {
  const result = await gauge(t, ["run", "--eval", "e1", "--yes"], {
    batchIds: [],
    runIds: [],
    runRequestId: "request1",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.notices.length, 1);
  assert.ok(result.notices[0].includes(SMALL_DOG_LOGO));
});

it("reminds for a launched preference prompt", async (t) => {
  const result = await gauge(t, ["run", "--preference", "p1", "--yes"], {
    batchIds: ["b1"],
    runIds: ["r1"],
  });
  assert.equal(result.error, undefined);
  assert.equal(result.notices.length, 1);
  assert.ok(result.notices[0].includes(SMALL_DOG_LOGO));
});

for (const scenario of [
  { name: "configuration-only apply", expand: false, dryRun: false, runIds: [], reminder: false },
  { name: "blocked expansion", expand: true, dryRun: false, runIds: [], reminder: false },
  { name: "successful expansion", expand: true, dryRun: false, runIds: ["r1"], reminder: true },
  { name: "partially blocked expansion", expand: true, dryRun: false, runIds: ["r1"], reminder: true },
  { name: "battery preview", expand: true, dryRun: true, runIds: [], reminder: false },
]) {
  it(`handles the launch reminder for a ${scenario.name}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "gauge-launch-reminder-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "battery.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        expand: scenario.expand,
        prompts: [{ key: "health", text: "Add a health endpoint" }],
      }),
    );
    const result = await gauge(
      t,
      ["run", "--apply", path, ...(scenario.dryRun ? ["--dry-run"] : [])],
      scenario.dryRun
        ? { expand: true, summary: { runsToEnqueue: 1 } }
        : {
            batchIds: scenario.runIds.length ? ["b1"] : [],
            runIds: scenario.runIds,
            ...(scenario.name.includes("blocked")
              ? { blocked: "insufficient_credits" }
              : {}),
          },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.requests.length, 1);
    assert.equal(
      result.notices.filter((notice) => notice.includes(SMALL_DOG_LOGO)).length,
      scenario.reminder ? 1 : 0,
    );
  });
}

it("does not add launch reminders to examples", async (t) => {
  const example = await gauge(t, ["run", "--example"], {});
  assert.equal(example.error, undefined);
  assert.ok(example.notices.every((notice) => !notice.includes(SMALL_DOG_LOGO)));
});

it("does not add launch reminders to failed launches", async (t) => {
  const failed = await gauge(t, ["run", "--eval", "e1", "--agent", "unknown", "--yes"], {});
  assert.ok(failed.error);
  assert.equal(failed.requests.length, 0);
  assert.deepEqual(failed.notices, []);
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
