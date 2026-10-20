import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const source = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "gauge-custom-runtime-"));
const suffix = `${process.pid}-${Date.now()}`;
const base = process.env.GAUGE_CUSTOM_RUNTIME_TEST_IMAGE;
assert.ok(base, "Set GAUGE_CUSTOM_RUNTIME_TEST_IMAGE to the built examples/runtime-python image");
const tags = [];
const fixtureCredential = "fixture-credential-must-not-be-persisted";
const ambientCredential = "ambient-credential-must-not-be-selected";
const env = { ...process.env, XDG_CONFIG_HOME: directory, GAUGE_TELEMETRY_DISABLED: "1", CLAUDE_CODE_OAUTH_TOKEN: ambientCredential, GAUGE_FIXTURE_TOKEN: fixtureCredential, ANTHROPIC_API_KEY: "" };
delete env.GAUGE_MISSING_FIXTURE_KEY;
let cli;
let batchId;
const invoke = (...args) => exec(process.execPath, [cli, ...args, "--local", "-o", "json"], { cwd: directory, env, timeout: 60_000 });
async function build(name, lines) {
  const tag = `gauge-custom-${name}:${suffix}`;
  tags.push(tag);
  await writeFile(join(directory, "Dockerfile"), `FROM ${base}\n${lines}\n`);
  await exec("docker", ["build", "-q", "-t", tag, directory], { maxBuffer: 1024 * 1024 });
  return tag;
}
try {
  const { stdout: packed } = await exec("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", directory], { cwd: join(source, "cli") });
  await writeFile(join(directory, "package.json"), '{"private":true,"type":"module"}');
  await exec("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(directory, JSON.parse(packed)[0].filename)], { cwd: directory });
  cli = join(directory, "node_modules/@withgauge/cli/dist/index.js");
  await exec("git", ["init", "-q", directory]);
  await mkdir(join(directory, "gauge-cases"));
  await writeFile(join(directory, "gauge.json"), JSON.stringify({ version: 2, inputs: {} }));
  const caseFile = join(directory, "gauge-cases/task.md");
  await writeFile(caseFile, "---\ncriteria:\n  - name: Works\n    rubric: Completes the task\nconfig:\n  sampleCount: 6\n  agents:\n    - agent: CLAUDE_CODE\n---\nHELLO\n");
  const dry = JSON.parse((await invoke("run", "--runtime-image", base, "--dry-run")).stdout);
  assert.equal(dry.runtime.reference, base);
  assert.match(dry.runtime.imageId, /^sha256:/);
  assert.match((await exec("docker", ["run", "--rm", "--network", "none", base, "python3", "--version"])).stdout, /^Python 3\./);

  const ignored = await build("entrypoint", 'ENTRYPOINT ["/bin/true"]');
  await assert.rejects(invoke("run", "--runtime-image", ignored), (error) => /did not execute Gauge/.test(error.stderr));
  const missingLoginPath = await build("login-path", "USER root\nRUN rm /etc/profile.d/gauge-path.sh\nUSER node");
  await assert.rejects(invoke("run", "--runtime-image", missingLoginPath), (error) => /environment-installed tools are missing from PATH in sh -lc/.test(error.stderr));
  const broken = await build("missing", "USER root\nRUN rm /usr/local/bin/claude\nUSER node");
  await assert.rejects(invoke("run", "--runtime-image", broken), (error) => /missing or broken harness: claude/.test(error.stderr));
  const permissions = await build("permissions", "USER root\nRUN chmod 0555 /tmp\nUSER node");
  if (process.getuid() !== 0)
    await assert.rejects(invoke("run", "--runtime-image", permissions), (error) => /not writable/.test(error.stderr));

  const agent = await readFile(join(source, "packages/local/test/runtime-fixture/agent.mjs"), "utf8");
  await writeFile(join(directory, "agent.mjs"), agent.replace("  turns++;", `  turns++;
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN !== ${JSON.stringify(fixtureCredential)}) {
    complete("credential selection mismatch", true); continue;
  }
  await new Promise(resolve => setTimeout(resolve, 8000));`));
  const fixture = await build("fixture", "USER root\nRUN rm /usr/local/bin/claude\nCOPY agent.mjs /usr/local/bin/claude\nRUN chmod 755 /usr/local/bin/claude\nUSER node");
  await invoke("local", "profiles", "set", "selected", "--agent", "CLAUDE_CODE", "--provider", "anthropic", "--auth", "setup_token", "--env", "GAUGE_FIXTURE_TOKEN");
  await invoke("local", "profiles", "set", "blocked", "--agent", "CLAUDE_CODE", "--provider", "anthropic", "--auth", "api_key", "--env", "GAUGE_MISSING_FIXTURE_KEY");
  await invoke("local", "profiles", "use", "selected");
  const preview = JSON.parse((await invoke("run", "--profile", "selected", "--runtime-image", fixture, "--dry-run")).stdout);
  const identity = preview.runtime.imageId;
  assert.equal(preview.credentials[0].ready, true);
  assert.equal(preview.credentials[0].profile.source, "env:GAUGE_FIXTURE_TOKEN");
  const detached = JSON.parse((await invoke("run", "--profile", "selected", "--runtime-image", fixture, "--detach")).stdout);
  batchId = detached.batchId;
  await invoke("local", "profiles", "use", "blocked");
  await invoke("local", "profiles", "set", "selected", "--replace", "--agent", "CLAUDE_CODE", "--provider", "anthropic", "--auth", "setup_token", "--env", "GAUGE_MISSING_FIXTURE_KEY");
  await exec("docker", ["tag", ignored, fixture]);
  const final = JSON.parse((await invoke("run", "wait", "--batch", batchId)).stdout);
  assert.equal(final.batch.state, "completed");
  assert.equal(final.runs.length, 6);
  assert.ok(final.runs.every((run) => run.state === "completed"));
  for (const runId of await readdir(join(directory, ".gauge/runs"))) {
    const spec = JSON.parse(await readFile(join(directory, ".gauge/runs", runId, "attempts/1/spec.json"), "utf8"));
    assert.equal(spec.session.image, identity);
    assert.equal(spec.runtime.reference, fixture);
    assert.equal(spec.credentialProfile.name, "selected");
    assert.equal(spec.credentialProfile.env, "GAUGE_FIXTURE_TOKEN");
    assert.equal(spec.session.auth.mode, "setup_token");
  }
  assert.equal(final.batch.runtime.imageId, identity);
  async function checkSavedFiles(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await checkSavedFiles(child);
      else if (entry.isFile()) {
        const contents = await readFile(child);
        assert.ok(!contents.includes(fixtureCredential), `Selected credential persisted in ${entry.name}`);
        assert.ok(!contents.includes(ambientCredential), `Ambient credential persisted in ${entry.name}`);
      }
    }
  }
  await checkSavedFiles(join(directory, ".gauge"));
  console.log("Custom runtime qualification passed: isolated CLI tarball, Python example, broken harness/entrypoint/permissions, detached image/profile freeze, actual credential delivery and persisted-secret redaction.");
} finally {
  if (cli && batchId) await invoke("run", "cancel", "--batch", batchId).catch(() => {});
  if (cli) await invoke("cleanup").catch(() => {});
  for (const tag of tags) await exec("docker", ["image", "rm", tag]).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
