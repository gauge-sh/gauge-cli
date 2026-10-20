import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { optimizations } from "@withgauge/api-schemas";
import { Command } from "commander";
import {
  awaitingInput,
  parseStatuses,
  parseSubject,
  parseTarget,
  register,
  trialBodyFromOpts,
  trialTemplate,
  trialWarnings,
  watchStops,
} from "./optimizations";

describe("parseSubject", () => {
  it("refuses none or both", () => {
    assert.throws(() => parseSubject({}), /--eval <id> or --preference/);
    assert.throws(
      () => parseSubject({ eval: "a", preference: "b" }),
      /not both/,
    );
  });
});

describe("parseTarget", () => {
  it("pins one agent and at most one model", () => {
    assert.deepEqual(parseTarget("claude-code"), { agent: "CLAUDE_CODE" });
    assert.deepEqual(parseTarget("codex:gpt-5"), {
      agent: "CODEX_CLI",
      model: "gpt-5",
    });
    assert.throws(() => parseTarget("claude-code:a,b"), /exactly one/);
  });
});

describe("parseStatuses", () => {
  it("normalizes and validates the csv", () => {
    assert.equal(parseStatuses(" active, done "), "ACTIVE,DONE");
    assert.throws(() => parseStatuses("RUNNING"), /unknown status/);
  });
});

it("watch waits only while the server says nobody is needed", () => {
  const detail = (nextAction: optimizations.OptimizationNextAction) =>
    ({ nextAction }) as Pick<optimizations.OptimizationDetail, "nextAction">;
  assert.equal(awaitingInput(detail("AUTHOR_TRIAL")), true);
  assert.equal(awaitingInput(detail("WAIT")), false);
  assert.equal(awaitingInput(detail("NONE")), false);
});

it("rejects null and empty authored trial files with a usage error", () => {
  for (const json of ["null", "[]", "[null]"])
    assert.throws(
      () => trialBodyFromOpts({ file: "trial.json" }, () => json),
      /object|holds/,
    );
});

const FIXTURES = mkdtempSync(join(tmpdir(), "gauge-optimizations-"));
const CHANGE_FILE = join(FIXTURES, "change.json");
const ROUND_FILE = join(FIXTURES, "round.json");
writeFileSync(
  CHANGE_FILE,
  JSON.stringify({
    schemaVersion: 3,
    target: { kind: "npmBin", packageName: "@owned/cli", program: "owned" },
    rules: [],
    shippingIntent: "message",
  }),
);
writeFileSync(ROUND_FILE, JSON.stringify({ revision: "rev", trials: [] }));

describe("optimization command requests", () => {
  for (const [args, method, suffix, body] of [
    [
      ["create", "--eval", "eval", "--target", "claude-code"],
      "POST",
      "/drafts",
      {
        subjectKind: "EVAL_SET",
        subjectId: "eval",
        target: { agent: "CLAUDE_CODE" },
      },
    ],
    [
      ["complete", "climb", "--adopt", "R1.1", "--yes"],
      "POST",
      "/climb/complete",
      { adoptTrialId: "R1.1" },
    ],
    [["continue", "climb", "--yes"], "POST", "/climb/continue", {}],
    [["rm", "climb", "--yes"], "DELETE", "/climb", undefined],
    [["authoring", "climb"], "GET", "/climb/authoring", undefined],
    [["handoff", "climb"], "GET", "/climb/handoff", undefined],
    [
      ["baselines", "--eval", "eval", "--limit", "10", "--cursor", "run"],
      "GET",
      "/baselines?subjectKind=EVAL_SET&subjectId=eval&limit=10&cursor=run",
      undefined,
    ],
    [
      ["start", "--eval", "eval", "--from-run", "run", "--yes"],
      "POST",
      "",
      { subjectKind: "EVAL_SET", subjectId: "eval", fromRun: "run" },
    ],
    [
      ["cli-change", "climb", "--file", CHANGE_FILE],
      "POST",
      "/climb/cli-changes",
      {
        schemaVersion: 3,
        target: { kind: "npmBin", packageName: "@owned/cli", program: "owned" },
        rules: [],
        shippingIntent: "message",
      },
    ],
    [
      ["round", "preview", "climb", "--file", ROUND_FILE],
      "POST",
      "/climb/rounds/current/preview",
      { revision: "rev", trials: [] },
    ],
    [
      ["round", "save", "climb", "--file", ROUND_FILE, "--digest", "d1"],
      "PUT",
      "/climb/rounds/current",
      { revision: "rev", trials: [], previewDigest: "d1" },
    ],
    [
      ["trials", "rm", "climb", "R1.1", "--yes"],
      "DELETE",
      "/climb/trials/R1.1",
      undefined,
    ],
  ] as const) {
    it(`${args[0]} maps to the correct API request`, async (t) => {
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
          return method === "DELETE"
            ? new Response(null, { status: 204 })
            : Response.json({
                items: [],
                launched: [],
                chatId: "chat",
                href: "/org/chat/chat",
              });
        },
      );
      const command = new Command()
        .option("--hosted", "use hosted", true)
        .option("--org <org>")
        .option("-o, --output <output>");
      register(command);
      await command.parseAsync(
        ["--org", "org", "-o", "json", "optimizations", ...args],
        { from: "user" },
      );
      assert.deepEqual(requests, [
        {
          url: `https://test.invalid/api/v1/orgs/org/optimizations${suffix}`,
          method,
          body,
        },
      ]);
    });
  }
});

