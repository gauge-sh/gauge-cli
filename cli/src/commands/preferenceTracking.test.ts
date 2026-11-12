import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { Command } from "commander";
import { register as registerOrg } from "./org";
import { register as registerPreference } from "./preference";

const ORG = "8c7f0e1a-1111-4222-8333-944455556666";
const BASE = `/api/v1/orgs/${ORG}`;

type Request = { method: string; url: string; body: unknown };

function useApi(t: TestContext): Request[] {
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
      return Response.json({
        id: "p1",
        cadence: "WEEKLY",
        weeklyRunDay: 1,
        nextRunAt: null,
      });
    },
  );
  return requests;
}

async function gauge(args: string[], mode = "--hosted"): Promise<void> {
  const root = new Command()
    .option("--org <org>")
    .option("-o, --output <format>")
    .option("--local")
    .option("--hosted")
    .exitOverride();
  registerPreference(root);
  registerOrg(root);
  await root.parseAsync(["--org", ORG, "-o", "json", mode, ...args], {
    from: "user",
  });
}

const CREATE = [
  "preference", "create", "--name", "x", "--kind", "open-ended", "--text", "y",
];

describe("preference tracking", () => {
  it("sends tracked only when a flag is passed", async (t) => {
    const requests = useApi(t);
    await gauge(CREATE);
    await gauge([...CREATE, "--no-tracked"]);
    await gauge(["preference", "edit", "p1", "--tracked"]);
    assert.equal((requests[0].body as { tracked?: boolean }).tracked, undefined);
    assert.equal((requests[1].body as { tracked?: boolean }).tracked, false);
    assert.equal(`${requests[2].method} ${requests[2].url}`, `PATCH ${BASE}/visibility-prompts/p1`);
    assert.deepEqual(requests[2].body, { tracked: true });
  });

  it("points prompt cadence flags to tracking", async (t) => {
    const requests = useApi(t);
    for (const args of [
      ["preference", "edit", "p1", "--cadence", "weekly"],
      [...CREATE, "--cadence", "daily"],
    ])
      await assert.rejects(gauge(args), /--tracked/);
    assert.equal(requests.length, 0);
  });

  it("refuses tracking locally", async (t) => {
    useApi(t);
    await assert.rejects(
      gauge(["preference", "edit", "p1", "--tracked"], "--local"),
      /requires hosted/,
    );
  });

});

describe("org edit", () => {
  it("sets the preference schedule", async (t) => {
    const requests = useApi(t);
    await gauge(["org", "edit", "--preference-cadence", "Weekly", "--preference-day", "thu"]);
    await gauge(["org", "edit", "--preference-cadence", "daily"]);
    assert.deepEqual(
      requests.map(({ method, url }) => `${method} ${url}`),
      [`PATCH ${BASE}/preference-schedule`, `PATCH ${BASE}/preference-schedule`],
    );
    assert.deepEqual(requests[0].body, { cadence: "WEEKLY", weeklyRunDay: 4 });
    assert.deepEqual(requests[1].body, { cadence: "DAILY" });
  });

  it("rejects a monthly cadence, an unknown day, and no flags", async (t) => {
    const requests = useApi(t);
    await assert.rejects(
      gauge(["org", "edit", "--preference-cadence", "monthly"]),
      /daily or weekly/,
    );
    await assert.rejects(
      gauge(["org", "edit", "--preference-day", "someday"]),
      /invalid --preference-day/,
    );
    await assert.rejects(gauge(["org", "edit"]), /nothing to change/);
    assert.equal(requests.length, 0);
  });
});
