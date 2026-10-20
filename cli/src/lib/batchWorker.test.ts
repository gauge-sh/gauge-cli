import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("background startup failures settle durable batch status and wait", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gauge-worker-failure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(
    join(root, "gauge.json"),
    JSON.stringify({ version: 2, inputs: {} }),
  );
  const worker = fileURLToPath(
    new URL("../../dist/batchWorker.js", import.meta.url),
  );
  const cli = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: root,
    GAUGE_TELEMETRY_DISABLED: "1",
    GAUGE_MISSING_TEST_KEY: "",
  };
  const gaugeDir = join(root, ".gauge");
  const runtime = {
    reference: "fixture:tag",
    imageId: "sha256:fixture",
    ready: true,
  };
  for (const kind of ["credential", "malformed", "missing"] as const) {
    await t.test(kind, () => {
      const batchId = `b_${kind}`;
      const directory = join(gaugeDir, "batches", batchId);
      mkdirSync(directory, { recursive: true });
      const statusPath = join(directory, "status.json");
      writeFileSync(
        statusPath,
        JSON.stringify({
          batchId,
          state: "queued",
          expectedSessions: 2,
          runtime,
        }),
      );
      const requestPath = join(directory, "request.json");
      if (kind === "malformed")
        writeFileSync(requestPath, "{secret-request-fragment}");
      if (kind === "credential")
        writeFileSync(
          requestPath,
          JSON.stringify({
            batchId,
            gaugeDir,
            definition: {
              resources: [],
              cases: [
                {
                  path: "task.md",
                  prompt: "test",
                  config: {
                    sampleCount: 2,
                    agents: [{ agent: "CODEX_CLI", models: ["model"] }],
                  },
                },
              ],
            },
            credentialSelections: {
              "CODEX_CLI:model": {
                name: "work",
                agent: "CODEX_CLI",
                provider: "openai",
                auth: "api_key",
                env: "GAUGE_MISSING_TEST_KEY",
                source: "env:GAUGE_MISSING_TEST_KEY",
              },
            },
          }),
        );
      const result = spawnSync(process.execPath, [worker, requestPath], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 15_000,
      });
      assert.equal(result.status, 1, result.stderr);
      const status = JSON.parse(readFileSync(statusPath, "utf8"));
      assert.equal(status.state, "failed");
      assert.equal(status.expectedSessions, 2);
      assert.equal(status.finishedSessions, 0);
      assert.equal(status.queuedSessions, 0);
      assert.equal(status.skippedSessions, 2);
      assert.deepEqual(status.runtime, runtime);
      assert.equal(statSync(statusPath).mode & 0o777, 0o600);
      const detail = readFileSync(join(directory, "error.txt"), "utf8");
      assert.match(
        detail,
        kind === "credential"
          ? /GAUGE_MISSING_TEST_KEY/
          : /valid background batch request/,
      );
      assert.ok(
        !`${detail}${result.stderr}${JSON.stringify(status)}`.includes(
          "secret-request-fragment",
        ),
      );
      const waited = spawnSync(
        process.execPath,
        [
          cli,
          "run",
          "wait",
          "--batch",
          batchId,
          "--local",
          "--check",
          "-o",
          "json",
        ],
        { cwd: root, env, encoding: "utf8", timeout: 15_000 },
      );
      assert.equal(waited.status, 1, waited.stderr);
      assert.equal(JSON.parse(waited.stdout).batch.state, "failed");
    });
  }
});
