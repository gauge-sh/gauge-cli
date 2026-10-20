import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { agentEnv, prepareScript, shellQuote } from "../packages/local/dist/scripts.js";

const exec = promisify(execFile);
const image = process.argv[2];
assert.ok(image, "Pass the runtime image reference to qualify");
const root = await mkdtemp(join(tmpdir(), "gauge-runtime-path-"));
const bin = "/gauge/session/npm/bin";
const tool = "gauge-path-fixture";
try {
  const packageDir = join(root, "package");
  await mkdir(packageDir);
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: tool, version: "1.0.0", bin: { [tool]: "cli.cjs" } }));
  await writeFile(join(packageDir, "cli.cjs"), '#!/usr/bin/env node\nconsole.log("GAUGE_PATH_OK");\n');
  const tarball = join(root, "fixture.tgz");
  await exec("tar", ["-czf", tarball, "-C", root, "package"]);
  const archive = join(root, "input.tar.gz");
  await exec("tar", ["-czf", archive, "-C", root, "fixture.tgz"]);
  const digest = `sha256:${createHash("sha256").update(await readFile(archive)).digest("hex")}`;
  const shellCheck = `test "$(command -v ${tool})" = ${bin}/${tool} && test "$(${tool})" = GAUGE_PATH_OK`;
  const idempotence = `. /etc/profile.d/gauge-path.sh; gauge_before=$PATH; . /etc/profile.d/gauge-path.sh; test "$PATH" = "$gauge_before"; node -e 'if (process.env.PATH.split(":").filter(p => p === "${bin}").length !== 1) process.exit(1)'`;
  const uids = [...new Set([process.getuid(), 54321])];
  for (const uid of uids) {
    for (const kind of ["claude-code", "codex", "pi", "opencode"]) {
      const session = join(root, `${uid}-${kind}`);
      await mkdir(session);
      await chmod(session, 0o777);
      const spec = {
        image, agent: { kind, model: "fixture" }, auth: { mode: "setup_token" }, workspace: null,
        resources: [{ name: "fixture", kind: "archive", filename: "input.tar.gz", digest, use: { type: "npm-package", package: "fixture.tgz", install: "environment" } }],
        prompt: { text: "" }, limits: { turnTimeoutS: 30, responseTimeoutS: null, maxTurns: 1 },
      };
      const script = [
        prepareScript(spec),
        shellCheck,
        `sh -c ${shellQuote(shellCheck)}`,
        `sh -lc ${shellQuote(shellCheck)}`,
        `bash -lc ${shellQuote(shellCheck)}`,
        `bash -lc ${shellQuote(`bash -lc ${shellQuote(shellCheck)}`)}`,
        `sh -c ${shellQuote(idempotence)}`,
        `echo GAUGE_PATH_VERIFIED`,
      ].join("\n");
      const args = ["run", "--rm", "--network", "none", "--user", `${uid}:${process.getgid()}`,
        "--env", "HOME=/gauge/session/home", "--env", "npm_config_offline=true", "--env", "npm_config_update_notifier=false",
        ...Object.entries(agentEnv(kind)).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
        "--mount", `type=bind,source=${session},target=/gauge/session`,
        "--mount", `type=bind,source=${archive},target=/gauge/inputs/fixture,readonly`,
        image, "sh", "-c", script];
      const { stdout } = await exec("docker", args, { timeout: 60_000 });
      assert.match(stdout, /GAUGE_PATH_VERIFIED/);
      console.log(`${kind} UID ${uid}: environment-installed npm CLI survives ordinary and nested login shells`);
    }
  }
} finally {
  await exec("docker", ["run", "--rm", "--network", "none", "--user", "0:0", "--entrypoint", "sh",
    "--mount", `type=bind,source=${root},target=/fixture`, image, "-c", "rm -rf /fixture/*"]).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
