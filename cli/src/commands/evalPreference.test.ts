import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { Command, CommanderError } from "commander";
import { CliError } from "../lib/client";
import { evalSetRow } from "../lib/evalSets";
import { preferencePromptRow } from "../lib/preferencePrompts";
import { register as registerRun } from "./run";
import { register as registerEval } from "./eval";
import { register as registerPreference } from "./preference";

type Request = { method: string; url: string; body: unknown };

function useApi(t: TestContext, response: unknown = { items: [] }): Request[] {
  const previousToken = process.env.GAUGE_API_TOKEN;
  const previousUrl = process.env.GAUGE_API_URL;
  process.env.GAUGE_API_TOKEN = "gauge_test";
  process.env.GAUGE_API_URL = "https://test.invalid";
  t.after(() => {
    if (previousToken === undefined) delete process.env.GAUGE_API_TOKEN;
    else process.env.GAUGE_API_TOKEN = previousToken;
    if (previousUrl === undefined) delete process.env.GAUGE_API_URL;
    else process.env.GAUGE_API_URL = previousUrl;
  });
  const requests: Request[] = [];
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        method: init?.method ?? "GET",
        url: String(url).replace("https://test.invalid", ""),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json(response);
    },
  );
  return requests;
}

function program(): Command {
  const root = new Command()
    .option("--org <org>")
    .option("-o, --output <format>")
    .option("--local")
    .option("--hosted")
    .exitOverride();
  registerRun(root);
  registerEval(root);
  registerPreference(root);
  return root;
}

async function gauge(args: string[], mode = "--hosted"): Promise<void> {
  await program().parseAsync(["--org", "8c7f0e1a-1111-4222-8333-944455556666", "-o", "json", mode, ...args], {
    from: "user",
  });
}

async function usageError(args: string[], mode?: string): Promise<string> {
  try {
    await gauge(args, mode);
  } catch (error) {
    assert.ok(error instanceof CliError, String(error));
    assert.equal(error.exitCode, 2);
    return [error.message, error.hint].filter(Boolean).join("\n");
  }
  assert.fail(`expected a usage error for ${args.join(" ")}`);
}

describe("gauge eval and gauge preference", () => {
  it("routes each command to its own API", async (t) => {
    const requests = useApi(t, { id: "x", tags: [] });
    await gauge(["eval", "get", "e1"]);
    await gauge(["preference", "rm", "p1"]);
    await gauge(["eval", "edit", "e1", "--tag", "beta"]);
    await gauge(["preference", "scenarios", "rm", "p1", "--scenario", "s1"]);
    await gauge([
      "preference",
      "create",
      "--name",
      "Deploy CLI",
      "--kind",
      "open-ended",
      "--text",
      "Which CLI should I deploy with?",
    ]);
    assert.deepEqual(
      requests.map(({ method, url }) => `${method} ${url}`),
      [
        "GET /api/v1/orgs/8c7f0e1a-1111-4222-8333-944455556666/eval-sets/e1",
        "DELETE /api/v1/orgs/8c7f0e1a-1111-4222-8333-944455556666/visibility-prompts/p1",
        "PATCH /api/v1/orgs/8c7f0e1a-1111-4222-8333-944455556666/eval-sets/e1",
        "DELETE /api/v1/orgs/8c7f0e1a-1111-4222-8333-944455556666/visibility-prompts/p1/scenarios/s1",
        "POST /api/v1/orgs/8c7f0e1a-1111-4222-8333-944455556666/visibility-prompts",
      ],
    );
    assert.deepEqual(requests[2].body, { tags: ["beta"] });
    assert.deepEqual(requests[4].body, {
      name: "Deploy CLI",
      promptText: "Which CLI should I deploy with?",
      kind: "RECOMMEND",
      brandA: null,
      brandB: null,
      marketId: null,
      scenarios: [],
    });
  });

  it("rejects flags that belong to the other command", async () => {
    for (const args of [
      ["eval", "create", "--name", "x", "--kind", "open-ended"],
      ["preference", "edit", "p1", "--criterion", "A: b"],
      ["preference", "list", "--since", "2026-10-01"],
    ])
      await assert.rejects(
        program().parseAsync(["--org", "8c7f0e1a-1111-4222-8333-944455556666", "--hosted", ...args], {
          from: "user",
        }),
        (error) =>
          error instanceof CommanderError &&
          error.code === "commander.unknownOption",
      );
  });

  it("replaces and clears tags through edit, rejecting conflicting flags", async (t) => {
    const requests = useApi(t, { id: "x", tags: [] });
    for (const command of ["eval", "preference"]) {
      await gauge([command, "edit", "x", "--tag", "beta"]);
      await gauge([command, "edit", "x", "--clear-tags"]);
      assert.equal(
        await usageError([command, "edit", "x", "--tag", "beta", "--clear-tags"]),
        "--tag and --clear-tags conflict",
      );
    }
    assert.deepEqual(
      requests.map(({ body }) => body),
      [{ tags: ["beta"] }, { tags: [] }, { tags: ["beta"] }, { tags: [] }],
    );
  });
});

