import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { Command } from "commander";
import { CliError } from "../lib/client";
import { register as registerEval } from "./eval";

type Request = { method: string; url: string; body: unknown };

const ORG = "8c7f0e1a-1111-4222-8333-944455556666";
const BASE = `/api/v1/orgs/${ORG}`;

function useApi(t: TestContext, response: unknown): Request[] {
  const previousToken = process.env.GAUGE_API_TOKEN;
  const previousUrl = process.env.GAUGE_API_URL;
  process.env.GAUGE_API_TOKEN = "gauge_test";
  process.env.GAUGE_API_URL = "https://test.invalid";
  t.after(() => {
    if (previousToken === undefined) delete process.env.GAUGE_API_TOKEN;
    else process.env.GAUGE_API_TOKEN = previousToken;
    if (previousUrl === undefined) delete process.env.GAUGE_API_URL;
    else process.env.GAUGE_API_URL = previousUrl;
  });
  const requests: Request[] = [];
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        method: init?.method ?? "GET",
        url: String(url).replace("https://test.invalid", ""),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json(response);
    },
  );
  return requests;
}

async function gauge(args: string[], mode = "--hosted"): Promise<void> {
  const root = new Command()
    .option("--org <org>")
    .option("-o, --output <format>")
    .option("--local")
    .option("--hosted")
    .exitOverride();
  registerEval(root);
  await root.parseAsync(["--org", ORG, "-o", "json", mode, ...args], {
    from: "user",
  });
}

async function usageError(args: string[], mode?: string): Promise<string> {
  try {
    await gauge(args, mode);
  } catch (error) {
    assert.ok(error instanceof CliError, String(error));
    assert.equal(error.exitCode, 2);
    return error.message;
  }
  assert.fail(`expected a usage error for ${args.join(" ")}`);
}

describe("gauge eval journey", () => {
  it("routes journey commands and addresses a journey by name", async (t) => {
    const requests = useApi(t, { id: "j1", name: "Docs", items: [] });
    await gauge(["eval", "journey", "list"]);
    await gauge(["eval", "journey", "get", "Product Workflows"]);
    await gauge([
      "eval",
      "journey",
      "create",
      "--name",
      "Docs",
      "--description",
      "Read the docs.",
    ]);
    await gauge(["eval", "journey", "edit", "docs", "--clear-description"]);
    await gauge(["eval", "journey", "rm", "docs"]);
    assert.deepEqual(
      requests.map(({ method, url }) => `${method} ${url}`),
      [
        `GET ${BASE}/journeys`,
        `GET ${BASE}/journeys/Product%20Workflows`,
        `POST ${BASE}/journeys`,
        `PATCH ${BASE}/journeys/docs`,
        `DELETE ${BASE}/journeys/docs`,
      ],
    );
    assert.deepEqual(requests[2].body, {
      name: "Docs",
      description: "Read the docs.",
    });
    assert.deepEqual(requests[3].body, { description: null });
  });

  it("rejects an empty or conflicting journey edit", async (t) => {
    useApi(t, {});
    assert.match(await usageError(["eval", "journey", "edit", "docs"]), /nothing/);
    assert.match(
      await usageError([
        "eval",
        "journey",
        "edit",
        "docs",
        "--description",
        "x",
        "--clear-description",
      ]),
      /conflict/,
    );
  });

  it("places, moves, and filters evals by journey", async (t) => {
    const requests = useApi(t, { id: "e1", tags: [], items: [] });
    await gauge([
      "eval",
      "create",
      "--name",
      "Install",
      "--text",
      "Install the CLI.",
      "--criterion",
      "Works: The CLI runs.",
      "--agent",
      "claude-code",
      "--journey",
      "onboarding",
    ]);
    await gauge(["eval", "edit", "e1", "--journey", "Implementation"]);
    await gauge(["eval", "edit", "e1", "--clear-journey"]);
    await gauge(["eval", "list", "--journey", "none"]);
    assert.equal((requests[0].body as { journey?: string }).journey, "onboarding");
    assert.deepEqual(requests[1].body, { journey: "Implementation" });
    assert.deepEqual(requests[2].body, { journey: null });
    assert.equal(requests[3].url, `${BASE}/eval-sets?journey=none`);
  });

  it("refuses journey flags that conflict or target local evals", async (t) => {
    useApi(t, {});
    assert.match(
      await usageError([
        "eval",
        "edit",
        "e1",
        "--journey",
        "onboarding",
        "--clear-journey",
      ]),
      /conflict/,
    );
    assert.match(
      await usageError(["eval", "list", "--journey", "none"], "--local"),
      /hosted/,
    );
  });
});
