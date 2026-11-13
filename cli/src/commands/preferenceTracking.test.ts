import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { Command } from "commander";
import { register as registerPreference } from "./preference";

const ORG = "8c7f0e1a-1111-4222-8333-944455556666";
const BASE = `/api/v1/orgs/${ORG}`;

type Request = { method: string; url: string; body: unknown };

const SCHEDULE = {
  cadence: "WEEKLY",
  weeklyRunDay: 1,
  nextRunAt: null,
  agents: [{ agent: "CLAUDE_CODE", models: ["claude-sonnet-5-5"] }],
};

function respond(method: string, url: string): unknown {
  if (method === "GET" && url === BASE)
    return { slug: "acme", preferenceSchedule: SCHEDULE };
  if (method === "GET" && url === `${BASE}/visibility-prompts`)
    return {
      items: [
        { id: "p1", tracked: true },
        { id: "p2", tracked: false },
        { id: "p3", tracked: true },
      ],
    };
  if (url.startsWith(`${BASE}/visibility-prompts/`))
    return { id: url.split("/").pop(), tracked: true };
  return SCHEDULE;
}

function useApi(t: TestContext): { requests: Request[]; logs: string[] } {
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
  const logs: string[] = [];
  t.mock.method(console, "log", (line: string) => logs.push(line));
  t.mock.method(console, "error", () => {});
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      const request = {
        method: init?.method ?? "GET",
        url: String(url).replace("https://test.invalid", ""),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      requests.push(request);
      return Response.json(respond(request.method, request.url));
    },
  );
  return { requests, logs };
}

async function gauge(args: string[], mode = "--hosted"): Promise<void> {
  const root = new Command()
    .option("--org <org>")
    .option("-o, --output <format>")
    .option("--local")
    .option("--hosted")
    .exitOverride();
  registerPreference(root);
  await root.parseAsync(["--org", ORG, "-o", "json", mode, ...args], {
    from: "user",
  });
}

const CREATE = [
  "preference", "create", "--name", "x", "--kind", "open-ended", "--text", "y",
];

describe("preference prompts", () => {
  it("sends tracked only when a flag is passed", async (t) => {
    const { requests } = useApi(t);
    await gauge(CREATE);
    await gauge([...CREATE, "--no-tracked"]);
    await gauge(["preference", "edit", "p1", "--tracked"]);
    assert.equal((requests[0].body as { tracked?: boolean }).tracked, undefined);
    assert.equal((requests[1].body as { tracked?: boolean }).tracked, false);
    assert.equal(`${requests[2].method} ${requests[2].url}`, `PATCH ${BASE}/visibility-prompts/p1`);
    assert.deepEqual(requests[2].body, { tracked: true });
  });

  it("points prompt cadence flags to tracking", async (t) => {
    const { requests } = useApi(t);
    for (const args of [
      ["preference", "edit", "p1", "--cadence", "weekly"],
      [...CREATE, "--cadence", "daily"],
    ])
      await assert.rejects(gauge(args), /gauge preference track/);
    assert.equal(requests.length, 0);
  });

  it("points hosted prompt models to the org's tracked models", async (t) => {
    const { requests } = useApi(t);
    for (const args of [
      ["preference", "edit", "p1", "--agent", "codex"],
      [...CREATE, "--agent", "claude-code:claude-sonnet-5-5"],
    ])
      await assert.rejects(gauge(args), /gauge preference tracking set --agent/);
    assert.equal(requests.length, 0);
  });

  it("refuses tracking locally", async (t) => {
    useApi(t);
    await assert.rejects(
      gauge(["preference", "edit", "p1", "--tracked"], "--local"),
      /requires hosted/,
    );
  });

  it("filters the list by tracking", async (t) => {
    const { logs } = useApi(t);
    await gauge(["preference", "list", "--tracked"]);
    await gauge(["preference", "list", "--untracked"]);
    assert.deepEqual(
      logs.map((line) => JSON.parse(line).map((p: { id: string }) => p.id)),
      [["p1", "p3"], ["p2"]],
    );
    await assert.rejects(
      gauge(["preference", "list", "--tracked", "--untracked"]),
      /conflict/,
    );
  });

  it("tracks and untracks many prompts at once", async (t) => {
    const { requests } = useApi(t);
    await gauge(["preference", "track", "p1", "p2", "p1"]);
    await gauge(["preference", "untrack", "p3"]);
    assert.deepEqual(
      requests.map(({ method, url, body }) => [method, url, body]),
      [
        ["PATCH", `${BASE}/visibility-prompts/p1`, { tracked: true }],
        ["PATCH", `${BASE}/visibility-prompts/p2`, { tracked: true }],
        ["PATCH", `${BASE}/visibility-prompts/p3`, { tracked: false }],
      ],
    );
  });
});

describe("preference tracking", () => {
  it("shows the schedule, the models, and the tracked count", async (t) => {
    const { logs } = useApi(t);
    await gauge(["preference", "tracking"]);
    assert.deepEqual(JSON.parse(logs[0]), { ...SCHEDULE, tracked: 2, total: 3 });
  });

  it("sets the schedule and replaces the tracked models", async (t) => {
    const { requests } = useApi(t);
    const set = ["preference", "tracking", "set"];
    await gauge([...set, "--cadence", "Weekly", "--day", "thu"]);
    await gauge([...set, "--agent", "claude-code:claude-sonnet-5-5", "--agent", "codex"]);
    await gauge([...set, "--no-agents"]);
    assert.deepEqual(
      requests.map(({ method, url }) => `${method} ${url}`),
      Array(3).fill(`PATCH ${BASE}/preference-schedule`),
    );
    assert.deepEqual(requests[0].body, { cadence: "WEEKLY", weeklyRunDay: 4 });
    assert.deepEqual(requests[1].body, {
      agents: [
        { agent: "CLAUDE_CODE", models: ["claude-sonnet-5-5"] },
        { agent: "CODEX_CLI", models: [] },
      ],
    });
    assert.deepEqual(requests[2].body, { agents: [] });
  });

  it("rejects a monthly cadence, an unknown day, conflicts, and no flags", async (t) => {
    const { requests } = useApi(t);
    const set = ["preference", "tracking", "set"];
    await assert.rejects(gauge([...set, "--cadence", "monthly"]), /daily or weekly/);
    await assert.rejects(gauge([...set, "--day", "someday"]), /invalid --day/);
    await assert.rejects(gauge([...set, "--agent", "codex", "--no-agents"]), /conflict/);
    await assert.rejects(gauge(set), /nothing to change/);
    assert.equal(requests.length, 0);
  });

  it("refuses tracking settings locally", async (t) => {
    const { requests } = useApi(t);
    await assert.rejects(
      gauge(["preference", "tracking", "set", "--cadence", "daily"], "--local"),
      /hosted/,
    );
    assert.equal(requests.length, 0);
  });
});
