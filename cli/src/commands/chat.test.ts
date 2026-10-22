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
        { key: "visibility", kind: "metric", type: "rate", unit: "percent" },
      ],
      rows: [{ brand: "brd_1A", visibility: 42.5 }],
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
    // Table output shows labels and percent units.
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
        body: { results, dryRun: dry, remaining },
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

  it("tags prompts in chunks and deletes with a JSON body", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_pat_rw";
    handler = (req) => {
      if (req.path.endsWith("/prompts/tags"))
        return { body: { promptIds: req.body.promptIds } };
      return {
        body: {
          deleted: req.body.ids.slice(1),
          notFound: req.body.ids.slice(0, 1),
          dryRun: true,
        },
      };
    };
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

    seen = [];
    const deleted = await run(
      "chat",
      "prompts",
      "delete",
      "prm_a",
      "prm_b",
      "--dry-run",
      "--org",
      "acme",
      "--category",
      "crm",
      "-o",
      "json",
    );
    assert.equal(seen[0].method, "DELETE");
    assert.equal(seen[0].query.get("dryRun"), "true");
    assert.deepEqual(seen[0].body, { ids: ["prm_a", "prm_b"] });
    assert.deepEqual(deleted.json, {
      deleted: ["prm_b"],
      notFound: ["prm_a"],
      dryRun: true,
    });

    const refused = await run(
      "chat",
      "prompts",
      "delete",
      "prm_a",
      "--org",
      "acme",
      "--category",
      "crm",
    );
    assert.match(String((refused.error as Error).message), /--yes/);
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
    assert.equal(json.status, "completed");
    assert.equal(readFileSync(json.downloaded[0].path, "utf8"), "a,b\n1,2\n");
    assert.match(json.downloaded[0].path, /exp_1A-answers\.csv$/);
    const fileRequest = seen.find((r) => r.path.startsWith("/files/"));
    assert.equal(fileRequest?.auth, undefined);

    handler = () => ({ body: exportOut("pending") });
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
    assert.equal(errorReport(caught, "chat exports get").code, "wait_timeout");
  });
});
