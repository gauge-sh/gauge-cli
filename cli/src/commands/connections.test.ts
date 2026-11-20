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
  options: {
    items?: unknown[];
    secret?: string | null;
    /** The status the preview endpoint answers with (default 200). */
    previewStatus?: number;
  } = {},
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
      if (path.endsWith("/preview")) {
        if (options.previewStatus && options.previewStatus !== 200)
          return new Response("", { status: options.previewStatus });
        return Response.json({
          handle: body.handle,
          builtIn: null,
          allowedHosts: [body.host, ...(body.additionalHosts ?? [])],
          credentialKey: body.credentialKey ?? "API_VENDOR_EXAMPLE_API_KEY",
          basicPasswordKey: body.paired ? "API_VENDOR_EXAMPLE_API_KEY_PASSWORD" : null,
        });
      }
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

const created = (api: { calls: Call[] }) =>
  api.calls.filter((c) => c.method === "POST" && c.path === base);

describe("gauge connections add", () => {
  it("previews the hosts and environment variable, then sends the key", async (t) => {
    const api = useApi(t);
    await gauge(["add", "vendor", "--host", "api.vendor.example"]);
    assert.deepEqual(api.calls, [
      {
        method: "POST",
        path: `${base}/preview`,
        body: { handle: "vendor", host: "api.vendor.example" },
      },
      {
        method: "POST",
        path: base,
        body: {
          handle: "vendor",
          host: "api.vendor.example",
          credential: SECRET,
        },
      },
    ]);
    // The preview never carries the value.
    assert.ok(!JSON.stringify(api.calls[0].body).includes(SECRET));
  });

  it("sends several exact hosts and a chosen environment variable", async (t) => {
    const api = useApi(t);
    await gauge([
      "add",
      "gauge",
      "--host",
      "agents.example.com",
      "--host",
      "app.example.com",
      "--env",
      "GAUGE_API_TOKEN",
    ]);
    assert.deepEqual(created(api)[0].body, {
      handle: "gauge",
      host: "agents.example.com",
      additionalHosts: ["app.example.com"],
      credentialKey: "GAUGE_API_TOKEN",
      credential: SECRET,
    });
  });

  it("leaves a known vendor's host to Gauge to recognize", async (t) => {
    const api = useApi(t);
    await gauge(["add", "gh", "--host", "api.github.com"]);
    assert.deepEqual(created(api)[0].body, {
      handle: "gh",
      host: "api.github.com",
      credential: SECRET,
    });
  });

  it("sends a Basic username and password pair", async (t) => {
    const api = useApi(t, { secret: " pass word " });
    await gauge([
      "add",
      "mux",
      "--host",
      "api.vendor.example",
      "--username",
      "me",
    ]);
    assert.equal(api.calls[0].body.paired, true);
    assert.deepEqual(created(api)[0].body, {
      handle: "mux",
      host: "api.vendor.example",
      credential: { username: "me", password: " pass word " },
    });
  });

  it("still adds when the server has no preview", async (t) => {
    for (const previewStatus of [404, 405]) {
      const api = useApi(t, { previewStatus });
      await gauge(["add", "vendor", "--host", "api.vendor.example"]);
      assert.equal(created(api).length, 1);
    }
  });

  it("stops before reading the key when the preview refuses", async (t) => {
    const api = useApi(t, { previewStatus: 400 });
    await assert.rejects(
      gauge(["add", "vendor", "--host", "api.vendor.example"]),
    );
    assert.equal(created(api).length, 0);
  });

  it("accepts the deprecated --handle in place of the name", async (t) => {
    const api = useApi(t);
    await gauge(["add", "--handle", "vendor", "--host", "api.vendor.example"]);
    assert.equal(created(api)[0].body.handle, "vendor");
  });

  it("keeps the deprecated --profile for one release, with a warning", async (t) => {
    const api = useApi(t);
    const warnings: string[] = [];
    t.mock.method(process.stderr, "write", (chunk: unknown) => {
      warnings.push(String(chunk));
      return true;
    });
    await gauge(["add", "gh", "--profile", "github"]);
    assert.deepEqual(api.calls, [
      {
        method: "POST",
        path: base,
        body: { handle: "gh", profileSlug: "github", credential: SECRET },
      },
    ]);
    assert.match(warnings.join(""), /--profile is deprecated/);
  });

  for (const [args, auth] of [
    [
      ["--auth", "bearer"],
      { style: "bearer" },
    ],
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
    it(`adds a host with ${auth.style} auth`, async (t) => {
      const api = useApi(t);
      await gauge(["add", "vendor", "--host", "api.vendor.example", ...args]);
      assert.deepEqual(created(api)[0].body, {
        handle: "vendor",
        host: "api.vendor.example",
        auth,
        credential: SECRET,
      });
    });
  }

  for (const [label, args, message] of [
    ["no name", ["--host", "api.vendor.example"], /Name the connection/],
    [
      "two different names",
      ["vendor", "--handle", "other", "--host", "api.vendor.example"],
      /Name the connection once/,
    ],
    ["no host", ["vendor"], /--host/],
    [
      "an invalid environment variable",
      ["vendor", "--host", "api.vendor.example", "--env", "lower-case"],
      /--env/,
    ],
    [
      "an unsupported auth style",
      ["vendor", "--host", "api.vendor.example", "--auth", "path"],
      /Unknown --auth/,
    ],
    [
      "header auth without a header name",
      ["vendor", "--host", "api.vendor.example", "--auth", "header"],
      /--header-name/,
    ],
    [
      "a header name without header auth",
      ["vendor", "--host", "api.vendor.example", "--header-name", "X-Key"],
      /requires --auth header/,
    ],
    [
      "query auth without a parameter",
      ["vendor", "--host", "api.vendor.example", "--auth", "query"],
      /--query-param/,
    ],
    [
      "--username with a non-Basic style",
      [
        "vendor",
        "--host",
        "api.vendor.example",
        "--auth",
        "bearer",
        "--username",
        "me",
      ],
      /HTTP Basic/,
    ],
    [
      "--auth basic without --username",
      ["vendor", "--host", "api.vendor.example", "--auth", "basic"],
      /requires --username/,
    ],
    [
      "--profile with --host",
      ["vendor", "--profile", "github", "--host", "api.vendor.example"],
      /deprecated/,
    ],
  ] as const) {
    it(`rejects ${label} without a request`, async (t) => {
      const api = useApi(t);
      await assert.rejects(gauge(["add", ...args]), message);
      assert.equal(api.calls.length, 0);
    });
  }

  it("never says profile in its help", () => {
    const root = new Command();
    register(root);
    const add = root.commands
      .find((c) => c.name() === "connections")
      ?.commands.find((c) => c.name() === "add");
    assert.ok(add);
    assert.doesNotMatch(add.helpInformation(), /profile|--handle/i);
  });
});

describe("gauge connections list", () => {
  it("shows name, hosts, environment variable, kind, and last four", async (t) => {
    const api = useApi(t);
    const root = new Command()
      .option("--org <org>")
      .option("--hosted")
      .option("--local")
      .option("-o, --output <format>")
      .exitOverride();
    register(root);
    await root.parseAsync(
      ["--org", ORG_ID, "--hosted", "-o", "table", "connections", "list"],
      { from: "user" },
    );
    const table = api.output.join("\n");
    for (const text of [
      "vendor",
      "api.vendor.example",
      "VENDOR_API_KEY",
      "static",
      "····1234",
    ])
      assert.ok(table.includes(text), `${text} in\n${table}`);
    // The old vendor/profile column (profileLabel "Vendor") is gone.
    assert.doesNotMatch(table, /\bVendor\b|profile/);
  });
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
