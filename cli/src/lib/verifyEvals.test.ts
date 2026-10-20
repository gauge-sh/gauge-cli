import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { Command } from "commander";
import { register } from "../commands/run";
import {
  type EvalVerification,
  printEvalVerification,
  verifyEvals,
} from "./verifyEvals";

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gauge-verify-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path: string, value: string | object) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(
      join(root, path),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  return { root, write, git };
}
const npm = {
  type: "npm-package",
  source: {
    type: "github-actions",
    workflow: ".github/workflows/build.yml",
    artifact: "candidate",
  },
  path: "*.tgz",
};
const workflow = (
  archive = "true",
  ref = `\${{ github.event.pull_request.head.sha || github.sha }}`,
  upload = "v7",
) => `
on: [pull_request, push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          ref: ${ref}
      - run: npm pack
      - uses: actions/upload-artifact@${upload}
        with:
          name: candidate
          path: '*.tgz'
          archive: ${archive}
`;
const markdown = (inputs = "[]") => `---
criteria:
  - name: Works
    rubric: Task completed
config:
  agents:
    - agent: CODEX_CLI
  inputs: ${inputs}
---
Complete the task.
`;
function inputCheck(result: EvalVerification, id: string, name = "cli") {
  return result.inputs
    .find((input) => input.name === name)
    ?.checks.find((check) => check.id === id);
}

test("local verification rejects hosted configuration and explains the MCP handoff", (t) => {
  const f = fixture(t);
  f.write("gauge.json", { version: 2, inputs: {} });
  for (const [field, value] of [
    ["profileId", "persona"],
    ["skillRefs", ["docs@v1"]],
    ["mcpRefs", ["tools@v1"]],
    ["connectionIds", ["connection"]],
    ["addons", { browser: { session: "test", projectId: 1, region: "us" } }],
  ] as const) {
    f.write(
      "gauge-cases/task.md",
      `---
${JSON.stringify({
  config: { agents: [{ agent: "CODEX_CLI" }], [field]: value },
  criteria: [{ name: "Works", rubric: "Completes the task" }],
})}
---
Complete the task.
`,
    );
    const local = verifyEvals(f.root, { local: true });
    assert.equal(local.status, "failed");
    const detail =
      local.global.find((c) => c.id === "case.gauge-cases/task.md")?.detail ?? "";
    assert.match(detail, new RegExp(`config\\.${field} requires hosted Gauge`));
    if (field === "mcpRefs") {
      assert.match(detail, /gauge onboard/);
      assert.match(
        detail,
        /Login and static verification do not establish server reachability or access/,
      );
    }
    const hosted = verifyEvals(f.root);
    assert.equal(hosted.status, "passed");
    assert.ok(hosted.notChecked.includes("mcp-server-access"));
  }
  f.write("gauge-cases/task.md", markdown());
  assert.equal(verifyEvals(f.root, { local: true }).status, "passed");
});

test("setup without cases passes static checks and reports absence as information", (t) => {
  const f = fixture(t);
  f.write("gauge.json", { version: 2, inputs: { cli: npm } });
  f.write(".github/workflows/build.yml", workflow());
  const result = verifyEvals(f.root);
  assert.equal(result.summary.no, 0);
  assert.equal(result.status, "passed");
  assert.equal(result.summary.unknown, 0);
  assert.equal(result.facts.caseCount, 0);
  assert.ok(result.info.some((item) => item.id === "no-cases"));
  assert.equal(
    result.global.find((c) => c.id === "activation"),
    undefined,
  );
  assert.equal(inputCheck(result, "workflow-trigger")?.state, "yes");
  assert.equal(inputCheck(result, "candidate-checkout")?.state, "yes");
  assert.equal(inputCheck(result, "artifact-format.0")?.state, "yes");
  assert.equal(inputCheck(result, "artifact-upload")?.state, "yes");
  assert.equal(inputCheck(result, "artifact-delivery"), undefined);
  assert.equal(inputCheck(result, "consumption"), undefined);
});

