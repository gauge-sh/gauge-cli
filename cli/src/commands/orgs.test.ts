import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Command, Option } from "commander";
import { createClient } from "../lib/client";
import { readConfig, updateConfig } from "../lib/config";
import { resolveOrg } from "../lib/context";
import { errorReport } from "../lib/errors";
import { register } from "./orgs";

const ACME = "8c7f0e1a-1111-4222-8333-944455556666";
const BETA = "1d2e3f40-5555-4666-8777-988899990000";
const CHAT_ONLY = "3a4b5c6d-7777-4888-9999-aaaabbbbcccc";

type Reply = { status?: number; body: unknown };

let server: Server;
let paths: string[];
let directory: string;
let saved: NodeJS.ProcessEnv;
let cwd: string;
let stdout: string[];
let stderr: string[];
let handler: (path: string) => Reply;
const log = console.log;
const error = console.error;

const chatDirectory = {
  data: [
    {
      id: ACME,
      slug: "acme",
      name: "Acme",
      products: { chat: true, agents: true },
    },
    {
      id: CHAT_ONLY,
      slug: "chatco",
      name: "ChatCo",
      products: { chat: true, agents: false },
    },
    {
      id: BETA,
      slug: "beta",
      name: "Beta",
      products: { chat: false, agents: null },
    },
  ],
};
const agentsMe = {
  user: { id: "u", email: "u@example.com" },
  orgs: [
    {
      slug: "acme-1a2b3c4d",
      publicId: null,
      canonicalGaugeOrganizationId: ACME,
      name: "Acme",
    },
    {
      slug: "beta-9f8e7d6c",
      publicId: null,
      canonicalGaugeOrganizationId: BETA,
      name: "Beta",
    },
    {
      slug: "sandbox",
      publicId: null,
      canonicalGaugeOrganizationId: null,
      name: "Sandbox",
    },
  ],
};

// Chat and Agents share one test origin: Chat answers /api/v1/orgs, Agents
// answers /api/v1/me.
function defaultHandler(path: string): Reply {
  if (path === "/api/v1/orgs") return { body: chatDirectory };
  if (path === "/api/v1/me") return { body: agentsMe };
  return { body: { ok: true } };
}

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
    return { json: undefined, error: caught };
  }
  const text = stdout.join("\n");
  try {
    return { json: JSON.parse(text) };
  } catch {
    return { json: text };
  }
}

function agentsCommand(): Command {
  return new Command().option("--org <org>").option("--hosted");
}

describe("gauge orgs and org selection", { concurrency: false }, () => {
  beforeEach(async () => {
    saved = { ...process.env };
    cwd = process.cwd();
    directory = mkdtempSync(join(tmpdir(), "gauge-orgs-"));
    process.chdir(directory);
    process.env.XDG_CONFIG_HOME = directory;
    process.env.GAUGE_API_TOKEN = "gauge_cli_session";
    paths = [];
    handler = defaultHandler;
    server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      paths.push(path);
      const reply = handler(path);
      res.writeHead(reply.status ?? 200, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify(reply.body));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
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
    rmSync(directory, { recursive: true, force: true });
  });

  it("lists every org with its products, Agents filling what Chat couldn't ask", async () => {
    updateConfig({ defaultOrg: "acme-1a2b3c4d" });
    const { json } = await run("orgs", "-o", "json");
    assert.deepEqual(json, [
      {
        id: ACME,
        slug: "acme",
        name: "Acme",
        products: { chat: true, agents: true },
        agentsSlug: "acme-1a2b3c4d",
        isDefault: true,
      },
      {
        id: CHAT_ONLY,
        slug: "chatco",
        name: "ChatCo",
        products: { chat: true, agents: false },
        agentsSlug: null,
        isDefault: false,
      },
      {
        id: BETA,
        slug: "beta",
        name: "Beta",
        products: { chat: false, agents: true },
        agentsSlug: "beta-9f8e7d6c",
        isDefault: false,
      },
      {
        id: null,
        slug: "sandbox",
        name: "Sandbox",
        products: { chat: false, agents: true },
        agentsSlug: "sandbox",
        isDefault: false,
      },
    ]);
    await run("orgs", "list");
    assert.match(stdout.join("\n"), /acme\s+Acme\s+Chat, Agents/);
  });

  it("stores the shared id for a Chat slug, legacy Agents slug, or id", async () => {
    for (const value of ["acme", "acme-1a2b3c4d", ACME]) {
      const { json } = await run("orgs", "use", value, "-o", "json");
      assert.deepEqual(json, { defaultOrg: ACME, name: "Acme" });
      assert.equal(readConfig().defaultOrg, ACME);
    }
    const { json } = await run("orgs", "use", "sandbox", "-o", "json");
    assert.deepEqual(json, { defaultOrg: "sandbox", name: "Sandbox" });
  });

  it("rewrites a legacy defaultOrg to the shared id, once", async () => {
    updateConfig({ defaultOrg: "beta-9f8e7d6c" });
    assert.equal(await resolveOrg(agentsCommand()), BETA);
    assert.equal(readConfig().defaultOrg, BETA);
    assert.match(stderr.join("\n"), /now stored as its organization id/);
    paths = [];
    assert.equal(await resolveOrg(agentsCommand()), BETA);
    assert.deepEqual(paths, [], "an id needs no lookup");
  });

  it("never rewrites gauge.json, hints once, and caches the resolution", async () => {
    writeFileSync(
      join(directory, "gauge.json"),
      '{"version":2,"org":"acme-1a2b3c4d","inputs":{}}',
    );
    assert.equal(await resolveOrg(agentsCommand()), ACME);
    assert.equal(await resolveOrg(agentsCommand()), ACME);
    assert.deepEqual(paths.sort(), ["/api/v1/me", "/api/v1/orgs"]);
    assert.equal(
      stderr.filter((line) => line.includes("gauge.json org")).length,
      1,
    );
    assert.equal(readConfig().defaultOrg, undefined);
  });

  it("passes an unknown or LOCAL value through to Agents", async () => {
    const command = agentsCommand();
    command.setOptionValue("org", "sandbox");
    assert.equal(await resolveOrg(command), "sandbox");
    command.setOptionValue("org", "staff-only-slug");
    assert.equal(await resolveOrg(command), "staff-only-slug");
    handler = (path) =>
      path === "/api/v1/orgs"
        ? { status: 500, body: {} }
        : defaultHandler(path);
    command.setOptionValue("org", "beta-9f8e7d6c");
    assert.equal(
      await resolveOrg(command),
      BETA,
      "Agents alone resolves a legacy slug when Chat is down",
    );
  });

  it("says an org doesn't use Gauge Agents instead of a bare 404", async () => {
    handler = (path) =>
      path.startsWith(`/api/v1/orgs/${CHAT_ONLY}`)
        ? {
            status: 404,
            body: {
              error: {
                code: "not_found",
                message: `Organization not found: "${CHAT_ONLY}"`,
              },
            },
          }
        : defaultHandler(path);
    const caught = await createClient()
      .get(`/api/v1/orgs/${CHAT_ONLY}/dashboards`)
      .catch((e: unknown) => e);
    const report = errorReport(caught, "dashboards list");
    assert.equal(report.code, "not_found");
    assert.equal(report.message, "ChatCo doesn't use Gauge Agents.");
    assert.match(report.hint ?? "", /gauge orgs/);
  });
});