describe("gauge run", () => {
  it("combines list filters, and keeps --preference on its verdict endpoint", async (t) => {
    const requests = useApi(t);
    await gauge(["run", "list", "--eval", "e1", "--status", "failed"]);
    await gauge(["run", "list", "--preference", "p1"]);
    assert.deepEqual(
      requests.map(({ url }) => url),
      [
        "/api/v1/orgs/8c7f0e1a-1111-4222-8333-944455556666/runs?status=failed&evalSet=e1&limit=50",
        "/api/v1/orgs/8c7f0e1a-1111-4222-8333-944455556666/visibility-prompts/p1/runs?limit=50",
      ],
    );
    assert.match(
      await usageError(["run", "list", "--preference", "p1", "--since", "7d"]),
      /takes no other filter; drop --since/,
    );
    assert.match(
      await usageError(["run", "list", "--unanalyzed"]),
      /--unanalyzed works only on local runs/,
    );
  });

  it("takes one launch source, and launch flags only on the launch", async (t) => {
    useApi(t);
    assert.match(
      await usageError(["run", "--eval", "e1", "--apply", "spec.json"]),
      /pass only one of --eval, --apply/,
    );
    assert.match(
      await usageError(["run", "--verify", "--dry-run"]),
      /--verify checks the eval files in this repo; drop --dry-run/,
    );
    assert.match(
      await usageError(["run", "--scenario", "s1"]),
      /--scenario applies with --preference only/,
    );
    assert.match(
      await usageError(["run", "--schema", "--eval", "e1"]),
      /--schema prints and exits/,
    );
    assert.match(
      await usageError(["run", "get", "r1", "--apply", "spec.json"]),
      /--apply is a launch flag; `gauge run get` does not take it/,
    );
    assert.match(
      await usageError(["run", "e1"]),
      /unknown run command "e1"\. Launch a saved eval set or preference prompt with `gauge run --eval <id>`/,
    );
  });

  it("keeps --local runs off hosted Gauge", async (t) => {
    const requests = useApi(t, { runIds: ["r1"], batchIds: ["b1"] });
    const cwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "gauge-local-"));
    t.after(() => {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    });
    process.chdir(dir);
    await assert.rejects(gauge(["run"], "--local"), (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 2);
      assert.match(error.message, /Local runs need a Gauge workspace/);
      return true;
    });
    await assert.rejects(
      gauge(["run", "--eval", "e1", "--yes"], "--local"),
      (error) =>
        error instanceof CliError && /No Gauge workspace/.test(error.message),
    );
    assert.deepEqual(requests, []);
  });

  it("plans a local case spec locally, with no org or API call", async (t) => {
    const requests = useApi(t, { runIds: ["r1"], batchIds: ["b1"] });
    const cwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "gauge-local-plan-"));
    t.after(() => {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "gauge.json"), '{"version":2}');
    writeFileSync(
      join(dir, "cases.json"),
      JSON.stringify({
        version: 2,
        cases: [
          {
            key: "quick",
            prompt: "Do the task.",
            config: { agents: [{ agent: "CODEX_CLI" }], sampleCount: 2 },
          },
        ],
      }),
    );
    process.chdir(dir);
    const log = t.mock.method(console, "log", () => {});
    await gauge(["run", "--apply", "cases.json", "--dry-run"], "--local");
    assert.deepEqual(requests, []);
    const plan = JSON.parse(String(log.mock.calls[0].arguments[0]));
    assert.equal(plan.mode, "local");
    assert.equal(plan.expectedSessions, 2);
  });

  it("raises commander usage errors in subcommands through exitOverride", async () => {
    await assert.rejects(
      program().parseAsync(["run", "get"], { from: "user" }),
      (error) => error instanceof CommanderError && error.exitCode !== 0,
    );
  });
});

describe("creator attribution", () => {
  const creators = {
    named: { userId: "u1", email: "ann@acme.test", name: "Ann" },
    emailOnly: { userId: null, email: "gone@acme.test", name: null },
    gauge: { userId: null, email: null, name: "Gauge" },
  };
  const evalItem = (createdBy?: unknown) =>
    ({
      id: "e",
      name: "E",
      criteria: [],
      tags: [],
      stats: { judgedRuns: 0, passedRuns: 0, runCount: 0 },
      ...(createdBy === undefined ? {} : { createdBy }),
    }) as unknown as Parameters<typeof evalSetRow>[0];
  const promptItem = (createdBy?: unknown) =>
    ({
      id: "p",
      name: "P",
      kind: "RECOMMEND",
      market: null,
      tags: [],
      runCount: 0,
      lastRunAt: null,
      ...(createdBy === undefined ? {} : { createdBy }),
    }) as unknown as Parameters<typeof preferencePromptRow>[0];

  it("shows name, then email, then --, with Gauge as a name", () => {
    const labels = [
      creators.named,
      creators.emailOnly,
      null,
      creators.gauge,
      undefined,
    ].map((createdBy) => ({
      eval: evalSetRow(evalItem(createdBy))["created by"],
      preference: preferencePromptRow(promptItem(createdBy))["created by"],
    }));
    assert.deepEqual(
      labels.map((l) => l.eval),
      ["Ann", "gone@acme.test", "--", "Gauge", "--"],
    );
    assert.deepEqual(
      labels.map((l) => l.preference),
      labels.map((l) => l.eval),
    );
  });

  it("passes createdBy through --json and filters by email or me", async (t) => {
    const items = [
      { ...evalItem(creators.named), id: "mine" },
      { ...evalItem(creators.emailOnly), id: "other" },
      { ...evalItem(), id: "old" },
    ];
    const requests = useApi(t, {
      items,
      user: { id: "u1", email: "ann@acme.test" },
    });
    const ids = (): string[] =>
      JSON.parse(
        String((console.log as unknown as { mock: { calls: { arguments: unknown[] }[] } }).mock.calls.at(-1)?.arguments[0]),
      ).map((i: { id: string }) => i.id);

    await gauge(["eval", "list"]);
    assert.deepEqual(ids(), ["mine", "other", "old"]);
    await gauge(["eval", "list", "--created-by", "GONE@acme.test"]);
    assert.deepEqual(ids(), ["other"]);
    await gauge(["preference", "list", "--created-by", "me"]);
    assert.deepEqual(ids(), ["mine"]);
    assert.ok(requests.some((r) => r.url === "/api/v1/me"));
  });
});
