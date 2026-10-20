import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { RunDefinitionSubmission } from "@withgauge/api-schemas/runDefinitions";

test("CLI uploads a local candidate, launches without Git, and returns failed results as one JSON document", async (t) => {
  const runPath = "/api/v1/orgs/acme/run-definitions/run";
  const root = await realpath(await mkdtemp(join(tmpdir(), "gauge-ci-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "gauge-cases"));
  await mkdir(join(root, "built"));
  await writeFile(
    join(root, "built", "SKILL.md"),
    "---\nname: skill\ndescription: Help\n---\nInstructions",
  );
  await writeFile(
    join(root, "gauge.json"),
    JSON.stringify({
      version: 2,
      org: "acme",
      inputs: { skill: { type: "skill", path: "old.zip" } },
    }),
  );
  await writeFile(
    join(root, "gauge-cases", "task.md"),
    "---\ncriteria:\n  - name: Works\n    rubric: Task completed\nconfig:\n  agents:\n    - agent: CODEX_CLI\n      models: []\n---\nUse this skill.\n",
  );
  const calls: string[] = [];
  let declared: { sha256: string; bytes: number } | undefined;
  let submitted: RunDefinitionSubmission | undefined;
  const failures: unknown[] = [];
  let base = "";
  const result = {
    id: "request1",
    settled: true,
    status: "COMPLETED",
    result: "QUALITY_FAILED",
    counts: { createdRuns: 1, judgedRuns: 1, passedRuns: 0 },
    batches: [
      {
        id: "batch1",
        runs: [
          {
            id: "run1",
            url: "https://app.example.test/acme/runs/run1",
            result: "QUALITY_FAILED",
            criterionResults: [
              {
                name: "Works",
                passed: false,
                reasoning: "The task was not completed",
              },
            ],
          },
        ],
      },
    ],
  };
  const server = createServer(async (req, res) => {
    try {
      calls.push(`${req.method} ${req.url}`);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      res.setHeader("content-type", "application/json");
      if (req.url === "/upload") {
        assert.ok(declared);
        assert.equal(
          req.headers.authorization,
          undefined,
          "Gauge token must not reach storage",
        );
        assert.equal(bytes.length, declared.bytes);
        assert.equal(
          `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          declared.sha256,
        );
        res.end("{}");
        return;
      }
      assert.equal(req.headers.authorization, "Bearer test-token");
      if (req.url === "/api/v1/orgs/acme/run-definitions/uploads") {
        declared = JSON.parse(bytes.toString());
        assert.ok(declared);
        res.end(
          JSON.stringify({
            url: `${base}/upload`,
            headers: { "content-length": String(declared.bytes) },
          }),
        );
      } else if (req.url === runPath) {
        submitted = JSON.parse(bytes.toString());
        res.statusCode = 202;
        res.end(
          JSON.stringify({
            runRequestId: "request1",
            createdRuns: 0,
            requestedRuns: 1,
          }),
        );
      } else if (req.url === "/api/v1/orgs/acme/run-definitions/plan") {
        const definition = JSON.parse(bytes.toString());
        assert.equal(definition.inputSnapshots, undefined, "local filesystem paths stay in the CLI");
        assert.equal(definition.resources[0].source.sha256, declared?.sha256);
        res.end(JSON.stringify({ source: definition.source, expectedRuns: 1, resources: [], cases: [] }));
      } else if (req.url === "/api/v1/orgs/acme/run-requests/request1")
        res.end(JSON.stringify(result));
      else {
        res.statusCode = 404;
        res.end("{}");
      }
    } catch (error) {
      failures.push(error);
      res.statusCode = 500;
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
  const cliRoot = fileURLToPath(new URL("../../", import.meta.url));
  const invoke = (args: string[], mode = "--hosted") =>
    new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve) => {
        execFile(
          join(cliRoot, "node_modules/.bin/tsx"),
          [
            "--tsconfig",
            join(cliRoot, "tsconfig.json"),
            join(cliRoot, "src/index.ts"),
            mode,
            ...args,
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              GAUGE_API_TOKEN: "test-token",
              GAUGE_API_URL: base,
              XDG_CONFIG_HOME: root,
            },
            timeout: 30_000,
          },
          (error, stdout, stderr) =>
            resolve({ code: error ? Number(error.code) : 0, stdout, stderr }),
        );
      },
    );
  const launch = await invoke([
    "run",
    "--input",
    "skill=./built",
    "--yes",
    "-o",
    "json",
  ]);
  assert.equal(launch.code, 0, launch.stderr);
  assert.equal(JSON.parse(launch.stdout).runRequestId, "request1");
  assert.ok(submitted && declared);
  assert.equal(submitted.source.verification, "LOCAL");
  assert.equal(submitted.source.commit, null);
  const input = submitted.resources[0];
  assert.ok(input.source.type === "upload" && input.use.type === "skill");
  assert.equal(input.source.sha256, declared.sha256);
  assert.equal(input.use.root, ".");
  const wait = await invoke([
    "--org",
    "acme",
    "run",
    "wait",
    "request1",
    "--check",
    "-o",
    "json",
  ]);
  assert.equal(wait.code, 1);
  assert.deepEqual(JSON.parse(wait.stdout), result);
  assert.equal(wait.stderr, "");
  assert.deepEqual(failures, []);
  assert.deepEqual(calls, [
    "POST /api/v1/orgs/acme/run-definitions/uploads",
    "PUT /upload",
    `POST ${runPath}`,
    "GET /api/v1/orgs/acme/run-requests/request1",
  ]);
  const preview = await invoke([
    "run", "--input", "skill=./built", "--dry-run", "-o", "json",
  ]);
  assert.equal(preview.code, 0, preview.stderr);
  assert.deepEqual(JSON.parse(preview.stdout).inputSnapshots, [{
    name: "skill",
    source: "override",
    path: join(root, "built"),
    gaugeArchive: { sha256: declared.sha256, bytes: declared.bytes },
  }]);
  assert.deepEqual(failures, []);
  assert.equal(calls.filter((call) => call === `POST ${runPath}`).length, 1);
  const localPreview = await invoke([
    "run", "--input", "skill=./built", "--dry-run", "-o", "json",
  ], "--local");
  assert.equal(localPreview.code, 0, localPreview.stderr);
  assert.deepEqual(JSON.parse(localPreview.stdout).inputSnapshots, JSON.parse(preview.stdout).inputSnapshots);
});
