import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Command, Option } from "commander";
import { updateConfig } from "../lib/config";
import { errorReport } from "../lib/errors";
import { parseAccess, parseExpiryDays, register } from "./apiKeys";
import { register as registerAuth } from "./auth";

const ACME = "8c7f0e1a-1111-4222-8333-944455556666";
const BETA = "1d2e3f40-5555-4666-8777-988899990000";
const SECRET = "gauge_sk_test_secret_value";

const directory = {
  data: [
    { id: ACME, slug: "acme", name: "Acme", products: { chat: true, agents: true } },
    { id: BETA, slug: "beta", name: "Beta", products: { chat: false, agents: true } },
  ],
};
const existingKey = {
  id: "42",
  name: "ci",
  prefix: "gauge_sk_abcd",
  access: "read",
  createdBy: "u@example.com",
  createdAt: "2026-11-01T00:00:00Z",
  lastUsedAt: null,
  expiresAt: null,
};

type Request = { method: string; path: string; body?: unknown; auth?: string };
type Reply = { status?: number; body?: unknown };

let server: Server;
let requests: Request[];
let handler: (req: Request) => Reply;
let saved: NodeJS.ProcessEnv;
let cwd: string;
let dir: string;
let stdout: string[];
let stderr: string[];
const log = console.log;
const error = console.error;

function defaultHandler(req: Request): Reply {
  if (req.path === "/api/v1/orgs") return { body: directory };
  const keys = `/api/v1/orgs/${ACME}/api-keys`;
  if (req.path === keys && req.method === "GET")
    return { body: { data: [existingKey], nextCursor: null } };
  if (req.path === keys && req.method === "POST") {
    const body = req.body as { name: string; access: string };
    return {
      status: 201,
      body: { ...existingKey, id: "43", name: body.name, access: body.access, key: SECRET },
    };
  }
  if (req.path === `${keys}/42` && req.method === "DELETE") return { status: 204 };
  return { status: 404, body: { error: { code: "not_found", message: "Not found" } } };
}

async function run(...args: string[]): Promise<{ out: string; error?: unknown }> {
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
    return { out: stdout.join("\n"), error: caught };
  }
  return { out: stdout.join("\n") };
}

const mutations = () => requests.filter((r) => r.method !== "GET");