for (const draft of [false, true]) {
  it(`${draft ? "start-draft" : "start"} sends no round or budget plan`, async (t) => {
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
    const requests: {
      url: string;
      method: string;
      body?: Record<string, unknown>;
    }[] = [];
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
        if (!init?.method || init.method === "GET")
          return Response.json({
            status: "DRAFT",
            settings: { pinnedAgent: "CLAUDE_CODE", pinnedModel: null },
          });
        return Response.json({ id: "climb" });
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
        "org",
        "-o",
        "json",
        "optimizations",
        ...(draft
          ? ["start-draft", "climb"]
          : ["start", "--eval", "eval", "--target", "claude-code"]),
        "--yes",
      ],
      { from: "user" },
    );
    assert.equal(
      requests.some((request) => request.url.endsWith("/estimate")),
      false,
    );
    const launch = requests.at(-1)!;
    assert.equal(
      launch.url,
      `https://test.invalid/api/v1/orgs/org/optimizations${draft ? "/climb/start" : ""}`,
    );
    assert.deepEqual(
      launch.body,
      draft
        ? {}
        : {
            subjectKind: "EVAL_SET",
            subjectId: "eval",
            target: { agent: "CLAUDE_CODE" },
          },
    );
  });
}

it("start rejects the retired plan flags", async () => {
  const command = new Command()
    .option("--hosted", "use hosted", true)
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .option("--org <org>");
  register(command);
  for (const flag of ["--rounds", "--effort", "--credit-cap"])
    await assert.rejects(
      command.parseAsync(
        [
          "optimizations",
          "start",
          "--eval",
          "e",
          "--target",
          "claude-code",
          flag,
          "1",
        ],
        { from: "user" },
      ),
      /unknown option/,
    );
});

it("warns loudly when a trial has errored sessions", () => {
  const run = (
    status: string,
    extra: Partial<optimizations.TrialRun> = {},
  ): optimizations.TrialRun => ({
    id: `run_${status}`,
    status,
    failureReason: null,
    exitReason: null,
    passed: null,
    criteria: [],
    levers: [],
    ...extra,
  });
  const trial = (runs: optimizations.TrialRun[]) =>
    ({ key: "R1.1", runs }) as optimizations.Trial;
  assert.deepEqual(trialWarnings(trial([run("SUCCEEDED")])), []);
  const lines = trialWarnings(
    trial([
      run("SUCCEEDED"),
      run("FAILED", { failureReason: "sandbox setup failed" }),
      run("TIMED_OUT"),
    ]),
  );
  assert.match(lines[0], /^WARNING R1\.1: 2 of 3 sessions failed/);
  assert.match(lines[1], /run_FAILED: FAILED: sandbox setup failed/);
  assert.match(lines[1], /gauge run get run_FAILED/);
  assert.match(lines[2], /TIMED_OUT: no reason recorded/);
  assert.equal(lines.length, 3);
  const unproven = trialWarnings(
    trial([
      run("SUCCEEDED", {
        cliCoverage: {
          instrumentationFailed: true,
        } as optimizations.TrialRun["cliCoverage"],
      }),
    ]),
  );
  assert.match(
    unproven[0],
    /1 of 1 session have incomplete command evidence; the score counts them/,
  );
  assert.doesNotMatch(unproven.join("\n"), /leave them out/);
});

