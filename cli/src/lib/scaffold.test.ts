import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { summarize } from "../commands/init";
import { AGENTS_BLOCK, scaffoldWorkspace } from "./scaffold";

function repo(t: TestContext, origin = true): string {
  const root = mkdtempSync(join(tmpdir(), "gauge-init-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  if (origin)
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://github.com/acme/app.git"],
      { cwd: root },
    );
  return root;
}

const read = (root: string, path: string) =>
  readFileSync(join(root, path), "utf8");

test("init needs no Git, creates private SQLite state and optional shared cases", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gauge-init-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = scaffoldWorkspace(root, "local");
  assert.equal(existsSync(join(root, "gauge.json")), false);
  assert.equal(existsSync(join(root, "AGENTS.md")), false);
  assert.deepEqual(JSON.parse(read(root, ".gauge/config.json")), {
    version: 1,
    backend: "local",
  });
  assert.ok(existsSync(join(root, ".gauge/gauge.sqlite")));
  assert.equal(existsSync(join(root, "gauge-cases")), false);
  assert.equal(result.casesDir, "not-requested");
  assert.equal(read(root, ".gauge/.gitignore"), "*\n");
  assert.equal(scaffoldWorkspace(root, "local", true).casesDir, "created");
  assert.deepEqual(JSON.parse(read(root, "gauge.json")), {
    version: 2,
    inputs: {},
  });
  assert.equal(read(root, "AGENTS.md"), `${AGENTS_BLOCK}\n`);
});

test("backend switches preserve the shared manifest and are repeatable", (t) => {
  const root = repo(t);
  const manifest = '{"version":2,"org":"acme","inputs":{}}';
  writeFileSync(join(root, "gauge.json"), manifest);
  scaffoldWorkspace(root, "local", true);
  const result = scaffoldWorkspace(root, "hosted", true);
  assert.equal(read(root, "gauge.json"), manifest);
  assert.deepEqual(JSON.parse(read(root, ".gauge/config.json")), {
    version: 1,
    backend: "hosted",
  });
  assert.equal(result.gaugeJson, "kept");
  assert.equal(result.casesDir, "kept");
  assert.equal(result.agentsMd, "unchanged");
});

test("CLAUDE.md is never touched, even when it is only @AGENTS.md", (t) => {
  const root = repo(t);
  writeFileSync(join(root, "CLAUDE.md"), "@AGENTS.md\n");
  scaffoldWorkspace(root, "local");
  assert.equal(read(root, "CLAUDE.md"), "@AGENTS.md\n");
});

test("the block is appended to an existing AGENTS.md, then replaced in place", (t) => {
  const root = repo(t);
  writeFileSync(join(root, "AGENTS.md"), "# Rules\nBe nice.");
  assert.equal(scaffoldWorkspace(root, "local", true).agentsMd, "added");
  assert.equal(
    read(root, "AGENTS.md"),
    `# Rules\nBe nice.\n\n${AGENTS_BLOCK}\n`,
  );

  writeFileSync(
    join(root, "AGENTS.md"),
    "# Rules\n<!-- gauge:start -->\nold\n<!-- gauge:end -->\nAfter.\n",
  );
  const result = scaffoldWorkspace(root, "local", true);
  assert.equal(result.agentsMd, "updated");
  assert.equal(read(root, "AGENTS.md"), `# Rules\n${AGENTS_BLOCK}\nAfter.\n`);
});

test("an unmatched start marker gets a new block appended", (t) => {
  const root = repo(t);
  writeFileSync(join(root, "AGENTS.md"), "<!-- gauge:start -->\nstray\n");
  assert.equal(scaffoldWorkspace(root, "local", true).agentsMd, "added");
  assert.ok(read(root, "AGENTS.md").endsWith(`stray\n\n${AGENTS_BLOCK}\n`));
});
