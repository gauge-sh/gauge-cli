import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { Command } from "commander";
import { CONNECTION_SECRET_ENV, register } from "./connections";

type Call = { method: string; path: string; body: any };
const ORG_ID = "8c7f0e1a-1111-4222-8333-944455556666";
const SECRET = "secret-value-1234";

const summary = (overrides: Record<string, unknown> = {}) => ({
  id: "conn_1",
  handle: "vendor",
  providerName: "provider",
  credentialKey: "VENDOR_API_KEY",
  basicPasswordKey: null,
  allowedHosts: ["api.vendor.example"],
  profileSlug: "vendor",
  profileLabel: "Vendor",
  kind: "static",
  last4: "1234",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

function useApi(
  t: TestContext,
  options: { items?: unknown[]; secret?: string | null } = {},
) {
  const saved = {
    token: process.env.GAUGE_API_TOKEN,
    url: process.env.GAUGE_API_URL,
    secret: process.env[CONNECTION_SECRET_ENV],
  };
  process.env.GAUGE_API_TOKEN = "test-token";
  process.env.GAUGE_API_URL = "https://test.invalid";
  if (options.secret === null) delete process.env[CONNECTION_SECRET_ENV];
  else process.env[CONNECTION_SECRET_ENV] = options.secret ?? SECRET;
  t.after(() => {
    for (const [key, value] of [
      ["GAUGE_API_TOKEN", saved.token],
      ["GAUGE_API_URL", saved.url],
      [CONNECTION_SECRET_ENV, saved.secret],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const calls: Call[] = [];
  const output: string[] = [];
  t.mock.method(console, "log", (message: unknown) => {
    output.push(String(message));
  });
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      if (method === "GET")
        return Response.json({ items: options.items ?? [summary()] });
      if (method === "DELETE")
        return Response.json({ id: "conn_1", deleted: true });
      return Response.json(summary({ handle: body?.handle ?? "vendor" }), {
        status: method === "POST" ? 201 : 200,
      });
    },
  );
  return { calls, output };
}

async function gauge(args: string[]) {
  const root = new Command()
    .option("--org <org>")
    .option("--hosted")
    .option("--local")
    .option("-o, --output <format>")
    .exitOverride();
  register(root);
  await root.parseAsync(
    ["--org", ORG_ID, "--hosted", "-o", "json", "connections", ...args],
    { from: "user" },
  );
}

const base = `/api/v1/orgs/${ORG_ID}/connections`;

describe("gauge connections rotate", () => {
  it("resolves a name through the list and sends the value from the environment", async (t) => {
    const api = useApi(t);
    await gauge(["rotate", "vendor"]);
    assert.deepEqual(
      api.calls.map((c) => `${c.method} ${c.path}`),
      [`GET ${base}`, `PUT ${base}/conn_1/credential`],
    );
    assert.deepEqual(api.calls[1].body, { credential: SECRET });
    assert.equal(JSON.parse(api.output[0]).id, "conn_1");
  });

  it("accepts an id as well as a name", async (t) => {
    const api = useApi(t);
    await gauge(["rotate", "conn_1"]);
    assert.equal(api.calls[1].path, `${base}/conn_1/credential`);
  });

  it("sends a username and password pair for a Basic connection", async (t) => {
    const api = useApi(t, {
      items: [summary({ basicPasswordKey: "VENDOR_PASSWORD" })],
      secret: " pass word ",
    });
    await gauge(["rotate", "vendor", "--username", "me"]);
    assert.deepEqual(api.calls[1].body, {
      credential: { username: "me", password: " pass word " },
    });
  });

  it("asks for --username on a Basic connection before sending anything", async (t) => {
    const api = useApi(t, {
      items: [summary({ basicPasswordKey: "VENDOR_PASSWORD" })],
    });
    await assert.rejects(gauge(["rotate", "vendor"]), /--username/);
    assert.equal(api.calls.length, 1);
  });

  it("refuses --username on a single-value connection", async (t) => {
    const api = useApi(t);
    await assert.rejects(
      gauge(["rotate", "vendor", "--username", "me"]),
      /does not apply/,
    );
    assert.equal(api.calls.length, 1);
  });

  it("reports an unknown connection without writing", async (t) => {
    const api = useApi(t);
    await assert.rejects(gauge(["rotate", "missing"]), /No connection named/);
    assert.equal(api.calls.length, 1);
  });

  it("has no flag that takes the secret on the command line", async (t) => {
    useApi(t);
    await assert.rejects(gauge(["rotate", "vendor", "--key", SECRET]));
  });
});

describe("gauge connections add", () => {
  it("adds a built-in profile connection", async (t) => {
    const api = useApi(t);
    await gauge(["add", "--handle", "gh", "--profile", "github"]);
    assert.deepEqual(api.calls[0], {
      method: "POST",
      path: base,
      body: { handle: "gh", profileSlug: "github", credential: SECRET },
    });
  });

  it("adds a Basic built-in profile connection with --username", async (t) => {
    const api = useApi(t);
    await gauge([
      "add",
      "--handle",
      "x",
      "--profile",
      "vendor",
      "--username",
      "me",
    ]);
    assert.deepEqual(api.calls[0].body.credential, {
      username: "me",
      password: SECRET,
    });
  });

  for (const [args, auth] of [
    [[], { style: "bearer" }],
    [
      ["--auth", "header", "--header-name", "X-Api-Key"],
      { style: "header", headerName: "X-Api-Key" },
    ],
    [
      [
        "--auth",
        "header",
        "--header-name",
        "Authorization",
        "--header-prefix",
        "Token ",
      ],
      { style: "header", headerName: "Authorization", valuePrefix: "Token " },
    ],
    [
      ["--auth", "query", "--query-param", "api_key"],
      { style: "query", queryParam: "api_key" },
    ],
  ] as const) {
    it(`adds a custom host with ${auth.style} auth`, async (t) => {
      const api = useApi(t);
      await gauge([
        "add",
        "--handle",
        "vendor",
        "--host",
        "api.vendor.example",
        ...args,
      ]);
      assert.deepEqual(api.calls[0].body, {
        handle: "vendor",
        host: "api.vendor.example",
        auth,
        credential: SECRET,
      });
    });
  }

  for (const [label, args, message] of [
    ["neither --profile nor --host", [], /exactly one/],
    [
      "both --profile and --host",
      ["--profile", "github", "--host", "api.vendor.example"],
      /exactly one/,
    ],
    [
      "an unsupported auth style",
      ["--host", "api.vendor.example", "--auth", "path"],
      /Unknown --auth/,
    ],
    [
      "header auth without a header name",
      ["--host", "api.vendor.example", "--auth", "header"],
      /--header-name/,
    ],
    [
      "a header name without header auth",
      ["--host", "api.vendor.example", "--header-name", "X-Key"],
      /requires --auth header/,
    ],
    [
      "query auth without a parameter",
      ["--host", "api.vendor.example", "--auth", "query"],
      /--query-param/,
    ],
    [
      "host options with --profile",
      ["--profile", "github", "--auth", "header"],
      /apply only to --host/,
    ],
    [
      "--username with --host",
      ["--host", "api.vendor.example", "--username", "me"],
      /only to --profile/,
    ],
  ] as const) {
    it(`rejects ${label} without a request`, async (t) => {
      const api = useApi(t);
      await assert.rejects(
        gauge(["add", "--handle", "vendor", ...args]),
        message,
      );
      assert.equal(api.calls.length, 0);
    });
  }
});

describe("gauge connections delete", () => {
  it("deletes with --yes after resolving the name", async (t) => {
    const api = useApi(t);
    await gauge(["delete", "vendor", "--yes"]);
    assert.deepEqual(
      api.calls.map((c) => `${c.method} ${c.path}`),
      [`GET ${base}`, `DELETE ${base}/conn_1`],
    );
    assert.deepEqual(JSON.parse(api.output[0]), {
      id: "conn_1",
      deleted: true,
      handle: "vendor",
    });
  });

  it("refuses without --yes when stdin is not a terminal", async (t) => {
    const api = useApi(t);
    const tty = process.stdin.isTTY;
    process.stdin.isTTY = false;
    t.after(() => {
      process.stdin.isTTY = tty;
    });
    await assert.rejects(gauge(["delete", "vendor"]), /--yes/);
    assert.ok(api.calls.every((c) => c.method !== "DELETE"));
  });
});