test("native command targets must be selected locally without claiming executable compatibility", (t) => {
  const f = fixture(t);
  const binary = {
    type: "binary",
    source: { type: "git" },
    paths: ["dist/**"],
    platform: "linux-x64",
    commands: { gh: "dist/gh" },
  };
  f.write("gauge.json", { inputs: { cli: binary } });
  f.write(
    "dist/gh",
    "format intentionally not inspected by local verification",
  );
  let result = verifyEvals(f.root);
  assert.equal(result.summary.no, 0);
  assert.equal(inputCheck(result, "local-paths")?.state, "yes");
  assert.equal(inputCheck(result, "consumption"), undefined);
  f.write("gauge.json", {
    inputs: { cli: { ...binary, commands: { gh: "elsewhere/gh" } } },
  });
  f.write("elsewhere/gh", "exists but is outside selected paths");
  result = verifyEvals(f.root);
  assert.equal(inputCheck(result, "local-paths")?.state, "no");
  assert.match(
    inputCheck(result, "local-paths")?.detail ?? "",
    /excluded by paths/,
  );
});

test("workflow event declarations are checked without predicting filtered execution", (t) => {
  const f = fixture(t);
  f.write("gauge.json", { inputs: { cli: npm } });
  f.write(
    ".github/workflows/build.yml",
    workflow().replace(
      "on: [pull_request, push]",
      "on:\n  push:\n    paths: ['src/**']",
    ),
  );
  let result = verifyEvals(f.root);
  assert.equal(result.status, "passed");
  assert.equal(inputCheck(result, "workflow-trigger")?.state, "yes");
  assert.match(
    inputCheck(result, "workflow-trigger")?.detail ?? "",
    /filters are present/,
  );
  f.write(
    ".github/workflows/build.yml",
    workflow().replace("on: [pull_request, push]", "on: release"),
  );
  result = verifyEvals(f.root);
  assert.equal(result.status, "failed");
  assert.equal(inputCheck(result, "workflow-trigger")?.state, "no");
  assert.match(
    inputCheck(result, "workflow-trigger")?.detail ?? "",
    /declare push, pull_request, or workflow_dispatch/,
  );
});

test("custom build actions do not obscure a known upload declaration", (t) => {
  const f = fixture(t);
  f.write("gauge.json", { inputs: { cli: npm } });
  f.write(
    ".github/workflows/build.yml",
    workflow().replace("- run: npm pack", "- uses: acme/build@v1"),
  );
  const result = verifyEvals(f.root);
  assert.equal(result.status, "passed");
  assert.equal(inputCheck(result, "artifact-upload")?.state, "yes");
});

test("CI-native input checks declarations without scoring runtime delivery", (t) => {
  const f = fixture(t);
  f.write("gauge.json", {
    inputs: {
      cli: {
        type: "binary",
        source: npm.source,
        paths: ["dist/**"],
        platform: "linux-x64",
        commands: { gh: "dist/gh" },
      },
    },
  });
  f.write(".github/workflows/build.yml", workflow());
  const result = verifyEvals(f.root);
  assert.equal(result.summary.no, 0);
  assert.equal(inputCheck(result, "workflow")?.state, "yes");
  assert.equal(inputCheck(result, "artifact-delivery"), undefined);
  assert.equal(inputCheck(result, "consumption"), undefined);
  f.write("gauge.json", {
    inputs: {
      cli: {
        type: "binary",
        source: npm.source,
        paths: ["dist/**"],
        platform: "linux-x64",
        commands: { gh: "bin/gh" },
      },
    },
  });
  assert.equal(
    inputCheck(verifyEvals(f.root), "command-selection")?.state,
    "no",
  );
});

