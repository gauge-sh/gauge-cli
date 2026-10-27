import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
const exec = promisify(execFile);
const cliRoot = fileURLToPath(new URL("../../", import.meta.url));

test("runtime commands work without Gauge login, keep inspect read-only, and isolate pull progress from JSON", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gauge-runtime-command-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "bin"));
  const calls = join(root, "calls.jsonl");
  const installed = join(root, "installed");
  await writeFile(join(root, "bin/docker"), `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(args[0]==='version') console.log(JSON.stringify({Os:'linux',Arch:process.env.TEST_DOCKER_ARCH || 'amd64'}));
else if(args[0]==='pull') { if(process.env.TEST_PULL_FAIL) process.exit(1); console.log('Downloading layers'); fs.writeFileSync(${JSON.stringify(installed)},process.env.TEST_DOCKER_ARCH || 'amd64'); }
else if(args[0]==='image' && fs.existsSync(${JSON.stringify(installed)})) console.log(JSON.stringify([{Id:'sha256:'+'a'.repeat(64),Os:'linux',Architecture:fs.readFileSync(${JSON.stringify(installed)},'utf8'),Config:{Labels:{'sh.gauge.contract':args[2].includes('gauge-gateway')?'gateway-1':'1'}}}]));
else process.exit(1);
`, { mode: 0o755 });
  const run = async (args: string[], extra: Record<string, string> = {}) => {
    try {
      return { code: 0, ...await exec(join(cliRoot, "node_modules/.bin/tsx"), ["--tsconfig", join(cliRoot, "tsconfig.json"), join(cliRoot, "src/index.ts"), ...args], {
        cwd: root,
        timeout: 30_000,
        env: { PATH: `${join(root, "bin")}:${process.env.PATH}`, HOME: root, TMPDIR: root, XDG_CONFIG_HOME: root, GAUGE_TELEMETRY_DISABLED: "1", ...extra },
      }) };
    } catch (error) {
      const result = error as { code: number; stdout: string; stderr: string };
      return result;
    }
  };
  const inspect = await run(["local", "runtime", "inspect", "-o", "json"]);
  assert.equal(inspect.code, 1, inspect.stderr);
  assert.ok(inspect.stdout, inspect.stderr);
  assert.equal(JSON.parse(inspect.stdout).problem.code, "image_missing");
  assert.ok(!(await readFile(calls, "utf8")).includes('"pull"'));
  const unsupported = await run(["local", "runtime", "pull", "-o", "json"], { TEST_DOCKER_ARCH: "s390x" });
  assert.equal(unsupported.code, 2);
  assert.ok(!(await readFile(calls, "utf8")).includes('"pull"'));
  const failed = await run(["local", "runtime", "pull", "-o", "json"], { TEST_PULL_FAIL: "1" });
  assert.notEqual(failed.code, 0);
  assert.match(failed.stderr, /Could not pull/);
  const pull = await run(["local", "runtime", "pull", "-o", "json"]);
  assert.equal(pull.code, 0, pull.stderr);
  assert.equal(JSON.parse(pull.stdout).ready, true);
  assert.equal(JSON.parse(pull.stdout).gateway.ready, true);
  assert.match(pull.stderr, /Downloading layers/);
  const mismatched = await run(["local", "runtime", "inspect", "-o", "json"], { TEST_DOCKER_ARCH: "arm64" });
  assert.equal(mismatched.code, 1);
  assert.equal(JSON.parse(mismatched.stdout).problem.code, "platform_unsupported");
  assert.equal(JSON.parse(mismatched.stdout).dockerPlatform, "linux/arm64");
  const arm = await run(["local", "runtime", "pull", "-o", "json"], { TEST_DOCKER_ARCH: "arm64" });
  assert.equal(arm.code, 0, arm.stderr);
  assert.equal(JSON.parse(arm.stdout).ready, true);
  assert.equal(JSON.parse(arm.stdout).platform, "linux/arm64");
  assert.match(arm.stderr, /Downloading layers/);
  const pulls = (await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]).filter(args => args[0] === "pull");
  assert.deepEqual(pulls.at(-1)?.slice(0, 3), ["pull", "--platform", "linux/arm64"]);
});
