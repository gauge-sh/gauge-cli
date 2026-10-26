import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Command } from "commander";
import { selectedOrg } from "./context";

test("shared project organization applies to saved hosted objects, explicit org wins", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gauge-context-"));
  const cwd = process.cwd();
  t.after(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(
    join(root, "gauge.json"),
    '{"version":2,"org":"project-team","inputs":{}}',
  );
  process.chdir(root);
  const command = new Command().option("--org <org>").option("--hosted");
  command.parse(["--hosted"], { from: "user" });
  assert.deepEqual(selectedOrg(command), {
    value: "project-team",
    source: "project",
  });
  command.setOptionValue("org", "one-off-team");
  assert.deepEqual(selectedOrg(command), {
    value: "one-off-team",
    source: "flag",
  });
});