test("disabled uploads do not fail format checks and opaque conditions remain unknown", (t) => {
  const f = fixture(t);
  f.write("gauge.json", { inputs: { cli: npm } });
  const disabled = `
      - uses: actions/upload-artifact@v7
        if: false
        with:
          name: candidate
          path: '*.tgz'
`;
  f.write(".github/workflows/build.yml", workflow() + disabled);
  assert.equal(verifyEvals(f.root).summary.no, 0);
  f.write(
    ".github/workflows/build.yml",
    workflow() +
      disabled.replace("if: false", `if: \${{ github.event_name == 'push' }}`),
  );
  const result = verifyEvals(f.root);
  assert.equal(result.summary.no, 0);
  assert.equal(inputCheck(result, "artifact-format.1")?.state, "unknown");
  f.write(
    ".github/workflows/build.yml",
    workflow("false").replace("    runs-on:", "    if: false\n    runs-on:"),
  );
  assert.equal(verifyEvals(f.root).summary.no, 0);
});

test("native command collisions fail only when inputs share a case", (t) => {
  const f = fixture(t);
  const binary = {
    type: "binary",
    source: { type: "git" },
    paths: ["dist/**"],
    platform: "linux-x64",
    commands: { gh: "dist/gh" },
  };
  f.write("dist/gh", "binary inspection happens during artifact preparation");
  f.write("gauge.json", { inputs: { first: binary, second: binary } });
  f.write("gauge-cases/first.md", markdown("[first, first]"));
  f.write("gauge-cases/second.md", markdown("[second]"));
  assert.equal(verifyEvals(f.root).summary.no, 0);
  f.write("gauge-cases/first.md", markdown("[first, second]"));
  const result = verifyEvals(f.root);
  assert.equal(
    result.global.find((c) => c.id === "case.gauge-cases/first.md")?.state,
    "no",
  );
  assert.match(
    result.global.find((c) => c.id === "case.gauge-cases/first.md")?.detail ??
      "",
    /both expose command gh/,
  );
  f.write("gauge-cases/first.md", markdown().replace("  inputs: []\n", ""));
  assert.equal(
    verifyEvals(f.root).global.find((c) => c.id === "case.gauge-cases/first.md")
      ?.state,
    "no",
  );
});

test("reads working changes and untracked cases from repository root without origin or HEAD", (t) => {
  const f = fixture(t);
  f.git("init", "-q");
  f.write("gauge.json", { inputs: { cli: npm } });
  f.write(".github/workflows/build.yml", workflow());
  f.git("add", ".");
  f.write(".github/workflows/build.yml", workflow("false"));
  f.write("gauge-cases/new.md", markdown("[missing]"));
  const result = verifyEvals(join(f.root, "gauge-cases"));
  assert.equal(result.root, f.root);
  assert.equal(inputCheck(result, "artifact-format.0")?.state, "no");
  assert.equal(
    result.global.find((c) => c.id === "case.gauge-cases/new.md")?.state,
    "no",
  );
  assert.match(
    result.global.find((c) => c.id === "case.gauge-cases/new.md")?.detail ?? "",
    /Unknown input/,
  );
});

test("returns a structured failure for malformed JSON", (t) => {
  const f = fixture(t);
  f.write("gauge.json", "{not json");
  assert.equal(verifyEvals(f.root).global[0].state, "no");
});

test("invalid inputs have their own checklist and unknown input types fail", (t) => {
  const f = fixture(t);
  f.write("gauge.json", { inputs: { python: { type: "python-package" } } });
  const result = verifyEvals(f.root);
  assert.equal(
    result.global.find((c) => c.id === "configuration")?.state,
    "no",
  );
  assert.equal(inputCheck(result, "configuration", "python")?.state, "no");
});

