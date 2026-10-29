import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("website routing fails before local runtime setup, without suggesting a file override", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gauge-boundaries-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "gauge-cases"));
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin", "docker"), `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(join(root, "docker-called"))}, "called");
process.exit(99);
`);
  await chmod(join(root, "bin", "docker"), 0o755);
  await writeFile(join(root, "gauge.json"), JSON.stringify({
    version: 2,
    inputs: {
      docs: {
        type: "website",
        url: "https://docs.example.com",
        source: { type: "github-deployment", environment: "preview" },
      },
    },
  }));
  await writeFile(join(root, "gauge-cases", "docs.md"), `---
criteria:
  - name: Works
    rubric: The task succeeds.
config:
  agents:
    - agent: CODEX_CLI
  inputs: [docs]
---
Use the product documentation to complete the task.
`);
  const cli = fileURLToPath(new URL("../../", import.meta.url));
  const invoke = (args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(join(cli, "node_modules/.bin/tsx"), [
        "--tsconfig", join(cli, "tsconfig.json"), join(cli, "src/index.ts"),
        ...args, "-o", "json",
      ], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${join(root, "bin")}:${process.env.PATH}`,
          XDG_CONFIG_HOME: root,
          GAUGE_API_TOKEN: "",
          GAUGE_API_URL: "http://127.0.0.1:1",
          GAUGE_TELEMETRY_DISABLED: "1",
        },
        timeout: 30_000,
      }, (error, stdout, stderr) =>
        resolve({ code: error ? Number(error.code) : 0, stdout, stderr }));
    });
  for (const args of [
    ["--dry-run"],
    ["--yes"],
    ["--detach"],
    ["--dry-run", "--input", "docs=./missing"],
    ["--dry-run", "--input", "docs=https://preview.example.com"],
  ]) {
    const result = await invoke(["run", "--local", ...args]);
    assert.equal(result.code, 2, result.stdout + result.stderr);
    const { error } = JSON.parse(result.stderr || result.stdout);
    assert.equal(error.code, "usage");
    assert.match(error.message, /Website.*requires hosted Gauge/);
    assert.match(error.hint, /--hosted.*rather than testing whether it finds your site/);
    assert.doesNotMatch(error.hint, /--input|login|npm pack/);
  }
  const override = await invoke(["run", "--hosted", "--dry-run", "--input", "docs=./missing"]);
  assert.equal(override.code, 2);
  const { error } = JSON.parse(override.stderr || override.stdout);
  assert.match(error.message, /website inputs cannot be supplied through --input/);
  assert.match(error.hint, /public preview/);
  const hosted = await invoke(["run", "--hosted", "--dry-run"]);
  assert.equal(hosted.code, 2);
  const missingSource = JSON.parse(hosted.stderr || hosted.stdout).error;
  assert.match(missingSource.message, /requires a Git checkout with an origin/);
  assert.match(missingSource.hint, /publish a matching public preview/);
  assert.doesNotMatch(missingSource.hint, /Supply --input/);
  await assert.rejects(access(join(root, "docker-called")));
  await assert.rejects(access(join(root, ".gauge", "runs")));
  await assert.rejects(access(join(root, ".gauge", "gauge.sqlite")));
});