describe("gauge api-keys", { concurrency: false }, () => {
  beforeEach(async () => {
    saved = { ...process.env };
    cwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "gauge-api-keys-"));
    process.chdir(dir);
    process.env.XDG_CONFIG_HOME = dir;
    process.env.GAUGE_API_TOKEN = "gauge_cli_session";
    requests = [];
    handler = defaultHandler;
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const entry: Request = {
          method: req.method ?? "GET",
          path: new URL(req.url ?? "/", "http://localhost").pathname,
          body: raw ? JSON.parse(raw) : undefined,
          auth: req.headers.authorization,
        };
        requests.push(entry);
        const reply = handler(entry);
        res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
        res.end(reply.body === undefined ? undefined : JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.GAUGE_AUTH_URL = origin;
    process.env.GAUGE_API_URL = origin;
    console.log = (...args: unknown[]) => void stdout.push(args.join(" "));
    console.error = (...args: unknown[]) => void stderr.push(args.join(" "));
  });

  afterEach(async () => {
    console.log = log;
    console.error = error;
    process.env = saved;
    process.chdir(cwd);
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses access and expiry flags", () => {
    assert.equal(parseAccess("read"), "read");
    assert.equal(parseAccess("WRITE"), "read_write");
    assert.throws(() => parseAccess("admin"), /--access must be read or write/);
    assert.equal(parseExpiryDays("never"), null);
    assert.equal(parseExpiryDays("90d"), 90);
    assert.equal(parseExpiryDays("365"), 365);
    assert.throws(() => parseExpiryDays("12h"), /30d, 90d, 365d, or never/);
  });

  it("lists keys for the saved organization without secrets", async () => {
    updateConfig({ orgId: ACME });
    const { out, error } = await run("api-keys", "list");
    assert.equal(error, undefined);
    assert.match(out, /42\s+ci\s+gauge_sk_abcd\s+read-only\s+never/);
    assert.deepEqual(requests.map((r) => r.path), [`/api/v1/orgs/${ACME}/api-keys`]);
    assert.equal(requests[0].auth, "Bearer gauge_cli_session");
  });

  it("creates a key in the --org organization and prints the secret once", async () => {
    const { out, error } = await run(
      "api-keys", "create", "deploy bot", "--org", "acme", "--access", "write", "--expires-in", "90d",
    );
    assert.equal(error, undefined);
    assert.deepEqual(mutations(), [
      {
        method: "POST",
        path: `/api/v1/orgs/${ACME}/api-keys`,
        body: { name: "deploy bot", access: "read_write", expiresInDays: 90 },
        auth: "Bearer gauge_cli_session",
      },
    ]);
    assert.match(out, /Created read & write API key "deploy bot" for Acme/);
    assert.equal(out.split(SECRET).length - 1, 1, "secret printed exactly once");
    assert.equal(stderr.join("\n").includes(SECRET), false);
  });

  it("returns the created key, including its secret, as JSON", async () => {
    updateConfig({ orgId: ACME });
    const { out, error } = await run("api-keys", "create", "ci", "-o", "json");
    assert.equal(error, undefined);
    const json = JSON.parse(out);
    assert.equal(json.key, SECRET);
    assert.deepEqual(mutations()[0].body, { name: "ci", access: "read", expiresInDays: null });
  });

  it("rejects invalid flags before calling Gauge", async () => {
    updateConfig({ orgId: ACME });
    for (const args of [["--access", "owner"], ["--expires-in", "12h"]]) {
      const { error } = await run("api-keys", "create", "ci", ...args);
      assert.equal(errorReport(error, "api-keys create").code, "usage");
    }
    assert.deepEqual(requests, []);
  });

  it("asks for an organization when several are available", async () => {
    const { error } = await run("api-keys", "list");
    const report = errorReport(error, "api-keys list");
    assert.equal(report.code, "usage");
    assert.match(report.message, /several organizations \(acme, beta\)/);
  });

  for (const [token, pattern] of [
    ["gauge_sk_leaked", /API keys can't list, create, or revoke API keys/],
    ["gauge_legacy_pat", /older Agents token can't manage/],
  ] as const) {
    it(`refuses to manage keys with ${token.split("_").slice(0, 2).join("_")}_ credentials`, async () => {
      process.env.GAUGE_API_TOKEN = token;
      for (const args of [["list"], ["create", "ci"], ["revoke", "42", "--yes"]]) {
        const { error } = await run("api-keys", ...args, "--org", ACME);
        const report = errorReport(error, "api-keys");
        assert.equal(report.code, "forbidden");
        assert.match(report.message, pattern);
      }
      assert.deepEqual(requests, [], "nothing is sent to Gauge");
    });
  }

  it("revokes a listed key after confirmation", async () => {
    updateConfig({ orgId: ACME });
    const { out, error } = await run("api-keys", "revoke", "42", "--yes");
    assert.equal(error, undefined);
    assert.deepEqual(mutations().map((r) => [r.method, r.path]), [
      ["DELETE", `/api/v1/orgs/${ACME}/api-keys/42`],
    ]);
    assert.match(out, /Revoked API key "ci" \(42\)/);
  });

  it("does not revoke without --yes on a non-interactive stdin, or an unknown id", async () => {
    updateConfig({ orgId: ACME });
    const isTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;
    try {
      const noConfirm = await run("api-keys", "revoke", "42");
      assert.match(errorReport(noConfirm.error, "api-keys revoke").message, /pass --yes/);
    } finally {
      process.stdin.isTTY = isTTY;
    }
    const unknown = await run("api-keys", "revoke", "999", "--yes");
    assert.equal(errorReport(unknown.error, "api-keys revoke").code, "not_found");
    assert.deepEqual(mutations(), []);
  });

  it("explains when the Gauge server does not support API key management yet", async () => {
    updateConfig({ orgId: ACME });
    handler = (req) =>
      req.path === "/api/v1/orgs" ? { body: directory } : { status: 404, body: "<html>Not Found</html>" };
    const { error } = await run("api-keys", "list");
    const report = errorReport(error, "api-keys list");
    assert.equal(report.code, "not_found");
    assert.match(report.message, /does not support this command/);
  });

  it("points `auth tokens create` at `api-keys create` for a login and refuses API keys", async () => {
    const login = await run("auth", "tokens", "create", "ci");
    const loginReport = errorReport(login.error, "auth tokens create");
    assert.equal(loginReport.code, "forbidden");
    assert.match(loginReport.hint ?? "", /gauge api-keys create "ci" --access write/);

    process.env.GAUGE_API_TOKEN = "gauge_sk_leaked";
    const key = await run("auth", "tokens", "create", "ci");
    const keyReport = errorReport(key.error, "auth tokens create");
    assert.equal(keyReport.code, "forbidden");
    assert.match(keyReport.message, /API keys can't create tokens/);
    assert.deepEqual(requests, []);
  });
});
