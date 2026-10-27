import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { Command } from "commander";
import { register } from "./run";

type Aggregate = {
  id: string;
  status: string;
  result: string;
  settled: boolean;
  counts: {
    createdRuns: number;
    terminalRuns: number;
    judgedRuns: number;
    passedRuns: number;
  };
};

function aggregate(
  status: string,
  result: string,
  settled: boolean,
  judgedRuns: number,
  passedRuns: number,
  terminalRuns = 1,
): Aggregate {
  return {
    id: "request-1",
    status,
    result,
    settled,
    counts: { createdRuns: 1, terminalRuns, judgedRuns, passedRuns },
  };
}

async function runWait(
  t: TestContext,
  responses: Aggregate[],
  args: string[] = ["wait", "request-1"],
): Promise<{
  calls: string[];
  stdout: string[];
  stderr: string[];
  error?: unknown;
}> {
  const oldToken = process.env.GAUGE_API_TOKEN;
  const oldUrl = process.env.GAUGE_API_URL;
  process.env.GAUGE_API_TOKEN = "gauge_test";
  process.env.GAUGE_API_URL = "https://test.invalid";
  t.after(() => {
    if (oldToken === undefined) delete process.env.GAUGE_API_TOKEN;
    else process.env.GAUGE_API_TOKEN = oldToken;
    if (oldUrl === undefined) delete process.env.GAUGE_API_URL;
    else process.env.GAUGE_API_URL = oldUrl;
  });
  const calls: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  t.mock.method(console, "log", (line: string) => stdout.push(line));
  t.mock.method(console, "error", (line: string) => stderr.push(line));
  t.mock.method(globalThis, "setTimeout", (callback: () => void) => {
    queueMicrotask(callback);
    return 1;
  });
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    calls.push(String(url));
    const response = responses.shift();
    assert.ok(response, "wait must stop after a settled aggregate");
    return Response.json(response);
  });
  const command = new Command()
    .option("--hosted", "use hosted", true)
    .option("--org <org>")
    .option("-o, --output <format>");
  register(command);
  let error: unknown;
  try {
    await command.parseAsync(
      ["--org", "8c7f0e1a-1111-4222-8333-944455556666", "-o", "json", "run", ...args],
      { from: "user" },
    );
  } catch (caught) {
    error = caught;
  }
  return { calls, stdout, stderr, error };
}

it("waits for judging after execution completes, then emits one passed JSON result", async (t) => {
  const result = await runWait(t, [
    aggregate("RUNNING", "PENDING", false, 0, 0, 0),
    aggregate("RUNNING", "PENDING", false, 0, 0),
    aggregate("COMPLETED", "PASSED", true, 1, 1),
  ]);
  assert.equal(result.error, undefined);
  assert.equal(result.calls.length, 3);
  assert.ok(
    result.calls.every(
      (url) =>
        url ===
        "https://test.invalid/api/v1/orgs/8c7f0e1a-1111-4222-8333-944455556666/run-requests/request-1",
    ),
  );
  assert.equal(result.stdout.length, 1);
  assert.equal(JSON.parse(result.stdout[0]).result, "PASSED");
  assert.deepEqual(result.stderr, []);
});

function keepExitCode(t: TestContext): void {
  const old = process.exitCode;
  t.after(() => {
    process.exitCode = old;
  });
  process.exitCode = undefined;
}

it("exits 0 for a settled failed aggregate and prints only the JSON", async (t) => {
  keepExitCode(t);
  const result = await runWait(t, [
    aggregate("RUNNING", "PENDING", false, 0, 0),
    aggregate("COMPLETED", "QUALITY_FAILED", true, 1, 0),
  ]);
  assert.equal(result.calls.length, 2);
  assert.equal(result.error, undefined);
  assert.equal(process.exitCode, undefined);
  assert.equal(result.stdout.length, 1);
  assert.equal(JSON.parse(result.stdout[0]).result, "QUALITY_FAILED");
  assert.deepEqual(result.stderr, []);
});

it("--check exits 1 for a failed verdict without an error line", async (t) => {
  keepExitCode(t);
  const result = await runWait(
    t,
    [aggregate("COMPLETED", "JUDGE_FAILED", true, 0, 0)],
    ["wait", "request-1", "--check"],
  );
  assert.equal(result.error, undefined);
  assert.equal(process.exitCode, 1);
  assert.equal(JSON.parse(result.stdout[0]).result, "JUDGE_FAILED");
  assert.deepEqual(result.stderr, []);
});

it("--check exits 0 for a passed verdict", async (t) => {
  keepExitCode(t);
  await runWait(
    t,
    [aggregate("COMPLETED", "PASSED", true, 1, 1)],
    ["wait", "request-1", "--check"],
  );
  assert.equal(process.exitCode, undefined);
});

it("status prints one snapshot without polling", async (t) => {
  keepExitCode(t);
  const result = await runWait(
    t,
    [aggregate("RUNNING", "PENDING", false, 0, 0, 0)],
    ["status", "request-1"],
  );
  assert.equal(result.error, undefined);
  assert.equal(result.calls.length, 1);
  assert.equal(JSON.parse(result.stdout[0]).settled, false);
  assert.equal(process.exitCode, undefined);
});

it("exits successfully for a completed advisory preference measurement", async (t) => {
  const result = await runWait(t, [
    aggregate("COMPLETED", "MEASURED", true, 1, 0),
  ]);
  assert.equal(result.error, undefined);
  assert.equal(JSON.parse(result.stdout[0]).result, "MEASURED");
});
