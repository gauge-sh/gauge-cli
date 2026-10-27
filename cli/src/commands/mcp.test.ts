import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { Command } from "commander";
import { register } from "./mcp";

type Call = { path: string; body: any; signal?: AbortSignal | null };
const ORG_ID = "8c7f0e1a-1111-4222-8333-944455556666";
function useApi(
  t: TestContext,
  options: {
    failedConsent?: boolean;
    failSave?: boolean;
    oldServer?: boolean;
  } = {},
) {
  const env = {
    token: process.env.GAUGE_API_TOKEN,
    url: process.env.GAUGE_API_URL,
  };
  process.env.GAUGE_API_TOKEN = "test-token";
  process.env.GAUGE_API_URL = "https://test.invalid";
  t.after(() => {
    if (env.token === undefined) delete process.env.GAUGE_API_TOKEN;
    else process.env.GAUGE_API_TOKEN = env.token;
    if (env.url === undefined) delete process.env.GAUGE_API_URL;
    else process.env.GAUGE_API_URL = env.url;
  });
  const calls: Call[] = [];
  const output: string[] = [];
  const progress: string[] = [];
  t.mock.method(console, "log", (message: unknown) => {
    output.push(String(message));
  });
  t.mock.method(console, "error", (message: unknown) => {
    progress.push(String(message));
  });
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path, body, signal: init?.signal });
      if (path === "/api/v1/orgs")
        return Response.json({
          data: [{ id: ORG_ID, slug: "acme", name: "Acme" }],
        });
      if (path.endsWith("/mcp-authorizations"))
        return Response.json({
          kind: "redirect",
          authorizationId: "pending",
          authorizationUrl: "https://vendor.example/authorize?state=signed",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        });
      if (path.endsWith("/mcp-authorizations/pending"))
        return Response.json(
          options.failedConsent
            ? { status: "failed", message: "Denied" }
            : { status: "connected", connectionId: "connected" },
        );
      if (options.failSave)
        return Response.json(
          { error: { code: "conflict", message: "Version already exists" } },
          { status: 409 },
        );
      return Response.json({
        handle: body.name,
        label: "v1",
        unchanged: false,
        invocation: body.spec.url,
        warnings: [],
        ...(options.oldServer
          ? {}
          : { connectionId: body.connectionId ?? null }),
      });
    },
  );
  return { calls, output, progress };
}
async function gauge(args: string[], org = ORG_ID) {
  const root = new Command()
    .option("--org <org>")
    .option("--hosted")
    .option("--local")
    .option("-o, --output <format>")
    .exitOverride();
  register(root);
  await root.parseAsync(
    [
      "--org",
      org,
      "--hosted",
      "-o",
      "json",
      "mcp",
      "add",
      "--name",
      "gauge",
      ...args,
    ],
    { from: "user" },
  );
}
const http = ["--url", "https://app.withgauge.com/mcp"];
describe("gauge mcp add", () => {
  it("resolves an organization slug before authorizing and saving", async (t) => {
    const api = useApi(t);
    await gauge([...http, "--oauth", "--no-browser"], "acme");
    assert.deepEqual(api.calls.map((call) => call.path), [
      "/api/v1/orgs",
      `/api/v1/orgs/${ORG_ID}/mcp-authorizations`,
      `/api/v1/orgs/${ORG_ID}/mcp-authorizations/pending`,
      `/api/v1/orgs/${ORG_ID}/mcp-servers`,
    ]);
    assert.equal(api.calls[3].body.connectionId, "connected");
  });
  it("authorizes first, then saves exactly that connection and emits one JSON result", async (t) => {
    const api = useApi(t);
    await gauge([...http, "--oauth", "--no-browser"]);
    assert.equal(api.calls.length, 3);
    assert.ok(api.calls[1].signal instanceof AbortSignal);
    assert.equal(api.calls[2].body.connectionId, "connected");
    assert.equal(api.calls[2].body.spec.specVersion, 1);
    assert.equal(api.calls[2].body.spec.serverName, "gauge");
    assert.deepEqual(JSON.parse(api.output[0]).connectionId, "connected");
    assert.equal(api.output.length, 1);
    assert.ok(api.progress[0].includes("https://vendor.example/authorize"));
  });
  it("binds an existing connection without OAuth", async (t) => {
    const api = useApi(t);
    await gauge([...http, "--connection", "existing"]);
    assert.equal(api.calls.length, 1);
    assert.equal(api.calls[0].body.connectionId, "existing");
  });
  it("does not save a server when consent fails", async (t) => {
    const api = useApi(t, { failedConsent: true });
    await assert.rejects(gauge([...http, "--oauth", "--no-browser"]), /Denied/);
    assert.equal(api.calls.length, 2);
  });
  it("reports the connection to reuse when saving fails after consent", async (t) => {
    const api = useApi(t, { failSave: true });
    await assert.rejects(gauge([...http, "--oauth", "--no-browser"]));
    assert.ok(
      api.progress.some((line) => line.includes("--connection connected")),
    );
  });
  it("refuses to claim an authenticated setup when an older API ignores the binding", async (t) => {
    useApi(t, { oldServer: true });
    await assert.rejects(
      gauge([...http, "--connection", "existing"]),
      /did not confirm/,
    );
  });
  it("keeps an optional client secret out of saved specs and terminal output", async (t) => {
    const api = useApi(t);
    const old = process.env.MCP_TEST_SECRET;
    process.env.MCP_TEST_SECRET = "secret-not-for-output";
    t.after(() => {
      if (old === undefined) delete process.env.MCP_TEST_SECRET;
      else process.env.MCP_TEST_SECRET = old;
    });
    await gauge([
      ...http,
      "--oauth",
      "--no-browser",
      "--oauth-client-id",
      "registered",
      "--oauth-client-secret-env",
      "MCP_TEST_SECRET",
    ]);
    assert.equal(api.calls[0].body.clientSecret, "secret-not-for-output");
    assert.ok(!JSON.stringify(api.calls[2]).includes("secret-not-for-output"));
    assert.ok(
      ![...api.output, ...api.progress]
        .join("\n")
        .includes("secret-not-for-output"),
    );
  });
  for (const args of [
    [...http, "--oauth", "--connection", "conn"],
    ["--command", "npx", "--oauth"],
    [...http, "--oauth-client-id", "id"],
    [...http, "--oauth", "--oauth-timeout", "NaN"],
  ])
    it(`validates before making requests: ${args.join(" ")}`, async (t) => {
      const api = useApi(t);
      await assert.rejects(gauge(args));
      assert.equal(api.calls.length, 0);
    });
});
