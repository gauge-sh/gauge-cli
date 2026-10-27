import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Command, Option } from "commander";
import { ensureAccount } from "../lib/account";
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
let handler: (path: string, method?: string) => Reply;
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
      const reply = handler(path, req.method);
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

  it("lists only canonical organizations without consulting Agents", async () => {
    updateConfig({ orgId: ACME });
    const { json, error } = await run("orgs", "-o", "json");
    assert.equal(error, undefined);
    assert.deepEqual(
      json,
      chatDirectory.data.map((org) => ({ ...org, isDefault: org.id === ACME })),
    );
    assert.deepEqual(paths, ["/api/v1/orgs"]);
    await run("orgs", "list");
    assert.match(stdout.join("\n"), /acme\s+Acme\s+Chat, Agents/);
    assert.ok(!stdout.join("\n").includes(ACME));
  });

  it("stores a canonical selection and removes the ambiguous old default", async () => {
    updateConfig({ defaultOrg: "acme-1a2b3c4d", chatCategory: "pricing" });
    for (const value of ["acme", ACME]) {
      const { json, error } = await run("orgs", "use", value, "-o", "json");
      assert.equal(error, undefined);
      assert.deepEqual(json, { orgId: ACME, slug: "acme", name: "Acme" });
      assert.equal(readConfig().orgId, ACME);
      assert.equal(readConfig().defaultOrg, undefined);
      assert.equal(readConfig().chatCategory, "pricing");
    }
    paths = [];
    assert.equal(await resolveOrg(agentsCommand()), ACME);
    assert.deepEqual(paths, [], "saved canonical IDs need no lookup");
  });

  it("requires reselection of old saved slugs, even when they match a canonical slug", async () => {
    updateConfig({ defaultOrg: "acme" });
    await assert.rejects(
      resolveOrg(agentsCommand()),
      /legacy Agents namespace/,
    );
    assert.equal(readConfig().defaultOrg, "acme");
    assert.deepEqual(paths, []);
    const cmd = agentsCommand().setOptionValue("org", "acme");
    assert.equal(await resolveOrg(cmd), ACME);
  });

  it("migrates a project by public slug and preserves unrelated configuration", async () => {
    const manifest = {
      version: 2,
      org: "acme-1a2b3c4d",
      inputs: { app: { root: "." } },
    };
    const path = join(directory, "gauge.json");
    writeFileSync(path, JSON.stringify(manifest));
    await assert.rejects(
      resolveOrg(agentsCommand()),
      /legacy Agents namespace/,
    );
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), manifest);
    const result = await run("orgs", "use", "acme", "--project");
    assert.equal(result.error, undefined);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      version: 2,
      orgId: ACME,
      inputs: manifest.inputs,
    });
    assert.equal(await resolveOrg(agentsCommand()), ACME);
    assert.equal(readConfig().orgId, undefined);
  });

  it("rejects unknown, internal, and unlinked workspace slugs without passing them to Agents", async () => {
    for (const value of ["sandbox", "staff-only-slug", "acme-1a2b3c4d"]) {
      const { error } = await run("orgs", "use", value);
      assert.match(
        errorReport(error, "orgs use").message,
        /not found in the Gauge directory/,
      );
    }
    assert.ok(paths.every((path) => path === "/api/v1/orgs"));
    assert.equal(readConfig().orgId, undefined);
  });

  it("propagates directory failures and leaves the selection unchanged", async () => {
    updateConfig({ orgId: BETA });
    handler = () => ({
      status: 403,
      body: { error: { code: "forbidden", message: "Directory unavailable" } },
    });
    const result = await run("orgs", "use", "acme");
    assert.equal(errorReport(result.error, "orgs use").code, "forbidden");
    assert.equal(readConfig().orgId, BETA);
    assert.deepEqual(paths, ["/api/v1/orgs"]);
  });

  it("does not reuse slug mappings after directory membership changes", async () => {
    const cmd = agentsCommand().setOptionValue("org", "acme");
    assert.equal(await resolveOrg(cmd), ACME);
    handler = () => ({ body: { data: [] } });
    await assert.rejects(resolveOrg(cmd), /not found in the Gauge directory/);
    assert.deepEqual(paths, ["/api/v1/orgs", "/api/v1/orgs"]);
  });

  it("asks legacy token users to log in for the canonical directory", async () => {
    process.env.GAUGE_API_TOKEN = "gauge_legacy";
    const result = await run("orgs");
    assert.match(
      errorReport(result.error, "orgs").hint ?? "",
      /gauge auth login/,
    );
    assert.deepEqual(paths, []);
  });

  it("rejects legacy run-spec slugs unless a public --org is supplied", async () => {
    await assert.rejects(
      resolveOrg(agentsCommand(), "acme"),
      /legacy Agents namespace/,
    );
    const cmd = agentsCommand().setOptionValue("org", "beta");
    assert.equal(await resolveOrg(cmd, "acme"), BETA);
  });

  it("saves the canonical organization after creation, and honors --no-use", async () => {
    handler = (path, method) =>
      method === "POST" && path === "/api/v1/orgs"
        ? { body: { slug: "acme-1a2b3c4d", name: "Acme", publicId: null } }
        : defaultHandler(path);
    updateConfig({ orgId: BETA });
    const unused = await run(
      "orgs",
      "create",
      "Acme",
      "--no-use",
      "-o",
      "json",
    );
    assert.equal(unused.error, undefined);
    assert.equal(unused.json.slug, "acme");
    assert.equal(readConfig().orgId, BETA);
    const selected = await run("orgs", "create", "Acme", "-o", "json");
    assert.equal(selected.error, undefined);
    assert.equal(selected.json.id, ACME);
    assert.equal(readConfig().orgId, ACME);
  });

  it("does not save an unlinked workspace returned by an older creation server", async () => {
    updateConfig({ orgId: BETA });
    handler = (path, method) =>
      method === "POST" && path === "/api/v1/orgs"
        ? { body: { slug: "sandbox", name: "Sandbox", publicId: null } }
        : defaultHandler(path);
    const result = await run("orgs", "create", "Sandbox");
    assert.match(
      errorReport(result.error, "orgs create").message,
      /created.*did not link/,
    );
    assert.equal(readConfig().orgId, BETA);
  });

  it("onboarding creates, saves, and seeds using the canonical organization", async () => {
    handler = (path, method) => {
      if (method === "POST" && path === "/api/v1/orgs")
        return {
          body: { slug: "acme-1a2b3c4d", name: "Acme", publicId: null },
        };
      if (path === `/api/v1/orgs/${ACME}/onboarding/seed`)
        return { body: { evalSets: 1, visibilityPrompts: 2, markets: 1 } };
      return defaultHandler(path);
    };
    const result = await ensureAccount({
      new: true,
      orgName: "Acme",
      log: () => {},
    });
    assert.equal(result.org, ACME);
    assert.equal(result.organization.slug, "acme");
    assert.equal(readConfig().orgId, ACME);
    assert.equal(result.seeded?.evalSets, 1);
    assert.equal(paths.at(-1), `/api/v1/orgs/${ACME}/onboarding/seed`);
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