describe("trialBodyFromOpts", () => {
  it("builds a REWRITE_DOCS trial from a page and body file", () => {
    const body = trialBodyFromOpts(
      {
        title: "Lead with install",
        page: "https://docs.acme.dev/start",
        bodyFile: "page.md",
        launch: false,
      },
      () => "# Start\n",
    );
    assert.equal(body.launch, false);
    assert.equal(body.trial.lever, "DOCS");
    assert.deepEqual(body.trial.intervention, {
      kind: "REWRITE_DOCS",
      after: {
        pages: [{ url: "https://docs.acme.dev/start", body: "# Start\n" }],
      },
    });
  });
  it("takes a proposal file verbatim", () => {
    const proposal = {
      trial: {
        title: "t",
        lever: "SKILL",
        intervention: {
          kind: "EDIT_SKILL",
          before: { skillVersionId: "sv_1" },
          after: { skillVersionId: "sv_1" },
        },
      },
      files: [{ path: "SKILL.md", body: "x" }],
    };
    const body = trialBodyFromOpts({ file: "p.json" }, () =>
      JSON.stringify(proposal),
    );
    assert.deepEqual(body.trial, proposal.trial);
    assert.deepEqual(body.files, proposal.files);
  });
  it("picks one trial out of an array of them", () => {
    const proposals = [
      { trial: { title: "first" } },
      { trial: { title: "second" } },
    ];
    const read = () => JSON.stringify(proposals);
    assert.equal(
      trialBodyFromOpts({ file: "p.json" }, read).trial.title,
      "first",
    );
    assert.equal(
      trialBodyFromOpts({ file: "p.json", pick: "2" }, read).trial.title,
      "second",
    );
    assert.throws(
      () => trialBodyFromOpts({ file: "p.json", pick: "3" }, read),
      /holds 2 proposals/,
    );
    assert.throws(
      () =>
        trialBodyFromOpts({ file: "p.json", pick: "1" }, () =>
          JSON.stringify(proposals[0]),
        ),
      /applies to a proposals array/,
    );
  });

  it("builds an EDIT_SKILL trial from a local directory", () => {
    const body = trialBodyFromOpts(
      {
        title: "Name the env var first",
        editSkill: "sv_1",
        skillDir: "/tmp/skill",
      },
      (path) => `body of ${path}`,
      () => ["/tmp/skill/reference/api.md", "/tmp/skill/SKILL.md"],
    );
    assert.deepEqual(body.trial.intervention, {
      kind: "EDIT_SKILL",
      before: { skillVersionId: "sv_1" },
      after: { skillVersionId: "sv_1" },
    });
    assert.deepEqual(body.files, [
      { path: "SKILL.md", body: "body of /tmp/skill/SKILL.md" },
      {
        path: "reference/api.md",
        body: "body of /tmp/skill/reference/api.md",
      },
    ]);
  });

  it("refuses a bundle with no SKILL.md and an edit with no directory", () => {
    assert.throws(
      () =>
        trialBodyFromOpts(
          { title: "t", editSkill: "sv_1", skillDir: "/tmp/skill" },
          () => "x",
          () => ["/tmp/skill/README.md"],
        ),
      /SKILL\.md/,
    );
    assert.throws(
      () => trialBodyFromOpts({ title: "t", editSkill: "sv_1" }),
      /--skill-dir/,
    );
  });

  it("carries an idempotency key through both authoring paths", () => {
    assert.equal(
      trialBodyFromOpts(
        {
          title: "t",
          page: "https://docs.acme.dev",
          bodyFile: "p.md",
          idempotencyKey: "k1",
        },
        () => "x",
      ).idempotencyKey,
      "k1",
    );
    assert.equal(
      trialBodyFromOpts({ file: "p.json", idempotencyKey: "k2" }, () =>
        JSON.stringify({ trial: { title: "t" } }),
      ).idempotencyKey,
      "k2",
    );
  });

  it("prints a fillable template per change kind", () => {
    assert.equal(
      trialTemplate("edit_skill").trial.intervention.kind,
      "EDIT_SKILL",
    );
    assert.ok(trialTemplate("EDIT_SKILL").files?.length);
    assert.throws(() => trialTemplate("NOPE"), /--kind must be one of/);
    assert.throws(() => trialTemplate("ADD_SKILL"), /--kind must be one of/);
  });

  it("demands a change and a title", () => {
    assert.throws(() => trialBodyFromOpts({ editSkill: "sv" }), /--title/);
    assert.throws(
      () => trialBodyFromOpts({ title: "t" }),
      /describe the change/,
    );
  });
});

it("watch exits on a blocked climb instead of polling forever", () => {
  const blocked = { status: "ACTIVE", nextAction: "NONE" } as const;
  assert.equal(watchStops(blocked, false), true);
  assert.equal(watchStops(blocked, true), true);
  assert.equal(
    watchStops({ status: "ACTIVE", nextAction: "WAIT" }, false),
    false,
  );
  assert.equal(
    watchStops({ status: "ACTIVE", nextAction: "AUTHOR_TRIAL" }, true),
    false,
  );
});

it("requires exactly one starting source before making a request", async () => {
  for (const flags of [[], ["--from-run", "run", "--target", "claude-code"]]) {
    const program = new Command()
      .option("--hosted", "use hosted", true)
      .option("--org <org>", "organization", "org");
    register(program);
    await assert.rejects(
      program.parseAsync(
        ["optimizations", "start", "--eval", "eval", ...flags],
        { from: "user" },
      ),
      /pass --from-run/,
    );
  }
});
