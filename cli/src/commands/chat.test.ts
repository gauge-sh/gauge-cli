import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Command, Option } from "commander";
import { updateConfig } from "../lib/config";
import { createClient } from "../lib/client";
import { readCredentials, saveCredentials } from "../lib/credentials";
import { errorReport, renderError } from "../lib/errors";
import { register } from "./chat";
import { register as registerAuth } from "./auth";
import { parsePromptInput } from "./chatPrompts";

type Seen = {
  method: string;
  path: string;
  query: URLSearchParams;
  auth?: string;
  body?: any;
};
type Reply = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};
type Handler = (req: Seen) => Reply;

let server: Server;
let origin: string;
let handler: Handler;
let seen: Seen[];
let directory: string;
let saved: NodeJS.ProcessEnv;
let stdout: string[];
let stderr: string[];
const log = console.log;
const error = console.error;

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function respond(res: ServerResponse, reply: Reply): void {
  const status = reply.status ?? 200;
  if (reply.body === undefined) {
    res.writeHead(status, reply.headers);
    res.end();
    return;
  }
  const text =
    typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
  res.writeHead(status, {
    "content-type":
      typeof reply.body === "string" ? "text/plain" : "application/json",
    ...reply.headers,
  });
  res.end(text);
}

const apiError = (
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Reply => ({ status, body: { error: { code, message, ...extra } } });

async function run(...args: string[]): Promise<{ json: any; error?: unknown }> {
  stdout = [];
  stderr = [];
  const program = new Command()
    .option("--org <org>")
    .addOption(new Option("-o, --output <format>").default("table"))
    .option("--local")
    .option("--hosted");
  program.exitOverride();
  register(program);
  registerAuth(program);
  try {
    await program.parseAsync(["node", "gauge", ...args]);
  } catch (caught) {
    return { json: parse(), error: caught };
  }
  return { json: parse() };
}

function parse(): any {
  const text = stdout.join("\n");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const api = (path: string) => `/api/v1${path}`;
const ORG = "8c7f0e1a-1111-4222-8333-944455556666";
const OTHER = "1d2e3f40-5555-4666-8777-988899990000";
const orgDirectory = [
  {
    id: ORG,
    slug: "acme",
    name: "Acme",
    products: { chat: true, agents: true },
  },
  {
    id: OTHER,
    slug: "beta",
    name: "Beta",
    products: { chat: false, agents: true },
  },
];
const keyMe = {
  user: null,
  apiKey: {
    id: "1",
    name: "ci",
    prefix: "gauge_sk_ab",
    organization: { id: ORG, slug: "acme", name: "Acme" },
  },
  token: { kind: "api_key", scopes: ["read", "write"], expiresAt: null },
};
const topics = [
  {
    id: "top_1A",
    slug: "pricing",
    title: "Pricing",
    promptCount: 0,
    createdAt: "2026-10-01T00:00:00Z",
  },
];

describe("gauge chat", { concurrency: false }, () => {
  it("resolves an explicit non-member slug through the authorized org endpoint", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_cli_staff";
    handler = (req) => {
      if (req.path === api("/orgs")) return { body: { data: [] } };
      if (req.path === api("/orgs/outside-org"))
        return { body: { id: OTHER, slug: "outside-org", name: "Outside Org" } };
      if (req.path === api(`/orgs/${OTHER}/tags`)) return { body: { data: [] } };
      return apiError(404, "not_found", "Unexpected request");
    };
    const result = await run(
      "chat", "tags", "list", "--org", "outside-org", "-o", "json",
    );
    assert.equal(result.error, undefined);
    assert.deepEqual(result.json, { data: [], nextCursor: null });
    assert.deepEqual(seen.map((req) => req.path), [
      api("/orgs"),
      api("/orgs/outside-org"),
      api(`/orgs/${OTHER}/tags`),
    ]);
    assert.ok(seen.every((req) => req.auth === "Bearer gauge_cli_staff"));
  });

  beforeEach(async () => {
    saved = { ...process.env };
    directory = mkdtempSync(join(tmpdir(), "gauge-chat-"));
    process.env.XDG_CONFIG_HOME = directory;
    delete process.env.GAUGE_API_TOKEN;
    seen = [];
    handler = () => ({
      status: 404,
      body: { error: { code: "not_found", message: "no route" } },
    });
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const request: Seen = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        auth: req.headers.authorization,
        body: await readBody(req),
      };
      seen.push(request);
      respond(res, handler(request));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.GAUGE_AUTH_URL = origin;
    process.env.GAUGE_API_URL = origin;
    console.log = (...args: unknown[]) => void stdout.push(args.join(" "));
    console.error = (...args: unknown[]) => void stderr.push(args.join(" "));
  });

  afterEach(async () => {
    console.log = log;
    console.error = error;
    process.env = saved;
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });

  it("sends an org API key from GAUGE_API_TOKEN to the Chat origin, in its own org", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_sk_abc";
    updateConfig({ defaultOrg: "someone-elses-default" });
    handler = (req) =>
      req.path === api("/me")
        ? { body: keyMe }
        : { body: { data: [], nextCursor: null } };
    await run("chat", "tags", "list", "-o", "json");
    await run("chat", "tags", "list", "-o", "json");
    assert.deepEqual(
      seen.map((r) => `${r.path} ${r.auth}`),
      [
        `${api("/me")} Bearer gauge_sk_abc`,
        `${api(`/orgs/${ORG}/tags`)} Bearer gauge_sk_abc`,
        `${api("/me")} Bearer gauge_sk_abc`,
        `${api(`/orgs/${ORG}/tags`)} Bearer gauge_sk_abc`,
      ],
      "the key's current org is looked up on each invocation",
    );
  });

  it("resolves a public slug from the canonical directory on each invocation", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_cli_session";
    handler = (req) => {
      if (req.path === api("/orgs")) return { body: { data: orgDirectory } };
      if (req.path === api("/me"))
        return {
          body: {
            user: { id: "u", email: null },
            orgs: [
              {
                slug: "acme-1a2b3c4d",
                publicId: null,
                canonicalGaugeOrganizationId: ORG,
                name: "Acme",
              },
            ],
          },
        };
      return { body: { data: [], nextCursor: null } };
    };
    await run("chat", "tags", "list", "--org", "acme", "-o", "json");
    await run("chat", "tags", "list", "--org", "acme", "-o", "json");
    assert.deepEqual(seen.map((r) => r.path).sort(), [
      api("/orgs"),
      api("/orgs"),
      api(`/orgs/${ORG}/tags`),
      api(`/orgs/${ORG}/tags`),
    ]);
  });

  it("uses the canonical slug even if an internal Agents slug could collide", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_cli_session";
    handler = (req) => {
      if (req.path === api("/orgs")) return { body: { data: orgDirectory } };
      if (req.path === api("/me"))
        return {
          body: {
            orgs: [{ slug: "acme", canonicalGaugeOrganizationId: OTHER }],
          },
        };
      return { body: { data: [] } };
    };
    const result = await run("chat", "tags", "list", "--org", "acme");
    assert.equal(result.error, undefined);
    assert.deepEqual(
      seen.map((req) => req.path),
      [api("/orgs"), api(`/orgs/${ORG}/tags`)],
    );
  });

  it("names an organization that doesn't use Gauge Chat", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_cli_session";
    handler = (req) => {
      if (req.path === api("/orgs")) return { body: { data: orgDirectory } };
      if (req.path === api("/me"))
        return { body: { user: { id: "u", email: null }, orgs: [] } };
      return apiError(
        403,
        "product_not_enabled",
        "Gauge Chat is not set up for this organization.",
      );
    };
    const { error: caught } = await run(
      "chat",
      "tags",
      "list",
      "--org",
      "beta",
    );
    const report = errorReport(caught, "chat tags list");
    assert.equal(seen.at(-1)?.path, api(`/orgs/${OTHER}/tags`));
    assert.equal(report.message, "Beta doesn't use Gauge Chat.");
    assert.match(report.hint ?? "", /gauge orgs/);
  });

  it("prefers GAUGE_API_TOKEN over a stored login", async () => {
    saveCredentials({
      version: 1,
      sessionId: "s1",
      accessToken: "gauge_cli_stored",
      refreshToken: "gauge_refresh_stored",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      authUrl: "https://chat.example.invalid",
      apiUrl: "https://agents.example.invalid",
    });
    process.env.GAUGE_API_TOKEN = "gauge_sk_env";
    handler = () => ({ body: { data: [], nextCursor: null } });
    await run("chat", "tags", "list", "--org", ORG, "-o", "json");
    assert.deepEqual(
      seen.map((r) => `${r.path} ${r.auth}`),
      [`${api(`/orgs/${ORG}/tags`)} Bearer gauge_sk_env`],
      "no refresh, no stored token, and the Chat origin from GAUGE_AUTH_URL",
    );
  });

  it("passes GAUGE_API_TOKEN to Agents API calls unchanged, org key or legacy token", async () => {
    handler = () => ({ body: { ok: true } });
    for (const token of ["gauge_sk_agents", "gauge_legacy", "unprefixedKey"]) {
      process.env.GAUGE_API_TOKEN = token;
      await createClient().get("/api/v1/me");
    }
    assert.deepEqual(
      seen.map((r) => r.auth),
      ["Bearer gauge_sk_agents", "Bearer gauge_legacy", "Bearer unprefixedKey"],
    );
  });

  it("asks for a login or an org API key when no credential is set", async () => {
    const { error: caught } = await run("chat", "tags", "list");
    const report = errorReport(caught, "chat tags list");
    assert.equal(report.code, "unauthorized");
    assert.equal(
      report.hint,
      "Run `gauge auth login`, or set GAUGE_API_TOKEN to an org API key (Settings → API Keys).",
    );
    assert.equal(seen.length, 0);
  });

  it("omits the Agents docs link from chat errors", async () => {
    const { error: caught } = await run("chat", "tags", "list");
    const report = errorReport(caught, "chat tags list");
    assert.equal(report.docs, undefined);
    assert.ok(!renderError(report, false).includes("Docs:"));
    assert.ok(!("docs" in JSON.parse(renderError(report, true)).error));
    assert.match(errorReport(caught, "run list").docs ?? "", /docs\.withgauge/);
  });

  it("explains how to replace an environment API key that overrides saved login", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_sk_expired";
    handler = () => apiError(401, "unauthorized", "This API key has expired.");
    const { error } = await run("chat", "tags", "list", "--org", ORG);
    const report = errorReport(error, "chat tags list");
    assert.equal(report.code, "unauthorized");
    assert.match(report.hint ?? "", /Replace GAUGE_API_TOKEN.*unset it.*gauge auth login/);
  });

  it("rejects the Agents-only --local and --hosted flags", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_sk_abc";
    for (const flag of ["--local", "--hosted"]) {
      const { error: caught } = await run("chat", "tags", "list", flag);
      const report = errorReport(caught, "chat tags list");
      assert.equal(report.code, "usage");
      assert.equal(report.exitCode, 2);
      assert.equal(
        report.message,
        `${flag} applies only to Agents commands; gauge chat always uses the hosted Chat API. Remove ${flag}.`,
      );
    }
    assert.equal(seen.length, 0);
  });

  it("describes chat defaults and auth in help, without Agents-only flags", () => {
    const program = new Command()
      .option(
        "--org <org>",
        "organization slug or public id (default: gauge.json org, then user defaultOrg)",
      )
      .option("--local", "run on this machine")
      .option("--hosted", "run on hosted Gauge")
      .configureHelp({ showGlobalOptions: true });
    register(program);
    registerAuth(program);
    const chat = program.commands.find((c) => c.name() === "chat");
    assert.ok(chat);
    const tags = chat.commands.find((c) => c.name() === "tags");
    const list = tags?.commands.find((c) => c.name() === "list");
    assert.ok(tags && list);
    const listHelp = list.helpInformation().replace(/\s+/g, " ");
    assert.match(
      listHelp,
      /--org <org>\s+organization slug or id \(default: gauge.json orgId, then your saved default, else your only Chat org; an org API key implies its org\)/,
    );
    assert.ok(!/--local|--hosted/.test(listHelp));
    assert.match(tags.helpInformation(), /prompts are kept/);
    let chatHelp = "";
    chat.configureOutput({ writeOut: (text) => void (chatHelp += text) });
    chat.outputHelp();
    assert.match(chatHelp, /GAUGE_API_TOKEN to an org API key \(gauge_sk_…/);
    assert.match(chatHelp, /takes precedence over a login/);
    assert.ok(!/authUrl|Chat origin|gauge_pat|personal access/.test(chatHelp));
    const root = new Command()
      .option("--org <org>", "agents org help")
      .configureHelp({ showGlobalOptions: true });
    root.command("eval").command("list");
    register(root);
    assert.match(
      root.commands[0].commands[0].helpInformation(),
      /agents org help/,
      "Agents commands keep the root --org help",
    );
  });

  it("refreshes shared CLI credentials once after a 401 and retries", async () => {
    saveCredentials({
      version: 1,
      sessionId: "s1",
      accessToken: "gauge_cli_old",
      refreshToken: "gauge_refresh_old",
      tokenType: "bearer",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      authUrl: origin,
      apiUrl: origin,
    } as never);
    handler = (req) => {
      if (req.path === "/api/cli/refresh") {
        assert.deepEqual(req.body, { refreshToken: "gauge_refresh_old" });
        return {
          body: {
            accessToken: "gauge_cli_new",
            refreshToken: "gauge_refresh_new",
            tokenType: "bearer",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
        };
      }
      if (req.auth !== "Bearer gauge_cli_new")
        return apiError(401, "unauthorized", "expired");
      return {
        body: {
          data: [{ id: "tag_1A", name: "Brand", color: "", promptCount: 2 }],
        },
      };
    };
    const { json } = await run(
      "chat",
      "tags",
      "list",
      "--org",
      ORG,
      "-o",
      "json",
    );
    assert.deepEqual(
      seen.map((r) => `${r.path} ${r.auth ?? ""}`.trim()),
      [
        `${api(`/orgs/${ORG}/tags`)} Bearer gauge_cli_old`,
        "/api/cli/refresh",
        `${api(`/orgs/${ORG}/tags`)} Bearer gauge_cli_new`,
      ],
    );
    assert.equal(json.data[0].id, "tag_1A");
    assert.equal(
      (readCredentials() as { refreshToken: string }).refreshToken,
      "gauge_refresh_new",
    );
  });

  it("follows cursors with --all, bounded by --max, and resolves tag names", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_sk_abc";
    const prompt = (n: number) => ({
      id: `prm_${n}`,
      text: `p${n}`,
      topicId: "top_1A",
      trackingType: "visibility",
      tagIds: [],
      createdAt: "2026-10-01T00:00:00Z",
      firstAnswerDay: null,
    });
    handler = (req) => {
      if (req.path.endsWith("/tags"))
        return {
          body: {
            data: [
              { id: "tag_1B", name: "Pricing", color: "", promptCount: 0 },
            ],
          },
        };
      const offset = Number(req.query.get("cursor") ?? 0);
      const end = Math.min(6, offset + Number(req.query.get("limit") ?? 50));
      return {
        body: {
          data: Array.from({ length: end - offset }, (_, i) =>
            prompt(offset + i),
          ),
          nextCursor: end < 6 ? String(end) : null,
        },
      };
    };
    const all = await run(
      "chat",
      "prompts",
      "list",
      "--org",
      ORG,
      "--category",
      "crm",
      "--tag",
      "pricing,tag_1C",
      "--all",
      "--limit",
      "2",
      "-o",
      "json",
    );
    assert.equal(all.json.data.length, 6);
    assert.equal(all.json.nextCursor, null);
    const pages = seen.filter((r) => r.path.endsWith("/prompts"));
    assert.equal(pages[0].path, api(`/orgs/${ORG}/categories/crm/prompts`));
    assert.deepEqual(
      pages.map((r) => r.query.get("cursor")),
      [null, "2", "4"],
    );
    assert.deepEqual(pages[0].query.getAll("tag"), ["tag_1B", "tag_1C"]);

    seen = [];
    const capped = await run(
      "chat",
      "prompts",
      "list",
      "--org",
      ORG,
      "--category",
      "crm",
      "--all",
      "--limit",
      "2",
      "--max",
      "3",
      "-o",
      "json",
    );
    assert.deepEqual(
      capped.json.data.map((p: { id: string }) => p.id),
      ["prm_0", "prm_1", "prm_2"],
    );
    assert.equal(capped.json.nextCursor, "3");
    assert.deepEqual(
      seen.map((r) => r.query.get("limit")),
      ["2", "1"],
    );
  });

  it("builds the query body and defaults the category for answer datasets only", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_sk_abc";
    const response = {
      columns: [
        { key: "brand", kind: "dimension", type: "id:brand" },
        { key: "visibility", kind: "metric", type: "rate", unit: "ratio" },
      ],
      rows: [{ brand: "brd_1A", visibility: 0.425 }],
      labels: { brand: { brd_1A: { name: "Acme", slug: "acme" } } },
      dateRange: { since: "2026-09-22", until: "2026-10-21" },
      truncated: false,
      cached: false,
      freshness: { watermark: "2026-10-21", pending: 0, available: true },
    };
    handler = (req) => {
      if (req.path === api("/me")) return { body: keyMe };
      if (req.path === api(`/orgs/${ORG}/categories`))
        return {
          body: {
            data: [{ id: "cat_1A", slug: "crm", name: "CRM", description: "" }],
          },
        };
      return { body: response };
    };
    await run(
      "chat",
      "query",
      "--dataset",
      "answers",
      "-d",
      "brand,date",
      "-m",
      "visibility",
      "--where",
      "model in gpt-5,claude",
      "--where",
      "domain not in a.com,b.com",
      "--where",
      "query contains pricing",
      "--last-days",
      "30",
      "--order-by",
      "visibility:desc",
      "--brand",
      "brd_1A",
      "--tag-mode",
      "all",
      "--limit",
      "10",
    );
    const post = seen.find((r) => r.method === "POST");
    assert.equal(post?.path, api(`/orgs/${ORG}/query`));
    assert.deepEqual(post?.body, {
      dataset: "answers",
      dimensions: ["brand", "date"],
      metrics: ["visibility"],
      where: [
        { dimension: "model", op: "in", value: ["gpt-5", "claude"] },
        { dimension: "domain", op: "notIn", value: ["a.com", "b.com"] },
        { dimension: "query", op: "contains", value: "pricing" },
      ],
      orderBy: [{ key: "visibility", dir: "desc" }],
      limit: 10,
      dateRange: { lastDays: 30 },
      filters: { brand: ["brd_1A"], tagMode: "all", category: "crm" },
    });
    assert.match(stdout.join("\n"), /Acme\s+42.5%/);

    seen = [];
    await run(
      "chat",
      "query",
      "--org",
      ORG,
      "-o",
      "json",
      "--json",
      '{"dataset":"aiTraffic","metrics":["requests"],"dimensions":["date"]}',
      "--granularity",
      "hour",
    );
    assert.deepEqual(
      seen.map((r) => r.path),
      [api(`/orgs/${ORG}/query`)],
    );
    assert.deepEqual(seen[0].body, {
      dataset: "aiTraffic",
      metrics: ["requests"],
      dimensions: ["date"],
      granularity: "hour",
    });
  });

  it("maps API errors to codes, details and exit codes", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_sk_read";
    const cases: [Reply, string, number, RegExp, Record<string, unknown>?][] = [
      [
        apiError(
          403,
          "insufficient_scope",
          "This token lacks the 'write' scope.",
          { requiredScope: "write" },
        ),
        "insufficient_scope",
        1,
        /write access/,
        { requiredScope: "write" },
      ],
      [
        apiError(403, "limit_exceeded", "Prompt limit reached", {
          remaining: 3,
        }),
        "limit_exceeded",
        3,
        /allows 3 more/,
        { remaining: 3 },
      ],
      [
        apiError(
          422,
          "incompatible_dimension",
          "Dimension 'brand' is not available",
          { field: "dimensions" },
        ),
        "incompatible_dimension",
        2,
        /./,
        { field: "dimensions" },
      ],
      [
        apiError(429, "rate_limited", "Rate limit exceeded", {
          retryAfter: 12,
        }),
        "rate_limited",
        1,
        /Retry in 12 s/,
        { retryAfter: 12 },
      ],
      [
        apiError(404, "not_found", "Organization not found"),
        "not_found",
        1,
        /./,
      ],
      [{ status: 502, body: "bad gateway" }, "internal", 1, /./],
    ];
    for (const [reply, code, exitCode, hint, details] of cases) {
      handler = () => reply;
      const { error: caught } = await run(
        "chat",
        "tags",
        "create",
        "x",
        "--org",
        ORG,
      );
      const report = errorReport(caught, "chat tags create");
      assert.equal(report.code, code);
      assert.equal(report.exitCode, exitCode, code);
      assert.ok(!report.message.includes("\n"), "single-line message");
      assert.ok(!report.message.startsWith(`${code}: `), "API codes belong in the structured code field");
      assert.match(`${report.hint ?? ""}${report.message}`, hint);
      for (const [key, value] of Object.entries(details ?? {}))
        assert.equal(report.details?.[key], value, `${code}.${key}`);
    }
  });

  it("explains insufficient_scope for an org API key and a login session", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_sk_read";
    let me: unknown = {
      user: null,
      apiKey: { id: "key_1", name: "Warehouse sync", prefix: "gauge_sk_3fA9" },
      token: { kind: "api_key", scopes: ["read"], expiresAt: null },
    };
    handler = (req) =>
      req.path === api("/me")
        ? { body: me }
        : apiError(
            403,
            "insufficient_scope",
            "This token lacks the 'write' scope.",
            { requiredScope: "write" },
          );
    const keyed = await run("chat", "tags", "create", "x", "--org", ORG);
    assert.equal(
      errorReport(keyed.error, "chat tags create").hint,
      "This API key has read-only access. Create a Read & write key in Settings → API Keys, then update GAUGE_API_TOKEN or import it with `gauge auth login --with-token`.",
    );

    me = {
      user: { id: "u1", email: "a@b.co", name: "A" },
      apiKey: null,
      token: {
        kind: "session",
        scopes: ["read"],
        expiresAt: "2027-01-01T00:00:00Z",
      },
    };
    const session = await run("chat", "tags", "create", "x", "--org", ORG);
    assert.match(
      errorReport(session.error, "chat tags create").hint ?? "",
      /^Your login has read-only access. Ask an organization admin for write access/,
    );

    me = { unexpected: true };
    const unknown = await run("chat", "tags", "create", "x", "--org", ORG);
    assert.equal(
      errorReport(unknown.error, "chat tags create").hint,
      "Ask an organization admin for write access, or create a Read & write API key in Settings → API Keys.",
      "falls back to the generic hint",
    );
  });

  it("has one root whoami for users and org API keys", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_sk_read";
    handler = () => ({ body: keyMe });
    const key = await run("whoami", "-o", "json");
    assert.equal(key.error, undefined);
    assert.deepEqual(key.json, {
      user: null,
      apiKey: keyMe.apiKey,
      orgs: [keyMe.apiKey.organization],
    });
    const text = (await run("whoami")).json;
    assert.match(text, /Org API key "ci"/);
    assert.match(text, /Acme \(acme\)/);
    assert.ok(!text.includes("Expires"));
    process.env.GAUGE_API_TOKEN = "gauge_cli_session";
    const user = { id: "u1", email: "a@b.co", name: "A" };
    handler = (req) =>
      req.path === api("/me")
        ? {
            body: {
              user,
              apiKey: null,
              token: { kind: "session", scopes: ["read"], expiresAt: null },
            },
          }
        : { body: { data: orgDirectory } };
    assert.deepEqual((await run("whoami", "-o", "json")).json, {
      user,
      apiKey: null,
      orgs: orgDirectory,
    });
    assert.match((await run("whoami")).json, /Signed in as a@b.co \(A\)/);
  });

  it("auth status reports credential diagnostics without duplicating identity", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_sk_read";
    handler = () => ({ body: keyMe });
    const result = await run("auth", "status", "-o", "json");
    assert.equal(result.error, undefined);
    assert.deepEqual(result.json, {
      authenticated: true,
      source: "env",
      apiUrl: origin,
      authUrl: origin,
      credential: keyMe.token,
    });
    assert.ok(!JSON.stringify(result.json).includes("gauge_sk_read"));
    assert.deepEqual(
      seen.map((req) => req.path),
      [api("/me")],
    );
    const text = (await run("auth", "status")).json;
    assert.match(text, /API key: valid/);
    assert.match(text, /GAUGE_API_TOKEN/);
    assert.ok(!text.includes("Organizations:"));
    handler = () => apiError(401, "unauthorized", "Expired");
    const rejected = await run("auth", "status");
    assert.match(
      errorReport(rejected.error, "auth status").message,
      /GAUGE_API_TOKEN was rejected/,
    );
  });

  it("auth status diagnoses a stored session without listing organizations", async () => {
    saveCredentials({
      version: 1,
      sessionId: "s1",
      accessToken: "gauge_cli_stored",
      authUrl: origin,
      apiUrl: origin,
    });
    const token = {
      kind: "session",
      scopes: ["read"],
      expiresAt: "2027-01-01T00:00:00Z",
    };
    handler = (req) =>
      req.path === api("/me")
        ? {
            body: {
              user: { id: "u", email: "u@test.com", name: "U" },
              apiKey: null,
              token,
            },
          }
        : apiError(503, "unavailable", "Directory offline");
    const status = await run("auth", "status", "-o", "json");
    assert.equal(status.error, undefined);
    assert.equal(status.json.source, "file");
    assert.deepEqual(status.json.credential, token);
    assert.equal(seen[0].auth, "Bearer gauge_cli_stored");
    assert.deepEqual(
      seen.map((req) => req.path),
      [api("/me")],
    );
    const program = new Command();
    register(program);
    assert.ok(
      !program.commands
        .find((cmd) => cmd.name() === "chat")
        ?.commands.some((cmd) => cmd.name() === "whoami"),
    );
  });

  it("can identify legacy Agents credentials without exposing internal org slugs", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_legacy";
    const user = { id: "u1", email: "a@b.co" };
    handler = () => ({
      body: { user, orgs: [{ slug: "internal-workspace" }] },
    });
    assert.deepEqual((await run("whoami", "-o", "json")).json, {
      user,
      apiKey: null,
      orgs: null,
    });
    const status = (await run("auth", "status", "-o", "json")).json;
    assert.deepEqual(status.credential, {
      kind: "legacy",
      scopes: null,
      expiresAt: null,
    });
  });

  it("degrades when the server has no /api/v1/me or returns an HTML 404", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_cli_session";
    const html404: Reply = {
      status: 404,
      body: "<!doctype html><title>Not Found</title><h1>Not Found</h1>",
      headers: { "content-type": "text/html" },
    };
    handler = (req) =>
      req.path === api("/me")
        ? html404
        : apiError(
            403,
            "insufficient_scope",
            "This token lacks the 'write' scope.",
            { requiredScope: "write" },
          );
    const scoped = await run("chat", "tags", "create", "x", "--org", ORG);
    const report = errorReport(scoped.error, "chat tags create");
    assert.equal(report.code, "insufficient_scope");
    assert.match(report.hint ?? "", /write access/);

    const who = await run("whoami");
    const whoReport = errorReport(who.error, "whoami");
    assert.equal(whoReport.code, "not_found");
    assert.match(whoReport.message, /cannot show your account details yet/);
    assert.match(whoReport.hint ?? "", /gauge orgs/);

    handler = () => html404;
    const unknown = await run("chat", "tags", "--org", ORG);
    const unknownReport = errorReport(unknown.error, "chat tags");
    assert.equal(unknownReport.code, "not_found");
    assert.equal(unknownReport.exitCode, 1);
    assert.match(
      unknownReport.message,
      /^This Gauge server \(127\.0\.0\.1:\d+\) does not support this command/,
    );
    assert.ok(!unknownReport.message.includes("<"), "no HTML in the message");
  });

  it("keeps the staff-only --explain out of query help", () => {
    const program = new Command();
    register(program);
    registerAuth(program);
    const query = program.commands
      .find((c) => c.name() === "chat")
      ?.commands.find((c) => c.name() === "query");
    assert.ok(query, "chat query is registered");
    assert.ok(!query.helpInformation().includes("--explain"));
  });

  it("reports that --explain is staff-only", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_cli_session";
    handler = () =>
      apiError(403, "forbidden", "explain is only available to Gauge staff", {
        field: "explain",
      });
    const { error: caught } = await run(
      "chat",
      "query",
      "--org",
      ORG,
      "--dataset",
      "aiTraffic",
      "-m",
      "requests",
      "--explain",
    );
    assert.equal(seen[0].body.explain, true);
    const report = errorReport(caught, "chat query");
    assert.equal(report.code, "forbidden");
    assert.equal(report.details?.field, "explain");
    assert.match(report.message, /^explain is only available/);
    assert.match(
      report.hint ?? "",
      /only available to Gauge staff; rerun without it/,
    );
  });

  it("prints hourly aiTraffic datetimes as returned", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_sk_abc";
    handler = () => ({
      body: {
        columns: [
          { key: "date", kind: "dimension", type: "datetime" },
          { key: "requests", kind: "metric", type: "number", unit: "requests" },
        ],
        rows: [
          { date: "2026-10-20T13:00:00Z", requests: 7 },
          { date: "2026-10-20T14:00:00Z", requests: 3 },
        ],
        labels: {},
        dateRange: { since: "2026-10-20", until: "2026-10-21" },
        truncated: false,
        cached: false,
        freshness: { watermark: null, pending: 0, available: true },
      },
    });
    await run(
      "chat",
      "query",
      "--org",
      ORG,
      "--dataset",
      "aiTraffic",
      "-d",
      "date",
      "-m",
      "requests",
      "--granularity",
      "hour",
    );
    assert.deepEqual(stdout, [
      "date                  requests",
      "2026-10-20T13:00:00Z  7",
      "2026-10-20T14:00:00Z  3",
    ]);
  });

  it("moves prompts with the bulk PATCH in batches of 500", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_sk_rw";
    handler = (req) =>
      req.path.endsWith("/topics")
        ? { body: { data: topics, nextCursor: null } }
        : {
            body: {
              updated: req.body.ids.slice(1),
              notFound: req.body.ids.slice(0, 1),
            },
          };
    const ids = Array.from({ length: 501 }, (_, i) => `prm_${i}`);
    const file = join(directory, "move.txt");
    writeFileSync(file, ids.join("\n"));
    const { json } = await run(
      "chat",
      "prompts",
      "move",
      "--file",
      file,
      "--topic",
      "Pricing",
      "--org",
      ORG,
      "--category",
      "crm",
      "-o",
      "json",
    );
    const patches = seen.filter((r) => r.method === "PATCH");
    assert.deepEqual(
      patches.map((r) => r.path),
      [
        api(`/orgs/${ORG}/categories/crm/prompts`),
        api(`/orgs/${ORG}/categories/crm/prompts`),
      ],
    );
    assert.deepEqual(
      patches.map((r) => [r.body.ids.length, r.body.topicId]),
      [
        [500, "top_1A"],
        [1, "top_1A"],
      ],
    );
    assert.equal(json.updated.length, 499);
    assert.deepEqual(json.notFound, ["prm_0", "prm_500"]);
  });

  it("reports a missing login without blaming local mode", async () => {
    const { error: caught } = await run("chat", "tags", "list");
    const report = errorReport(caught, "chat tags list", {
      local: "default",
    } as never);
    assert.equal(report.code, "unauthorized");
    assert.match(report.message, /Not logged in to Gauge/);
    assert.equal(seen.length, 0);
  });

  it("chunks prompt creation, previews multi-chunk writes, and reports per-item status", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_cli_rw";
    updateConfig({ orgId: ORG, chatCategory: "crm" });
    let remaining = 5000;
    handler = (req) => {
      if (req.path.endsWith("/topics"))
        return { body: { data: topics, nextCursor: null } };
      const dry = req.query.get("dryRun") === "true";
      const results = req.body.prompts.map(
        (p: { text: string; topicId: string }, index: number) => {
          assert.equal(p.topicId, "top_1A");
          if (p.text.startsWith("old"))
            return {
              index,
              status: "already_exists",
              prompt: { id: `prm_${p.text}` },
            };
          return dry
            ? { index, status: "would_create", prompt: null }
            : { index, status: "created", prompt: { id: `prm_${p.text}` } };
        },
      );
      return {
        status: dry ? 200 : 201,
        // `remaining` is what is left after this request, dry run or not.
        body: {
          results,
          dryRun: dry,
          remaining:
            remaining -
            results.filter(
              (r: { status: string }) => r.status !== "already_exists",
            ).length,
        },
      };
    };
    const lines = Array.from({ length: 1203 }, (_, i) =>
      i % 100 === 0 ? `old ${i}` : `new ${i}`,
    );
    const file = join(directory, "prompts.txt");
    writeFileSync(file, `${lines.join("\n")}\n\n`);

    const { json } = await run(
      "chat",
      "prompts",
      "add",
      "--file",
      file,
      "--topic",
      "pricing",
      "-o",
      "json",
    );
    const posts = seen.filter((r) => r.method === "POST");
    assert.equal(posts[0].path, api(`/orgs/${ORG}/categories/crm/prompts`));
    assert.deepEqual(
      posts.map(
        (r) => `${r.query.get("dryRun") ?? "-"}:${r.body.prompts.length}`,
      ),
      ["true:500", "true:500", "true:203", "-:500", "-:500", "-:203"],
    );
    assert.equal(json.results.length, 1203);
    assert.deepEqual(json.results[1100], {
      index: 1100,
      status: "already_exists",
      id: "prm_old 1100",
      text: "old 1100",
      prompt: { id: "prm_old 1100" },
    });
    assert.equal(json.results[1202].status, "created");
    assert.deepEqual(json.summary, {
      created: 1190,
      already_exists: 13,
      would_create: 0,
    });

    seen = [];
    const dry = await run(
      "chat",
      "prompts",
      "add",
      "a",
      "b",
      "--topic",
      "top_1A",
      "--dry-run",
      "-o",
      "json",
    );
    assert.deepEqual(
      seen.map((r) => r.query.get("dryRun")),
      ["true"],
    );
    assert.deepEqual(
      dry.json.results.map((r: { status: string }) => r.status),
      ["would_create", "would_create"],
    );

    seen = [];
    remaining = 1000;
    const { error: caught } = await run(
      "chat",
      "prompts",
      "add",
      "--file",
      file,
      "--topic",
      "top_1A",
    );
    const report = errorReport(caught, "chat prompts add");
    assert.equal(report.code, "limit_exceeded");
    assert.equal(report.exitCode, 3);
    assert.equal(
      seen.filter((r) => r.query.get("dryRun") !== "true").length,
      0,
    );
  });

  it("parses prompt files as lines, JSON Lines, or a JSON array", () => {
    assert.deepEqual(parsePromptInput("one\n\n  two  \n"), [
      { text: "one" },
      { text: "two" },
    ]);
    assert.deepEqual(
      parsePromptInput(
        'plain\n{"text":"obj","topicId":"top_1","tagIds":["tag_1"],"trackingType":"branded_own"}',
      ),
      [
        { text: "plain" },
        {
          text: "obj",
          topic: "top_1",
          tags: ["tag_1"],
          trackingType: "branded_own",
        },
      ],
    );
    assert.deepEqual(
      parsePromptInput('["a", {"text": "b", "topic": "Pricing"}]'),
      [
        { text: "a" },
        {
          text: "b",
          topic: "Pricing",
          tags: undefined,
          trackingType: undefined,
        },
      ],
    );
    assert.throws(
      () => parsePromptInput('[{"nope": 1}]'),
      /"text" must be a string/,
    );
  });

  it("untags prompts in chunks with a JSON DELETE body", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_sk_rw";
    handler = (req) => ({ body: { promptIds: req.body.promptIds } });
    const ids = Array.from({ length: 501 }, (_, i) => `prm_${i}`);
    const file = join(directory, "ids.txt");
    writeFileSync(file, ids.join("\n"));
    const tagged = await run(
      "chat",
      "prompts",
      "untag",
      "--file",
      file,
      "--tag",
      "tag_1A",
      "--org",
      ORG,
      "--category",
      "crm",
      "-o",
      "json",
    );
    assert.deepEqual(
      seen.map((r) => `${r.method} ${r.body.promptIds.length}`),
      ["DELETE 500", "DELETE 1"],
    );
    assert.equal(tagged.json.promptIds.length, 501);
  });

  it("has no prompt or topic delete commands", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_sk_rw";
    for (const group of ["prompts", "topics"]) {
      const { error: caught } = await run(
        "chat",
        group,
        "delete",
        "x",
        "--org",
        ORG,
        "--category",
        "crm",
        "--yes",
      );
      assert.ok(caught, `${group} delete is rejected`);
      assert.equal(errorReport(caught, `chat ${group}`).exitCode, 2);
      assert.deepEqual(seen, [], `${group} delete sends no request`);
    }
  });
});
