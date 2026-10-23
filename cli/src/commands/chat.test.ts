import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { readCredentials, saveCredentials } from "../lib/credentials";
import { errorReport } from "../lib/errors";
import { register } from "./chat";
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

  it("sends a personal access token from GAUGE_API_TOKEN to the Chat origin", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_pat_abc";
    handler = () => ({
      body: {
        data: [{ id: "uuid", slug: "acme", name: "Acme" }],
        nextCursor: null,
      },
    });
    const { json } = await run("chat", "orgs", "-o", "json");
    assert.equal(seen[0].path, api("/orgs"));
    assert.equal(seen[0].auth, "Bearer gauge_pat_abc");
    assert.deepEqual(json.data[0], {
      id: "uuid",
      slug: "acme",
      name: "Acme",
      isDefault: false,
    });
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
      "acme",
      "-o",
      "json",
    );
    assert.deepEqual(
      seen.map((r) => `${r.path} ${r.auth ?? ""}`.trim()),
      [
        `${api("/orgs/acme/tags")} Bearer gauge_cli_old`,
        "/api/cli/refresh",
        `${api("/orgs/acme/tags")} Bearer gauge_cli_new`,
      ],
    );
    assert.equal(json.data[0].id, "tag_1A");
    assert.equal(
      (readCredentials() as { refreshToken: string }).refreshToken,
      "gauge_refresh_new",
    );
  });

  it("follows cursors with --all, bounded by --max, and resolves tag names", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_pat_abc";
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
      // Six prompts; the cursor is an offset and the page honors limit.
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
      "acme",
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
    assert.equal(pages[0].path, api("/orgs/acme/categories/crm/prompts"));
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
      "acme",
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
    process.env.GAUGE_API_TOKEN = "gauge_pat_abc";
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
      if (req.path === api("/orgs"))
        return { body: { data: [{ id: "u", slug: "acme", name: "Acme" }] } };
      if (req.path === api("/orgs/acme/categories"))
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
    assert.equal(post?.path, api("/orgs/acme/query"));
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
    // Table output shows labels and formats 0-1 rates like `gauge query`.
    assert.match(stdout.join("\n"), /Acme\s+42.5%/);

    seen = [];
    await run(
      "chat",
      "query",
      "--org",
      "acme",
      "-o",
      "json",
      "--json",
      '{"dataset":"aiTraffic","metrics":["requests"],"dimensions":["date"]}',
      "--granularity",
      "hour",
    );
    assert.deepEqual(
      seen.map((r) => r.path),
      [api("/orgs/acme/query")],
    );
    assert.deepEqual(seen[0].body, {
      dataset: "aiTraffic",
      metrics: ["requests"],
      dimensions: ["date"],
      granularity: "hour",
    });
  });

  it("maps API errors to codes, details and exit codes", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_pat_read";
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
        /'write' scope/,
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
        "acme",
      );
      const report = errorReport(caught, "chat tags create");
      assert.equal(report.code, code);
      assert.equal(report.exitCode, exitCode, code);
      assert.ok(!report.message.includes("\n"), "single-line message");
      if (code !== "internal")
        assert.match(report.message, new RegExp(`^${code}: `));
      assert.match(`${report.hint ?? ""}${report.message}`, hint);
      for (const [key, value] of Object.entries(details ?? {}))
        assert.equal(report.details?.[key], value, `${code}.${key}`);
    }
  });

  it("explains insufficient_scope with the token's scopes from /api/v1/me", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_pat_read";
    const me = {
      user: { id: "u1", email: "a@b.co", name: "A" },
      token: {
        kind: "personal",
        scopes: ["read"],
        expiresAt: "2027-01-01T00:00:00Z",
      },
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
    const { error: caught } = await run(
      "chat",
      "tags",
      "create",
      "x",
      "--org",
      "acme",
    );
    assert.match(
      errorReport(caught, "chat tags create").hint ?? "",
      /personal access token has scopes \[read\] and needs 'write'/,
    );
    const who = await run("chat", "whoami", "-o", "json");
    assert.deepEqual(who.json, me);
    assert.equal(seen.at(-1)?.path, api("/me"));
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
    const scoped = await run("chat", "tags", "create", "x", "--org", "acme");
    const report = errorReport(scoped.error, "chat tags create");
    assert.equal(report.code, "insufficient_scope");
    assert.match(report.hint ?? "", /needs the 'write' scope/);

    const who = await run("chat", "whoami");
    const whoReport = errorReport(who.error, "chat whoami");
    assert.equal(whoReport.code, "not_found");
    assert.match(whoReport.message, /\/api\/v1\/me is not available/);
    assert.match(whoReport.hint ?? "", /gauge chat orgs/);

    handler = () => html404;
    const unknown = await run("chat", "tags", "--org", "acme");
    const unknownReport = errorReport(unknown.error, "chat tags");
    assert.equal(unknownReport.code, "not_found");
    assert.equal(unknownReport.exitCode, 1);
    assert.match(
      unknownReport.message,
      /^not_found: \/api\/v1\/orgs\/acme\/tags on 127\.0\.0\.1:\d+ is not a Gauge Chat API endpoint/,
    );
    assert.ok(!unknownReport.message.includes("<"), "no HTML in the message");
  });

  it("keeps the staff-only --explain out of query help", () => {
    const program = new Command();
    register(program);
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
      "acme",
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
    assert.match(report.message, /^forbidden: explain is only available/);
    assert.match(
      report.hint ?? "",
      /only available to Gauge staff; rerun without it/,
    );
  });

  it("prints hourly aiTraffic datetimes as returned", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_pat_abc";
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
      "acme",
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
    process.env.GAUGE_API_TOKEN = "gauge_pat_rw";
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
      "acme",
      "--category",
      "crm",
      "-o",
      "json",
    );
    const patches = seen.filter((r) => r.method === "PATCH");
    assert.deepEqual(
      patches.map((r) => r.path),
      [
        api("/orgs/acme/categories/crm/prompts"),
        api("/orgs/acme/categories/crm/prompts"),
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
    const { error: caught } = await run("chat", "orgs");
    const report = errorReport(caught, "chat orgs", {
      local: "default",
    } as never);
    assert.equal(report.code, "unauthorized");
    assert.match(report.message, /Not logged in to Gauge Chat/);
    assert.equal(seen.length, 0);
  });

  it("chunks prompt creation, previews multi-chunk writes, and reports per-item status", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_pat_rw";
    updateConfig({ chatOrg: "acme", chatCategory: "crm" });
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
    assert.equal(posts[0].path, api("/orgs/acme/categories/crm/prompts"));
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

    // Dry run sends only previews.
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

    // A plan limit found in preview fails before anything is written.
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
    process.env.GAUGE_API_TOKEN = "gauge_pat_rw";
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
      "acme",
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
    process.env.GAUGE_API_TOKEN = "gauge_pat_rw";
    for (const group of ["prompts", "topics"]) {
      const { error: caught } = await run(
        "chat",
        group,
        "delete",
        "x",
        "--org",
        "acme",
        "--category",
        "crm",
        "--yes",
      );
      assert.ok(caught, `${group} delete is rejected`);
      assert.equal(errorReport(caught, `chat ${group}`).exitCode, 2);
      assert.deepEqual(seen, [], `${group} delete sends no request`);
    }
  });

  it("waits for an export and downloads its files without Gauge credentials", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_pat_read";
    let polls = 0;
    const exportOut = (status: string) => ({
      id: "exp_1A",
      status,
      dateRange: { since: "2026-10-01", until: "2026-10-07" },
      createdAt: "2026-10-08T00:00:00Z",
      completedAt: status === "completed" ? "2026-10-08T00:01:00Z" : null,
      files:
        status === "completed"
          ? [
              {
                kind: "answers",
                url: `${origin}/files/answers.csv?sig=1`,
                expiresAt: "2026-10-08T01:00:00Z",
              },
            ]
          : [],
    });
    handler = (req) => {
      if (req.path.startsWith("/files/")) return { body: "a,b\n1,2\n" };
      if (req.method === "POST")
        return { status: 202, body: exportOut("pending") };
      polls++;
      return { body: exportOut(polls < 3 ? "pending" : "completed") };
    };
    const dir = join(directory, "out");
    const { json } = await run(
      "chat",
      "exports",
      "create",
      "--org",
      "acme",
      "--since",
      "2026-10-01",
      "--until",
      "2026-10-07",
      "--download",
      dir,
      "--interval",
      "0",
      "-o",
      "json",
    );
    assert.deepEqual(seen[0].body, {
      dateRange: { since: "2026-10-01", until: "2026-10-07" },
    });
    assert.equal(polls, 3);
    assert.deepEqual(
      seen.filter((r) => r.method === "POST").map((r) => r.path),
      [api("/orgs/acme/exports")],
      "--download polls with GET and never re-requests",
    );
    assert.equal(json.status, "completed");
    assert.equal(readFileSync(json.downloaded[0].path, "utf8"), "a,b\n1,2\n");
    assert.match(json.downloaded[0].path, /exp_1A-answers\.csv$/);
    const fileRequest = seen.find((r) => r.path.startsWith("/files/"));
    assert.equal(fileRequest?.auth, undefined);

    handler = () => ({ body: exportOut("pending") });
    seen = [];
    const { error: caught } = await run(
      "chat",
      "exports",
      "get",
      "exp_1A",
      "--org",
      "acme",
      "--wait",
      "--timeout",
      "0",
      "--interval",
      "0",
    );
    const timeout = errorReport(caught, "chat exports get");
    assert.equal(timeout.code, "wait_timeout");
    assert.match(
      timeout.hint ?? "",
      /2 hours.*gauge chat exports create --since 2026-10-01 --until 2026-10-07/,
    );
    assert.ok(seen.every((r) => r.method === "GET"));

    // An export pending for over 2 hours points at re-requesting the range.
    await run("chat", "exports", "get", "exp_1A", "--org", "acme");
    assert.match(
      stderr.join("\n"),
      /pending since 2026-10-08T00:00:00Z.*retries it/,
    );
  });
});
