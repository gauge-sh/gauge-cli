import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { Command } from "commander";
import { register } from "./connections";

type Call = { method: string; path: string; body: any };
const ORG_ID = "8c7f0e1a-1111-4222-8333-944455556666";
const CONNECTION = {
  id: "conn-1",
  handle: "docs-mcp",
  providerName: "provider",
  credentialKey: "DOCS_TOKEN",
  allowedHosts: ["mcp.example.com"],
  profileSlug: "docs",
  profileLabel: "Docs",
  kind: "oauth",
  last4: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function useApi(
  t: TestContext,
  options: {
    begin?: Record<string, unknown>;
    status?: Record<string, unknown>;
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
      calls.push({ method: init?.method ?? "GET", path, body });
      if (path.endsWith("/connections"))
        return Response.json({ items: [CONNECTION] });
      if (path.endsWith("/reauthorize"))
        return Response.json(
          options.begin ?? {
            kind: "redirect",
            authorizationId: "pending",
            authorizationUrl: "https://vendor.example/authorize?state=signed",
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          },
        );
      if (path.endsWith("/mcp-authorizations/pending"))
        return Response.json(
          options.status ?? { status: "connected", connectionId: "conn-1" },
        );
      return Response.json(
        { error: { code: "not_found", message: "Not found" } },
        { status: 404 },
      );
    },
  );
  return { calls, output, progress };
}

async function gauge(args: string[], output = "json") {
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
      ORG_ID,
      "--hosted",
      "-o",
      output,
      "connections",
      "reauthorize",
      ...args,
    ],
    { from: "user" },
  );
}

describe("gauge connections reauthorize", () => {
  it("resolves a handle, starts consent for that connection, and polls until it is renewed", async (t) => {
    const api = useApi(t);
    await gauge(["docs-mcp", "--no-browser"]);
    assert.deepEqual(
      api.calls.map((call) => `${call.method} ${call.path}`),
      [
        `GET /api/v1/orgs/${ORG_ID}/connections`,
        `POST /api/v1/orgs/${ORG_ID}/connections/conn-1/reauthorize`,
        `GET /api/v1/orgs/${ORG_ID}/mcp-authorizations/pending`,
      ],
    );
    assert.deepEqual(api.calls[1].body, {});
    assert.deepEqual(JSON.parse(api.output[0]), {
      connectionId: "conn-1",
      handle: "docs-mcp",
    });
    assert.equal(api.output.length, 1);
    assert.ok(api.progress[0].includes("https://vendor.example/authorize"));
  });

  it("accepts an id and passes an explicit server URL and client id", async (t) => {
    const api = useApi(t);
    await gauge([
      "conn-1",
      "--no-browser",
      "--url",
      "https://mcp.example.com/mcp",
      "--client-id",
      "client",
    ]);
    assert.deepEqual(api.calls[1].body, {
      url: "https://mcp.example.com/mcp",
      clientId: "client",
    });
  });

  it("finishes without a browser when an earlier sign-in only needed resuming", async (t) => {
    const api = useApi(t, {
      begin: { kind: "connected", connectionId: "conn-1", handle: "docs-mcp" },
    });
    await gauge(["docs-mcp"]);
    assert.equal(api.calls.length, 2);
    assert.equal(JSON.parse(api.output[0]).connectionId, "conn-1");
  });

  it("reports when the renewed key will lapse", async (t) => {
    const api = useApi(t, {
      status: {
        status: "connected",
        connectionId: "conn-1",
        nonRefreshable: { expiresAt: "2026-01-08T00:00:00.000Z" },
      },
    });
    await gauge(["docs-mcp", "--no-browser"], "table");
    assert.match(api.output[0], /Reauthorized docs-mcp \(conn-1\)/);
    assert.ok(
      api.progress.some((line) => line.includes("2026-01-08T00:00:00.000Z")),
    );
  });

  it("names the list command for an unknown connection, before any consent", async (t) => {
    const api = useApi(t);
    await assert.rejects(gauge(["missing", "--no-browser"]), (error: any) => {
      assert.match(error.message, /No connection named or with id "missing"/);
      assert.match(error.hint, /gauge connections list --hosted/);
      return true;
    });
    assert.equal(api.calls.length, 1);
  });

  it("surfaces a refusal from the server", async (t) => {
    useApi(t, {
      begin: {
        kind: "problem",
        problem: "This connection was not made with OAuth.",
      },
    });
    await assert.rejects(gauge(["docs-mcp"]), /not made with OAuth/);
  });

  it("fails a failed consent with its reason", async (t) => {
    useApi(t, { status: { status: "failed", message: "Denied." } });
    await assert.rejects(gauge(["docs-mcp", "--no-browser"]), /Denied/);
  });

  it("validates its options before calling the API", async (t) => {
    const api = useApi(t);
    await assert.rejects(
      gauge(["docs-mcp", "--timeout", "0"]),
      /--timeout must be an integer/,
    );
    await assert.rejects(
      gauge(["docs-mcp", "--client-secret-env", "SECRET"]),
      /requires --client-id/,
    );
    assert.equal(api.calls.length, 0);
  });
});
