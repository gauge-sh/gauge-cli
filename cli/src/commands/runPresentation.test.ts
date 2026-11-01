import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { Command } from "commander";
import { SMALL_DOG_LOGO } from "../lib/logo";
import { register } from "./run";

it("prints the foreground local reminder before starting sessions, never during preview or after completion", async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "gauge-run-presentation-")),
  );
  const cwd = process.cwd();
  const previousExitCode = process.exitCode;
  const previousEnv = {
    PATH: process.env.PATH,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  };
  t.after(async () => {
    process.chdir(cwd);
    process.exitCode = previousExitCode;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "bin"));
  await mkdir(join(root, "gauge-cases"));
  await writeFile(join(root, "gauge.json"), '{"version":2,"inputs":{}}');
  await writeFile(
    join(root, "gauge-cases/task.md"),
    `---
criteria:
  - name: Works
    rubric: Completes the task
config:
  agents:
    - agent: CLAUDE_CODE
---
Complete the task.
`,
  );
  const marker = join(root, "reminder-seen");
  const createLog = join(root, "session-create.json");
  await writeFile(
    join(root, "bin/docker"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'version') console.log(JSON.stringify({Os:'linux',Arch:'amd64'}));
else if (args[0] === 'image') console.log(JSON.stringify([{Id:'sha256:${"a".repeat(64)}',Os:'linux',Architecture:'amd64',Config:{Labels:{'sh.gauge.contract':'1'}}}]));
else if (args[0] === 'run') console.log('GAUGE_RUNTIME_COMPATIBLE');
else if (args[0] === 'create') {
  fs.writeFileSync(${JSON.stringify(createLog)}, JSON.stringify({reminded:fs.existsSync(${JSON.stringify(marker)})}));
  process.stderr.write('Intentional fixture session failure');
  process.exitCode = 1;
} else if (args[0] !== 'rm') process.exitCode = 1;
`,
  );
  await chmod(join(root, "bin/docker"), 0o755);
  process.env.PATH = `${join(root, "bin")}:${previousEnv.PATH}`;
  process.env.XDG_CONFIG_HOME = root;
  process.env.ANTHROPIC_API_KEY = "fixture-only";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "";
  process.chdir(root);
  const output: string[] = [];
  const notices: string[] = [];
  t.mock.method(console, "log", (chunk: unknown) => output.push(String(chunk)));
  t.mock.method(console, "error", (chunk: unknown) => {
    const notice = String(chunk);
    notices.push(notice);
    if (notice.includes(SMALL_DOG_LOGO)) {
      assert.equal(output.length, 0, "the reminder precedes the batch result");
      // The executor must not reach docker create before this notice.
      writeFileSync(marker, "seen");
    }
  });
  const invoke = async (...args: string[]) => {
    const command = new Command()
      .option("--local")
      .option("-o, --output <format>");
    register(command);
    await command.parseAsync(["--local", "-o", "json", "run", ...args], {
      from: "user",
    });
  };

  await invoke("--dry-run");
  assert.equal(JSON.parse(output[0]).expectedSessions, 1);
  assert.ok(notices.every((notice) => !notice.includes(SMALL_DOG_LOGO)));
  output.length = 0;
  notices.length = 0;

  await invoke("--yes");
  assert.deepEqual(JSON.parse(await readFile(createLog, "utf8")), {
    reminded: true,
  });
  assert.equal(
    notices.filter((notice) => notice.includes(SMALL_DOG_LOGO)).length,
    1,
  );
  assert.equal(output.length, 1, "stdout remains one JSON document");
  assert.equal(JSON.parse(output[0]).runs.length, 1);
  assert.equal(process.exitCode, 1, "the session failure remains an error");
});
