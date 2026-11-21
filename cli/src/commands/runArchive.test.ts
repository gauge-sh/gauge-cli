import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { Command } from "commander";
import {
  archiveRunsRequestSchema,
  archiveRunsResponseSchema,
  MAX_ARCHIVE_RUNS,
} from "../../api-schemas/runs";
import { register } from "./run";

const ORG = "00000000-0000-4000-8000-000000000001";
const ARCHIVE_URL = `https://test.invalid/api/v1/orgs/${ORG}/runs/archive`;

type Call = { url: string; method?: string; body?: unknown };

function setup(t: TestContext, respond: (call: Call) => Response) {
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
  const calls: Call[] = [];
  const output: string[] = [];
  t.mock.method(console, "log", (line: string) => output.push(line));
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      const call = {
        url: String(url),
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      return respond(call);
    },
  );
  const gauge = async (...args: string[]) => {
    const command = new Command()
      .option("--hosted", "use hosted", true)
      .option("--org <org>")
      .option("-o, --output <format>");
    register(command);
    await command.parseAsync(["--org", ORG, ...args], { from: "user" });
  };
  return { calls, output, gauge };
}

function archiveResponse(call: Call): Response {
  const { runIds, archived } = archiveRunsRequestSchema.parse(call.body);
  return Response.json(
    archiveRunsResponseSchema.parse({
      runs: runIds.map((id) => ({
        id,
        archivedAt: archived ? "2026-11-20T00:00:00.000Z" : null,
      })),
    }),
  );
}

it("archives runs through the org bulk route", async (t) => {
  const { calls, output, gauge } = setup(t, archiveResponse);
  await gauge("run", "archive", "run-1", "run-2", "run-1", "--yes");
  assert.deepEqual(calls, [
    {
      url: ARCHIVE_URL,
      method: "POST",
      body: { runIds: ["run-1", "run-2"], archived: true },
    },
  ]);
  assert.equal(output[0], "Run run-1: archived at 2026-11-20T00:00:00.000Z");
  assert.equal(output[1], "Run run-2: archived at 2026-11-20T00:00:00.000Z");
});

it("chunks large archive requests", async (t) => {
  const { calls, gauge } = setup(t, archiveResponse);
  const ids = Array.from(
    { length: MAX_ARCHIVE_RUNS + 1 },
    (_, i) => `run-${i}`,
  );
  await gauge("-o", "json", "run", "archive", ...ids, "--yes");
  assert.deepEqual(
    calls.map((call) => (call.body as { runIds: string[] }).runIds.length),
    [MAX_ARCHIVE_RUNS, 1],
  );
});

it("refuses to archive several runs without confirmation", async (t) => {
  const { calls, gauge } = setup(t, archiveResponse);
  await assert.rejects(gauge("run", "archive", "run-1", "run-2"), /--yes/);
  assert.equal(calls.length, 0);
});

it("unarchives runs without confirmation", async (t) => {
  const { calls, output, gauge } = setup(t, archiveResponse);
  await gauge("run", "unarchive", "run-1", "run-2");
  assert.deepEqual(calls, [
    {
      url: ARCHIVE_URL,
      method: "POST",
      body: { runIds: ["run-1", "run-2"], archived: false },
    },
  ]);
  assert.deepEqual(output, ["Run run-1: unarchived", "Run run-2: unarchived"]);
});

it("lists archived runs only with --include-archived", async (t) => {
  const { calls, gauge } = setup(t, () =>
    Response.json({ items: [], nextCursor: null }),
  );
  await gauge("-o", "json", "run", "list");
  await gauge("-o", "json", "run", "list", "--include-archived");
  const [plain, withArchived] = calls.map((call) => new URL(call.url));
  assert.equal(plain.searchParams.get("includeArchived"), null);
  assert.equal(withArchived.searchParams.get("includeArchived"), "true");
});
