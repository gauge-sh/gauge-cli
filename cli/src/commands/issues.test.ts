import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Command } from "commander";
import { flattenBlocks, impactLine, register, statusLine } from "./issues";

const OPEN = {
  status: "OPEN",
  statusAt: null,
  statusBy: null,
  cameBackAt: null,
  check: null,
} as const;

describe("statusLine", () => {
  it("says how an issue was closed, and why an open one matters", () => {
    assert.equal(statusLine(OPEN), "open");
    assert.equal(
      statusLine({ ...OPEN, status: "FIXED", statusBy: "Ada" }),
      "fixed by Ada",
    );
    assert.equal(
      statusLine({
        ...OPEN,
        check: { status: "VERIFIED", sessions: 3, seen: 0, createdAt: "t" },
      }),
      "open, looks fixed: 0 of 3 runs on the last recheck",
    );
    assert.equal(
      statusLine({
        ...OPEN,
        statusAt: "u",
        check: { status: "VERIFIED", sessions: 3, seen: 0, createdAt: "t" },
      }),
      "open",
    );
    assert.equal(statusLine({ ...OPEN, status: "MUTED" }), "muted");
    assert.equal(
      statusLine({ ...OPEN, cameBackAt: "2026-11-01T00:00:00Z" }),
      "open, came back after a fix",
    );
    assert.equal(
      statusLine({
        ...OPEN,
        cameBackAt: "2026-11-01T00:00:00Z",
        check: {
          status: "VERIFIED",
          sessions: 3,
          seen: 0,
          createdAt: "2026-11-02T00:00:00Z",
        },
      }),
      "open, looks fixed: 0 of 3 runs on the last recheck",
    );
  });
});

describe("issue status commands", () => {
  for (const [args, method, suffix, body] of [
    [["fix", "is_1"], "PATCH", "/is_1", { status: "FIXED" }],
    [["mute", "is_1"], "PATCH", "/is_1", { status: "MUTED" }],
    [["reopen", "is_1"], "PATCH", "/is_1", { status: "OPEN" }],
    [["recheck", "is_1"], "GET", "/is_1/recheck", undefined],
    [["recheck", "is_1", "--confirm"], "POST", "/is_1/recheck", {}],
    [["verify", "is_1", "--confirm"], "POST", "/is_1/recheck", {}],
    [
      ["recheck", "is_1", "--run", "run_a", "run_b", "--confirm"],
      "POST",
      "/is_1/recheck",
      { runIds: ["run_a", "run_b"] },
    ],
  ] as const) {
    it(`${args.join(" ")} sends ${method} ${suffix}`, async (t) => {
      const previous = {
        token: process.env.GAUGE_API_TOKEN,
        url: process.env.GAUGE_API_URL,
      };
      process.env.GAUGE_API_TOKEN = "gauge_test";
      process.env.GAUGE_API_URL = "https://test.invalid";
      t.after(() => {
        if (previous.token === undefined) delete process.env.GAUGE_API_TOKEN;
        else process.env.GAUGE_API_TOKEN = previous.token;
        if (previous.url === undefined) delete process.env.GAUGE_API_URL;
        else process.env.GAUGE_API_URL = previous.url;
      });
      const calls: { url: string; method?: string; body?: unknown }[] = [];
      t.mock.method(console, "log", () => {});
      t.mock.method(
        globalThis,
        "fetch",
        async (url: string | URL | Request, init?: RequestInit) => {
          calls.push({
            url: String(url),
            method: init?.method,
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
          });
          return Response.json({
            id: "is_1",
            status: "FIXED",
            runIds: [],
            runs: [],
          });
        },
      );
      const command = new Command()
        .option("--hosted", "use hosted", true)
        .option("--org <org>")
        .option("-o, --output <output>");
      register(command);
      await command.parseAsync(
        ["--org", "8c7f0e1a-1111-4222-8333-944455556666", "issues", ...args],
        { from: "user" },
      );
      assert.deepEqual(calls, [
        {
          url: `https://test.invalid/api/v1/orgs/8c7f0e1a-1111-4222-8333-944455556666/issues${suffix}`,
          method,
          body,
        },
      ]);
    });
  }
});

describe("impactLine", () => {
  it("shows effects for problems and destinations for reasons", () => {
    assert.equal(
      impactLine({
        impact: [
          { effect: "BLOCKED", sessions: 3 },
          { effect: "EXTRA_WORK", sessions: 2 },
        ],
        wentTo: [],
      }),
      "blocked 3, extra work 2",
    );
    assert.equal(
      impactLine({ impact: null, wentTo: [{ name: "Neon", sessions: 4 }] }),
      "Neon 4",
    );
  });
});

describe("flattenBlocks", () => {
  it("tags each issue with its type and product and sums ungrouped findings", () => {
    const issue = {
      id: "is_1",
      title: "Docs lack install command",
      description: "",
      sessions: 5,
      wentTo: [],
      impact: [{ effect: "EXTRA_WORK", sessions: 5 }],
      issue: OPEN,
    };
    const block = {
      kind: "FRICTION",
      headline: "",
      sessions: 5,
      total: 5,
      ungrouped: 2,
    };
    assert.deepEqual(
      flattenBlocks("friction", [
        { ...block, product: "Acme", issues: [issue] },
        { ...block, product: "Other", issues: [], ungrouped: 1 },
      ]),
      {
        issues: [{ ...issue, type: "friction", product: "Acme" }],
        ungrouped: 3,
      },
    );
  });
});

describe("issues command requests", () => {
  for (const [args, suffixes] of [
    [["list"], ["?kind=problems&status=open", "?kind=reasons&status=open"]],
    [["list", "--type", "friction"], ["?kind=problems&status=open"]],
    [["list", "--type", "objection"], ["?kind=reasons&status=open"]],
    [["list", "--type", "friction", "--status", "all"], ["?kind=problems&status=all"]],
    [["get", "is_1"], ["/is_1"]],
  ] as const) {
    it(`${args.join(" ")} maps to the correct API request`, async (t) => {
      const previous = {
        token: process.env.GAUGE_API_TOKEN,
        url: process.env.GAUGE_API_URL,
      };
      process.env.GAUGE_API_TOKEN = "gauge_test";
      process.env.GAUGE_API_URL = "https://test.invalid";
      t.after(() => {
        if (previous.token === undefined) delete process.env.GAUGE_API_TOKEN;
        else process.env.GAUGE_API_TOKEN = previous.token;
        if (previous.url === undefined) delete process.env.GAUGE_API_URL;
        else process.env.GAUGE_API_URL = previous.url;
      });
      const urls: string[] = [];
      t.mock.method(console, "log", () => {});
      t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
        urls.push(String(url));
        return Response.json({ blocks: [], instances: [] });
      });
      const command = new Command()
        .option("--hosted", "use hosted", true)
        .option("--org <org>")
        .option("-o, --output <output>");
      register(command);
      await command.parseAsync(
        [
          "--org",
          "8c7f0e1a-1111-4222-8333-944455556666",
          "-o",
          "json",
          "issues",
          ...args,
        ],
        { from: "user" },
      );
      assert.deepEqual(
        urls.sort(),
        suffixes.map(
          (suffix) =>
            `https://test.invalid/api/v1/orgs/8c7f0e1a-1111-4222-8333-944455556666/issues${suffix}`,
        ),
      );
    });
  }
});
