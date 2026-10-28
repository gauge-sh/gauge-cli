import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Command } from "commander";
import {
  fileEditFromOpts,
  fileSourceFromOpts,
  latestLaunch,
  launchSettled,
  parseEdits,
  parseStatus,
  parseSubjectRef,
  register,
} from "./optimizations";

describe("parseSubjectRef", () => {
  it("takes exactly one subject", () => {
    assert.deepEqual(parseSubjectRef({ issue: "i1" }), {
      kind: "issue",
      issueId: "i1",
    });
    assert.deepEqual(parseSubjectRef({ finding: "o1", run: "r1" }), {
      kind: "finding",
      observationId: "o1",
      runId: "r1",
    });
    assert.deepEqual(parseSubjectRef({ goal: "Cut setup time" }), {
      kind: "free",
      text: "Cut setup time",
    });
    assert.throws(() => parseSubjectRef({}), /one of --issue/);
    assert.throws(
      () => parseSubjectRef({ issue: "i1", goal: "x" }),
      /one of --issue/,
    );
    assert.throws(() => parseSubjectRef({ finding: "o1" }), /needs --run/);
    assert.throws(
      () => parseSubjectRef({ issue: "i1", run: "r1" }),
      /--run only applies with --finding/,
    );
  });
});

describe("latestLaunch", () => {
  it("picks the highest number in any order", () => {
    assert.equal(
      latestLaunch([{ number: 3 }, { number: 1 }, { number: 2 }])?.number,
      3,
    );
    assert.equal(latestLaunch([]), undefined);
  });
});

describe("parseStatus", () => {
  it("normalizes and validates", () => {
    assert.equal(parseStatus(" open "), "OPEN");
    assert.equal(parseStatus(undefined), undefined);
    assert.throws(() => parseStatus("ACTIVE"), /unknown status/);
  });
});

describe("fileEditFromOpts", () => {
  const read = (path: string) => `body of ${path}`;

  it("builds a page, skill, or CLI edit", () => {
    assert.deepEqual(
      fileEditFromOpts({ page: "https://x.dev/docs", from: "p.md" }, read),
      { kind: "page", url: "https://x.dev/docs", body: "body of p.md" },
    );
    assert.deepEqual(
      fileEditFromOpts(
        { skill: "setup", path: "SKILL.md", from: "s.md" },
        read,
      ),
      { kind: "skill", name: "setup", path: "SKILL.md", body: "body of s.md" },
    );
    assert.deepEqual(
      fileEditFromOpts({ skill: "setup", path: "old.md", delete: true }, read),
      { kind: "skill", name: "setup", path: "old.md", body: null },
    );
    assert.deepEqual(
      fileEditFromOpts({ cli: "@owned/cli", from: "r.json" }, () => '{"a":1}'),
      { kind: "cli", package: "@owned/cli", rules: { a: 1 } },
    );
  });

  it("refuses ambiguous or incomplete edits", () => {
    assert.throws(() => fileEditFromOpts({ from: "x" }, read), /one of --page/);
    assert.throws(
      () => fileEditFromOpts({ page: "https://x.dev", skill: "s" }, read),
      /one of --page/,
    );
    assert.throws(
      () => fileEditFromOpts({ page: "https://x.dev" }, read),
      /--from <file> is required/,
    );
    assert.throws(
      () => fileEditFromOpts({ skill: "s", from: "x" }, read),
      /needs --path/,
    );
    assert.throws(
      () => fileEditFromOpts({ page: "https://x.dev", delete: true }, read),
      /--delete removes one path from a skill/,
    );
    assert.throws(
      () => fileEditFromOpts({ cli: "c", from: "x" }, () => "not json"),
      /CLI rules as JSON/,
    );
    assert.throws(
      () =>
        fileEditFromOpts({ page: "https://x.dev", path: "p", from: "x" }, read),
      /--path only applies with --skill/,
    );
    assert.throws(
      () =>
        fileEditFromOpts(
          { skill: "s", path: "p", contentType: "text/html", from: "x" },
          read,
        ),
      /--content-type only applies with --page/,
    );
    assert.throws(
      () =>
        fileEditFromOpts(
          { skill: "s", path: "p", delete: true, from: "x" },
          read,
        ),
      /--delete or --from/,
    );
  });
});

describe("parseEdits", () => {
  it("keeps find/replace pairs and refuses anything else", () => {
    assert.deepEqual(parseEdits([{ find: "a", replace: "b", extra: 1 }]), [
      { find: "a", replace: "b" },
    ]);
    for (const bad of [[], [{ find: "", replace: "b" }], [{ find: "a" }], {}])
      assert.throws(() => parseEdits(bad), /JSON array of \{find, replace\}/);
  });
});

