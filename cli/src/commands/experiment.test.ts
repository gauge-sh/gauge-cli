import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { Command } from "commander";
import { compileDefinitionInput } from "@withgauge/api-schemas/runDefinitionInputs";
import { experimentSchema } from "@withgauge/api-schemas/experiments";
import { EXAMPLE_EXPERIMENT } from "../lib/experimentSpec";
import { register } from "./run";

const sha = "a".repeat(40);
async function invoke(
  t: TestContext,
  flags: string[],
  spec: unknown = EXAMPLE_EXPERIMENT,
  failResolve = false,
  withWorkspace = false,
) {
  const cwd = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "gauge-experiment-"));
  const token = process.env.GAUGE_API_TOKEN;
  const url = process.env.GAUGE_API_URL;
  process.env.GAUGE_API_TOKEN = "test-token";
  process.env.GAUGE_API_URL = "https://gauge.example.test";
  process.chdir(directory);
  t.after(() => {
    process.chdir(cwd);
    rmSync(directory, { recursive: true, force: true });
    if (token === undefined) delete process.env.GAUGE_API_TOKEN;
    else process.env.GAUGE_API_TOKEN = token;
    if (url === undefined) delete process.env.GAUGE_API_URL;
    else process.env.GAUGE_API_URL = url;
  });
  writeFileSync("experiment.json", JSON.stringify(spec));
  // The explicit input spec must never read these unrelated input declarations.
  if (withWorkspace)
    writeFileSync(
      "gauge.json",
      JSON.stringify({
        version: 2,
        inputs: { unrelated: { type: "files", paths: ["secret.txt"] } },
      }),
    );
  writeFileSync("secret.txt", "unrelated local content");
  const requests: { path: string; body: any }[] = [];
  const output: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) =>
    output.push(args.join(" ")),
  );
  t.mock.method(console, "error", () => {});
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body));
      requests.push({ path, body });
      if (path.endsWith("/resolve")) {
        if (failResolve)
          return Response.json(
            { error: { code: "not_found", message: "Revision unavailable" } },
            { status: 404 },
          );
        const experiment = experimentSchema.parse({
          ...body,
          product: {
            repository: "https://github.com/example/product",
            revision: sha,
          },
        });
        return Response.json({
          experiment,
          definition: {
            version: 2,
            source: {
              repoUrl: experiment.product.repository,
              commit: sha,
              digest: `sha256:${"b".repeat(64)}`,
              verification: "SUBMITTED_UNVERIFIED",
            },
            resources: Object.entries(experiment.inputs).map(([name, value]) =>
              compileDefinitionInput(
                name,
                value,
                experiment.product.repository,
                sha,
              ),
            ),
            cases: experiment.cases.map(({ key, ...item }) => ({
              path: key,
              ...item,
            })),
          },
        });
      }
      if (path.endsWith("/plan"))
        return Response.json({
          canRun: true,
          expectedRuns: 1,
          source: body.source,
          resources: body.resources,
          cases: [],
        });
      if (path.endsWith("/run"))
        return Response.json({
          runRequestId: "request-1",
          runIds: [],
          createdRuns: 0,
          requestedRuns: 1,
        });
      throw new Error(`Unexpected request: ${path}`);
    },
  );
  const program = new Command()
    .option("--org <org>")
    .option("-o, --output <format>")
    .option("--hosted")
    .option("--local");
  register(program);
  let error: unknown;
  try {
    await program.parseAsync(
      [
        "--org",
        "8c7f0e1a-1111-4222-8333-944455556666",
        "-o",
        "json",
        "run",
        "--apply",
        "experiment.json",
        ...flags,
      ],
      { from: "user" },
    );
  } catch (caught) {
    error = caught;
  }
  return { requests, output, error };
}

it("previews from a non-Git directory without inheriting or uploading local files and returns a reusable pinned spec", async (t) => {
  const result = await invoke(
    t,
    ["--hosted", "--dry-run"],
    EXAMPLE_EXPERIMENT,
    false,
    true,
  );
  assert.equal(result.error, undefined);
  assert.deepEqual(
    result.requests.map((r) => r.path.split("/").at(-1)),
    ["resolve", "plan"],
  );
  const preview = JSON.parse(result.output[0]);
  assert.equal(preview.experiment.product.revision, sha);
  assert.deepEqual(preview.inputSnapshots, []);
  assert.deepEqual(Object.keys(preview.experiment.inputs), ["docs"]);
  assert.equal(result.requests[1].body.resources[0].source.commit, sha);
  assert.equal(result.requests[1].body.cases[0].config.repoUrl, undefined);
  assert.equal(JSON.stringify(result.requests).includes("unrelated"), false);
});

it("launches without gauge.json and honors explicit consumer workspace configuration", async (t) => {
  const spec = structuredClone(EXAMPLE_EXPERIMENT);
  Object.assign(spec.cases[0].config, {
    repoUrl: "https://github.com/example/consumer",
    repoRef: "b".repeat(40),
  });
  const result = await invoke(t, ["--hosted", "--yes"], spec);
  assert.equal(result.error, undefined);
  assert.deepEqual(
    result.requests.map((r) => r.path.split("/").at(-1)),
    ["resolve", "run"],
  );
  assert.equal(result.requests[1].body.source.commit, sha);
  assert.equal(
    result.requests[1].body.cases[0].config.repoUrl,
    "https://github.com/example/consumer",
  );
  assert.equal(JSON.parse(result.output[0]).runRequestId, "request-1");
});

it("submits a saved pinned experiment without returning to its original branch", async (t) => {
  const spec = structuredClone(EXAMPLE_EXPERIMENT);
  spec.product.revision = sha;
  const result = await invoke(t, ["--hosted", "--yes"], spec);
  assert.equal(result.error, undefined);
  assert.equal(result.requests[0].body.product.revision, sha);
  assert.equal(result.requests[1].body.source.commit, sha);
});

for (const flags of [
  ["--local", "--dry-run"],
  ["--hosted", "--input", "docs=secret.txt", "--dry-run"],
])
  it(`rejects unsupported input execution without falling back: ${flags.join(" ")}`, async (t) => {
    const result = await invoke(t, flags);
    assert.ok(result.error);
    assert.equal(result.requests.length, 0);
  });

for (const invalid of [
  { ...EXAMPLE_EXPERIMENT, inputs: undefined },
  { ...EXAMPLE_EXPERIMENT, inputs: {} },
  {
    ...EXAMPLE_EXPERIMENT,
    product: {
      repository: "https://secret@github.com/example/product",
      revision: "main",
    },
  },
])
  it("rejects incomplete or invalid experiments without treating them as local case specs", async (t) => {
    const result = await invoke(t, ["--hosted", "--dry-run"], invalid);
    assert.ok(result.error);
    assert.equal(result.requests.length, 0);
  });

it("does not launch or substitute local inputs when revision resolution fails", async (t) => {
  const result = await invoke(
    t,
    ["--hosted", "--yes"],
    EXAMPLE_EXPERIMENT,
    true,
  );
  assert.ok(result.error);
  assert.equal(result.requests.length, 1);
});