test("comment previews validate declarations without scoring remote discovery", (t) => {
  const f = fixture(t);
  const website = {
    type: "website",
    url: "https://docs.example.com",
    source: {
      type: "github-pr-comment",
      author: "github-actions[bot]",
      bodyIncludes: "Preview deployment",
      pattern: "(?<sha>[a-f0-9]{40}) (?<url>https://[^ ]+)",
    },
  };
  f.write("gauge.json", { inputs: { website } });
  const result = verifyEvals(f.root);
  assert.equal(result.summary.no, 0);
  assert.equal(inputCheck(result, "configuration", "website")?.state, "yes");
  assert.equal(inputCheck(result, "preview-comment", "website"), undefined);
  assert.equal(result.status, "passed");
  assert.equal(result.summary.unknown, 0);
  f.write("gauge.json", {
    inputs: {
      website: {
        ...website,
        source: { ...website.source, pattern: "https://.*" },
      },
    },
  });
  assert.equal(
    inputCheck(verifyEvals(f.root), "configuration", "website")?.state,
    "no",
  );
});

test("Git files, Skill directories, and website inputs use supported schemas", (t) => {
  const f = fixture(t);
  f.write("gauge.json", {
    inputs: {
      docs: { type: "files", source: { type: "git" }, paths: ["docs/**/*.md"] },
      skill: { type: "skill", source: { type: "git" }, path: "skill" },
      website: {
        type: "website",
        source: { type: "github-deployment", environment: "preview" },
        url: "https://docs.example.com",
      },
    },
  });
  f.write("docs/a.md", "docs");
  f.write("skill/SKILL.md", "skill");
  f.write("gauge-cases/a.md", markdown("[docs, skill, website]"));
  const result = verifyEvals(f.root);
  assert.equal(result.summary.no, 0);
  assert.equal(inputCheck(result, "local-paths", "docs")?.state, "yes");
  assert.equal(inputCheck(result, "local-paths", "skill")?.state, "yes");
  assert.equal(inputCheck(result, "deployment", "website"), undefined);
});

test("missing Git selection, missing SKILL.md, and multiple npm packages fail locally", (t) => {
  const f = fixture(t);
  f.write("gauge.json", {
    inputs: {
      docs: { type: "files", source: { type: "git" }, paths: ["missing/**"] },
      skill: { type: "skill", source: { type: "git" }, path: "skill" },
      cli: { ...npm, source: { type: "git" } },
    },
  });
  f.write("skill/README.md", "not a skill");
  f.write("a.tgz", "a");
  f.write("b.tgz", "b");
  const result = verifyEvals(f.root);
  for (const name of ["docs", "skill", "cli"])
    assert.equal(inputCheck(result, "local-paths", name)?.state, "no");
});

test("local inputs read git-ignored files from disk and skip workflow checks", (t) => {
  const f = fixture(t);
  f.git("init", "-q");
  f.write(".gauge/.gitignore", "*\n");
  f.write(".gauge/cli-1.0.0.tgz", "a");
  f.write(".gauge/skill/SKILL.md", "skill");
  f.write("dist/.gitignore", "*\n");
  f.write("dist/tool", "bin");
  f.write("gauge.json", {
    inputs: {
      cli: { ...npm, source: { type: "git" }, path: ".gauge/*.tgz" },
      skill: { type: "skill", source: { type: "git" }, path: ".gauge/skill" },
      docs: { type: "files", source: { type: "git" }, paths: ["dist/**"] },
      ci: { ...npm, path: ".gauge/*.tgz" },
    },
  });
  for (const name of ["cli", "skill", "docs"])
    assert.equal(
      inputCheck(verifyEvals(f.root), "local-paths", name)?.state,
      "no",
    );
  const result = verifyEvals(f.root, { local: true });
  for (const name of ["cli", "skill", "docs", "ci"])
    assert.equal(inputCheck(result, "local-paths", name)?.state, "yes");
  assert.equal(inputCheck(result, "workflow", "ci"), undefined);
  assert.equal(result.summary.no, 0);
});