describe("fileSourceFromOpts", () => {
  it("takes exactly one source", () => {
    assert.deepEqual(fileSourceFromOpts({ cli: true }), { kind: "cli" });
    assert.throws(() => fileSourceFromOpts({}), /one of --page/);
    assert.throws(
      () => fileSourceFromOpts({ page: "https://x.dev", skill: "s" }),
      /one of --page/,
    );
  });
});

describe("launchSettled", () => {
  const run = (status: string, analyzed: boolean) => ({
    id: "r",
    status,
    agent: "CLAUDE_CODE",
    model: "m",
    title: "t",
    sourceRunId: "s",
    analyzed,
    startedAt: null,
  });

  it("waits for every rerun to finish and each success to be analyzed", () => {
    assert.equal(launchSettled({ runs: [run("RUNNING", false)] }), false);
    assert.equal(launchSettled({ runs: [run("SUCCEEDED", false)] }), false);
    assert.equal(
      launchSettled({
        runs: [run("SUCCEEDED", true), run("FAILED", false)],
      }),
      true,
    );
  });
});

const FIXTURES = mkdtempSync(join(tmpdir(), "gauge-optimizations-"));
const PAGE_FILE = join(FIXTURES, "page.md");
const RESULT_FILE = join(FIXTURES, "result.json");
const EDITS_FILE = join(FIXTURES, "edits.json");
const RESULT = {
  summary: "Moved the auth step first",
  changed: ["page:https://x.dev/docs"],
  resolved: [],
  returned: [],
  introduced: [],
};
writeFileSync(PAGE_FILE, "# Docs");
writeFileSync(RESULT_FILE, JSON.stringify(RESULT));
writeFileSync(EDITS_FILE, JSON.stringify([{ find: "old", replace: "new" }]));

describe("optimization command requests", () => {
  for (const [args, method, suffix, body] of [
    [["list", "--status", "open"], "GET", "?status=OPEN", undefined],
    [
      ["create", "--issue", "i1", "--title", "Auth"],
      "POST",
      "",
      { subject: { kind: "issue", issueId: "i1" }, title: "Auth" },
    ],
    [["get", "o1"], "GET", "/o1", undefined],
    [["authoring", "o1"], "GET", "/o1/authoring", undefined],
    [
      ["file", "read", "o1", "skill:setup"],
      "GET",
      "/o1/files?key=skill%3Asetup",
      undefined,
    ],
    [
      ["file", "read", "o1", "page:https://x.dev/docs", "--query", "auth"],
      "GET",
      "/o1/files?key=page%3Ahttps%3A%2F%2Fx.dev%2Fdocs&query=auth",
      undefined,
    ],
    [
      [
        "file",
        "edit",
        "o1",
        "--page",
        "https://x.dev/docs",
        "--edits",
        EDITS_FILE,
      ],
      "PATCH",
      "/o1/files",
      { url: "https://x.dev/docs", edits: [{ find: "old", replace: "new" }] },
    ],
    [
      ["file", "add", "o1", "--page", "https://x.dev/docs"],
      "POST",
      "/o1/files",
      { kind: "page", url: "https://x.dev/docs" },
    ],
    [
      [
        "file",
        "write",
        "o1",
        "--page",
        "https://x.dev/docs",
        "--from",
        PAGE_FILE,
      ],
      "PUT",
      "/o1/files",
      { kind: "page", url: "https://x.dev/docs", body: "# Docs" },
    ],
    [
      ["file", "rm", "o1", "cli:@owned/cli"],
      "DELETE",
      "/o1/files?key=cli%3A%40owned%2Fcli",
      undefined,
    ],
    [["notes", "o1", "--from", PAGE_FILE], "PATCH", "/o1", { notes: "# Docs" }],
    [
      ["launch", "o1", "--run", "r1", "r2", "--note", "auth first", "--yes"],
      "POST",
      "/o1/launch",
      { runIds: ["r1", "r2"], note: "auth first" },
    ],
    [["launches", "o1", "l1"], "GET", "/o1/launches/l1", undefined],
    [
      ["finish", "o1", "--from", RESULT_FILE, "--yes"],
      "POST",
      "/o1/finish",
      RESULT,
    ],
  ] as const) {
    it(`${args.slice(0, 3).join(" ")} maps to the correct API request`, async (t) => {
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
      const requests: { url: string; method: string; body: unknown }[] = [];
      t.mock.method(console, "log", () => {});
      t.mock.method(
        globalThis,
        "fetch",
        async (url: string | URL | Request, init?: RequestInit) => {
          requests.push({
            url: String(url),
            method: init?.method ?? "GET",
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
          });
          return Response.json({ items: [], launchList: [], batches: [] });
        },
      );
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
          "optimizations",
          ...args,
        ],
        { from: "user" },
      );
      assert.deepEqual(requests, [
        {
          url: `https://test.invalid/api/v1/orgs/8c7f0e1a-1111-4222-8333-944455556666/optimizations${suffix}`,
          method,
          body,
        },
      ]);
    });
  }
});
