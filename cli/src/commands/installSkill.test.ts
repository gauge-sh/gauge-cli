import assert from "node:assert/strict";
import { test } from "node:test";
import { Command } from "commander";
import { register, summarizeInstaller } from "./installSkill";

const base = ["--yes", "skills@1.5.0", "add", "gauge-sh/gauge-skills", "--skill", "gauge-agents"];

test("interactive install inherits terminal streams and does not select agents automatically", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const program = new Command();
  let called = false;
  register(program, { platform: "linux", env: {}, isTTY: true, run: (cmd, args, opts) => {
    called = true;
    assert.equal(cmd, "npx");
    assert.deepEqual(args, base);
    assert.equal(opts.shell, false);
    assert.deepEqual(opts.stdio, ["inherit", "inherit", "inherit"]);
    return { status: 0, signal: null };
  } });
  await program.parseAsync(["install-skill"], { from: "user" });
  assert.ok(called);
});

test("forwards targets and options on Windows and keeps JSON stdout clean", async (t) => {
  t.mock.method(console, "error", () => {});
  const logs: string[] = [];
  t.mock.method(console, "log", (s: string) => logs.push(s));
  const program = new Command().option("-o, --output <format>");
  register(program, { platform: "win32", env: {}, isTTY: true, run: (cmd, args, opts) => {
    assert.equal(cmd, "npx.cmd");
    assert.deepEqual(args, [...base, "--agent", "claude-code", "--agent", "codex", "--global", "--yes", "--copy"]);
    assert.equal(opts.shell, true);
    assert.deepEqual(opts.stdio, ["inherit", 2, "inherit"]);
    return { status: 0, signal: null };
  } });
  await program.parseAsync(["install-skill", "--agent", "claude-code", "--agent", "codex", "--global", "--yes", "--copy", "-o", "json"], { from: "user" });
  assert.equal(logs.length, 1);
  assert.deepEqual(JSON.parse(logs[0]), { completed: true, skill: "gauge-agents" });
});

for (const args of [["--yes"], ["--agent", "codex & whoami"]]) {
  test(`rejects invalid installation options: ${args.join(" ")}`, async () => {
    const program = new Command();
    register(program, { env: {}, isTTY: true, run: () => assert.fail("must not spawn") });
    await assert.rejects(program.parseAsync(["install-skill", ...args], { from: "user" }));
  });
}

for (const result of [
  { status: 1, signal: null },
  { status: null, signal: "SIGINT" as const },
  { status: null, signal: null, error: new Error("spawn npx ENOENT") },
]) {
  test(`reports installer failure: ${result.error?.message ?? result.signal ?? result.status}`, async (t) => {
    t.mock.method(console, "error", () => {});
    t.mock.method(console, "log", () => assert.fail("must not report success"));
    const program = new Command();
    register(program, { env: {}, isTTY: true, run: () => result });
    await assert.rejects(program.parseAsync(["install-skill"], { from: "user" }), /Skill installation failed/);
  });
}

const installerOutput = [
  "◇  Installation Summary ───╮",
  "│  ~/repo/.agents/skills/gauge-agents  │",
  "│    copy → Claude Code                │",
  "◇  Security Risk Assessments ───╮",
  "│                Gen               Socket            Snyk      │",
  "│  gauge-agents  Safe              0 alerts          Med Risk  │",
  "│  Details: https://skills.sh/gauge-sh/gauge-skills            │",
  "\x1b[?25l│",
  "\x1b[999D\x1b[J◇  Installation complete",
  "\x1b[?25h",
  "│  ✓ gauge-agents (copied)                 │",
  "│    → ~/repo/.claude/skills/gauge-agents  │",
].join("\n");

test("summarizes installer output into paths and audits", () => {
  assert.deepEqual(summarizeInstaller(installerOutput), {
    paths: ["~/repo/.claude/skills/gauge-agents"],
    audits: { Gen: "Safe", Socket: "0 alerts", Snyk: "Med Risk" },
    details: "https://skills.sh/gauge-sh/gauge-skills",
  });
});

test("coding agents install for themselves without prompts and get a short summary", async (t) => {
  t.mock.method(console, "error", () => {});
  const logs: string[] = [];
  t.mock.method(console, "log", (s: string) => logs.push(s));
  const program = new Command();
  register(program, { platform: "linux", env: { CLAUDECODE: "1" }, isTTY: false, run: (_cmd, args, opts) => {
    assert.deepEqual(args, [...base, "--agent", "claude-code", "--yes"]);
    assert.deepEqual(opts.stdio, ["ignore", "pipe", "pipe"]);
    return { status: 0, signal: null, stdout: Buffer.from(installerOutput), stderr: Buffer.from("") };
  } });
  await program.parseAsync(["install-skill"], { from: "user" });
  assert.deepEqual(logs, [
    "Installed gauge-agents for claude-code: ~/repo/.claude/skills/gauge-agents",
    "skills.sh audits: Gen Safe, Socket 0 alerts, Snyk Med Risk. Details: https://skills.sh/gauge-sh/gauge-skills",
  ]);
});

test("non-interactive callers without a known agent must pass --agent", async () => {
  const program = new Command();
  register(program, { env: {}, isTTY: false, run: () => assert.fail("must not spawn") });
  await assert.rejects(program.parseAsync(["install-skill"], { from: "user" }), /Cannot detect the coding agent/);
});