test("missing workflow and malformed workflow YAML fail with actionable checks", (t) => {
  const f = fixture(t);
  f.write("gauge.json", { inputs: { cli: npm } });
  assert.equal(inputCheck(verifyEvals(f.root), "workflow")?.state, "no");
  f.write(".github/workflows/build.yml", "jobs: [unterminated");
  assert.equal(inputCheck(verifyEvals(f.root), "workflow")?.state, "no");
});

test("reusable workflows and expression-based uploads stay unknown", (t) => {
  const f = fixture(t);
  f.write("gauge.json", { inputs: { cli: npm } });
  f.write(
    ".github/workflows/build.yml",
    "on: push\njobs:\n  build:\n    uses: acme/workflows/.github/workflows/build.yml@main\n",
  );
  let result = verifyEvals(f.root);
  assert.equal(result.summary.no, 0);
  assert.equal(inputCheck(result, "artifact-upload")?.state, "unknown");
  assert.equal(inputCheck(result, "candidate-checkout")?.state, "unknown");
  f.write(
    ".github/workflows/build.yml",
    workflow(`\${{ inputs.archive }}`, `\${{ inputs.ref }}`).replace(
      "name: candidate",
      `name: \${{ matrix.artifact }}`,
    ),
  );
  result = verifyEvals(f.root);
  assert.equal(result.summary.no, 0);
  assert.equal(inputCheck(result, "artifact-format.0")?.state, "unknown");
  assert.equal(inputCheck(result, "artifact-upload")?.state, "unknown");
});

test("default PR merge checkout is supported without claiming to verify build contents", (t) => {
  const f = fixture(t);
  f.write("gauge.json", { inputs: { cli: npm } });
  f.write(
    ".github/workflows/build.yml",
    workflow().replace(/ {8}with:\n {10}ref:.*\n/, ""),
  );
  const result = verifyEvals(f.root);
  assert.equal(inputCheck(result, "candidate-checkout")?.state, "yes");
  assert.match(
    inputCheck(result, "candidate-checkout")?.detail ?? "",
    /default PR merge checkout/,
  );
  f.write(
    ".github/workflows/build.yml",
    workflow("true", `\${{ github.sha }}`),
  );
  assert.equal(
    inputCheck(verifyEvals(f.root), "candidate-checkout")?.state,
    "yes",
  );
});

test("v7 missing archive fails, v4 ZIP passes, pinned unknown action versions stay unknown", (t) => {
  const f = fixture(t);
  f.write("gauge.json", { inputs: { cli: npm } });
  f.write(
    ".github/workflows/build.yml",
    workflow().replace("          archive: true\n", ""),
  );
  assert.equal(
    inputCheck(verifyEvals(f.root), "artifact-format.0")?.state,
    "no",
  );
  f.write(".github/workflows/build.yml", workflow("false", undefined, "v4"));
  assert.equal(
    inputCheck(verifyEvals(f.root), "artifact-format.0")?.state,
    "yes",
  );
  f.write(
    ".github/workflows/build.yml",
    workflow("true", undefined, "abcdef123"),
  );
  assert.equal(
    inputCheck(verifyEvals(f.root), "artifact-format.0")?.state,
    "unknown",
  );
});

test("does not follow input symlinks outside the repository", (t) => {
  const f = fixture(t);
  const outside = fixture(t);
  outside.write("secret.md", "secret");
  f.write("gauge.json", {
    inputs: {
      docs: { type: "files", source: { type: "git" }, paths: ["linked.md"] },
    },
  });
  symlinkSync(join(outside.root, "secret.md"), join(f.root, "linked.md"));
  assert.equal(
    inputCheck(verifyEvals(f.root), "local-paths", "docs")?.state,
    "no",
  );
});

test("absent optional config is helpful and malformed cases fail", (t) => {
  const f = fixture(t);
  f.write("gauge-cases/bad.md", "missing frontmatter");
  const result = verifyEvals(f.root);
  assert.equal(result.facts.configFilePresent, false);
  assert.ok(result.info.some((item) => item.id === "config-file-absent"));
  assert.equal(
    result.global.find((c) => c.id === "case.gauge-cases/bad.md")?.state,
    "no",
  );
});

test("command prints one JSON report local and exits 1 only for definite no", async (t) => {
  const f = fixture(t);
  const oldCwd = process.cwd();
  const oldExit = process.exitCode;
  const oldToken = process.env.GAUGE_API_TOKEN;
  t.after(() => {
    process.chdir(oldCwd);
    process.exitCode = oldExit;
    if (oldToken === undefined) delete process.env.GAUGE_API_TOKEN;
    else process.env.GAUGE_API_TOKEN = oldToken;
  });
  process.chdir(f.root);
  process.env.GAUGE_API_TOKEN = "signed-in";
  const output: string[] = [];
  t.mock.method(console, "log", (value: string) => output.push(value));
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Must remain local");
  });
  const run = async () => {
    const command = new Command()
      .option("-o, --output <format>")
      .option("--hosted", "hosted", true);
    register(command);
    await command.parseAsync(["run", "--verify", "-o", "json"], {
      from: "user",
    });
  };
  f.write("gauge.json", {});
  await run();
  assert.notEqual(process.exitCode, 1);
  assert.equal(output.length, 1);
  const report = JSON.parse(output[0]);
  assert.equal(report.version, 1);
  assert.equal(report.mode, "local-static");
  assert.equal(report.status, "passed");
  assert.deepEqual(report.summary, { yes: 1, no: 0, unknown: 0 });
  assert.deepEqual(report.facts, { configFilePresent: true, caseCount: 0 });
  assert.deepEqual(
    report.global.map((check: { id: string }) => check.id),
    ["configuration"],
  );
  assert.deepEqual(report.inputs, []);
  assert.equal(report.info[0].id, "no-cases");
  assert.ok(report.notChecked.includes("live-input-delivery"));
  f.write("gauge.json", { inputs: { cli: npm } });
  f.write(
    ".github/workflows/build.yml",
    workflow("true", undefined, "abcdef123"),
  );
  await run();
  assert.notEqual(process.exitCode, 1);
  assert.equal(JSON.parse(output[1]).status, "incomplete");
  assert.equal(JSON.parse(output[1]).summary.unknown, 1);
  f.write("gauge.json", "invalid");
  await run();
  assert.equal(process.exitCode, 1);
  assert.equal(output.length, 3);
  assert.equal(JSON.parse(output[2]).summary.no, 1);
  assert.equal(JSON.parse(output[2]).status, "failed");
  assert.equal(JSON.parse(output[2]).facts.caseCount, null);
});

test("console output separates information from checks and states static scope", (t) => {
  const f = fixture(t);
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => lines.push(line));
  printEvalVerification(verifyEvals(f.root));
  assert.doesNotMatch(lines.join("\n"), /\[unknown\]/);
  assert.match(lines.join("\n"), /\[info\] no-cases:/);
  assert.match(
    lines.join("\n"),
    /Static verification passed: 1 yes, 0 no, 0 unknown/,
  );
  assert.match(lines.join("\n"), /Scope: repository setup only/);
  assert.match(lines.join("\n"), /no sessions were launched/);
});

test("verifies open-ended and head-to-head cases alongside experience cases", (t) => {
  const f = fixture(t);
  f.write("gauge-cases/experience.md", markdown());
  f.write(
    "gauge-cases/open.md",
    "---\npreference:\n  kind: open-ended\nconfig:\n  agents:\n    - agent: CODEX_CLI\n---\nChoose analytics.",
  );
  f.write(
    "gauge-cases/head.md",
    "---\npreference:\n  kind: head-to-head\n  brandA: PostHog\n  brandB: Amplitude\nconfig:\n  agents:\n    - agent: CODEX_CLI\n---\nPostHog or Amplitude?",
  );
  const result = verifyEvals(f.root);
  assert.equal(result.status, "passed");
  assert.equal(result.facts.caseCount, 3);
});
