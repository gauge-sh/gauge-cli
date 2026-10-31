import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openLocalStore } from "./localStore";
import {
  getWatchEval,
  getWatchSession,
  listWatchEvals,
  listWatchSessions,
  readWatchDiff,
  readWatchTrace,
} from "./watchData";
import { createWatchServer, listenOnFreePort } from "./watchServer";

async function attempt(root: string, id: string, n: number, spec: Record<string, unknown>) {
  const directory = join(root, "runs", id, "attempts", String(n));
  await mkdir(join(directory, "session"), { recursive: true });
  await writeFile(
    join(directory, "spec.json"),
    JSON.stringify({ attempt: { runId: id, n, batchId: "b_one" }, ...spec }),
  );
  return directory;
}

test("watch data lists the latest attempt, flags live sessions, and reads traces incrementally", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "watch-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const done = await attempt(root, "r_done", 1, {
    createdAt: "2026-10-01T00:00:00.000Z",
    agentName: "CLAUDE_CODE",
    agent: { kind: "claude-code", model: "opus" },
    case: { path: "cases/a.md", prompt: "Do A", criteria: [{ text: "A done" }] },
  });
  await writeFile(
    join(done, "result.json"),
    JSON.stringify({ outcome: "completed", turns: 2, durationMs: 1000, endedAt: "2026-10-01T00:00:01.000Z" }),
  );
  await writeFile(join(done, "session/diff.patch"), "+line\n");
  await attempt(root, "r_live", 1, { createdAt: "2026-10-02T00:00:00.000Z" });
  const retry = await attempt(root, "r_live", 2, {
    createdAt: "2026-10-02T00:00:00.000Z",
    case: { path: "cases/b.md", prompt: "Do B" },
  });
  await writeFile(
    join(retry, "session/status.json"),
    JSON.stringify({ state: "running", turn: 1, driverPid: process.pid, updatedAt: "2026-10-02T00:00:02.000Z" }),
  );
  await writeFile(
    join(retry, "session/events.ndjson"),
    [0, 1]
      .map((seq) => JSON.stringify({ seq, turn: 1, observedAt: `2026-10-02T00:00:0${seq + 1}.000Z`, payload: { type: "agent_message", text: `m${seq}` } }))
      .join("\n") + '\n{"seq":2,',
  );
  await writeFile(
    join(retry, "session/inputs.ndjson"),
    JSON.stringify({ turn: 0, observedAt: "2026-10-02T00:00:00.500Z", text: "Do B" }) + "\n",
  );

  const sessions = await listWatchSessions(root);
  assert.deepEqual(sessions.map((s) => [s.id, s.attempt, s.state, s.live]), [
    ["r_live", 2, "running", true],
    ["r_done", 1, "completed", false],
  ]);
  assert.equal(sessions[1].agent, "CLAUDE_CODE");
  assert.equal((await getWatchSession(root, "r_done"))?.prompt, "Do A");
  assert.equal(await getWatchSession(root, "r_missing"), undefined);

  const trace = await readWatchTrace(root, "r_live");
  assert.deepEqual(trace?.events.map((e) => e.seq), [0, 1]);
  assert.deepEqual(trace?.inputs, [{ turn: 0, observedAt: "2026-10-02T00:00:00.500Z", text: "Do B" }]);
  assert.deepEqual((await readWatchTrace(root, "r_live", 0))?.events.map((e) => e.seq), [1]);
  assert.equal(await readWatchDiff(root, "r_done"), "+line\n");
  assert.equal(await readWatchDiff(root, "r_live"), "");

  await writeFile(
    join(retry, "session/status.json"),
    JSON.stringify({ state: "running", turn: 1, driverPid: 2 ** 30, updatedAt: "2026-10-02T00:00:02.000Z" }),
  );
  await writeFile(join(retry, "session/session.json"), "{}");
  const [orphan] = await listWatchSessions(root);
  assert.equal(orphan.state, "interrupted");
  assert.equal(orphan.live, false);
});

test("watch evals report pass rates per revision from graded sessions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "watch-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = openLocalStore(root);
  const criteria = [
    { id: "c1", name: "Builds", rubric: "It builds" },
    { id: "c2", name: "Tests", rubric: "Tests pass" },
  ];
  const { id } = store.createMeasurement("eval", { name: "Setup", promptText: "Set it up", criteria });
  store.updateMeasurement(id, { promptText: "Set it up again" });
  const run = (runId: string, revision: number, grades?: Record<string, string>) => {
    store.upsertSession({
      id: runId, batchId: "b", measurementId: id, measurementKind: "eval", measurementRevision: revision,
      case: null, agent: "CLAUDE_CODE", model: "opus", attempt: 1, outcome: "completed", endedBy: null,
      turns: 1, createdAt: `2026-10-0${revision}T00:00:00.000Z`, endedAt: null,
    });
    if (!grades) return;
    store.db
      .prepare("INSERT INTO session_analyses VALUES (?,?,1,1,1,'v','d','{}','2026-10-03T00:00:00.000Z')")
      .run(`a_${runId}`, runId);
    for (const [criterion, outcome] of Object.entries(grades))
      store.db.prepare("INSERT INTO criterion_results VALUES (?,?,?,'x','[]')").run(`a_${runId}`, criterion, outcome);
    store.db.prepare("UPDATE sessions SET current_analysis_id = ? WHERE id = ?").run(`a_${runId}`, runId);
  };
  run("r_old", 1, { c1: "FAIL", c2: "FAIL" });
  run("r_pass", 2, { c1: "PASS", c2: "UNASSESSABLE" });
  run("r_fail", 2, { c1: "PASS", c2: "FAIL" });
  run("r_ungraded", 2);
  store.close();

  const [summary] = listWatchEvals(root);
  assert.deepEqual(
    { name: summary.name, revision: summary.revision, criteria: summary.criteria, sessions: summary.sessions, analyzed: summary.analyzed, passed: summary.passed },
    { name: "Setup", revision: 2, criteria: 2, sessions: 3, analyzed: 2, passed: 1 },
  );
  const detail = getWatchEval(root, id)!;
  assert.deepEqual(detail.revisions.map((r) => [r.revision, r.promptText]), [[2, "Set it up again"], [1, "Set it up"]]);
  assert.equal(detail.runs.length, 4);
  assert.equal(detail.runs.find((r) => r.id === "r_fail")?.results?.c2.outcome, "FAIL");
  assert.equal(detail.runs.find((r) => r.id === "r_ungraded")?.results, null);
  assert.equal(getWatchEval(root, "ev_missing"), undefined);
});

test("port probing skips busy ports; the server refuses foreign hosts and serves the API", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "watch-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const blocker = createServer();
  const busy = await listenOnFreePort(blocker, 41000, 100);
  t.after(() => blocker.close());
  const server = createWatchServer(root, "test");
  const port = await listenOnFreePort(server, busy, 100);
  t.after(() => server.close());
  assert.ok(port > busy);

  const base = `http://127.0.0.1:${port}`;
  assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { gauge: "watch", version: "test", gaugeDir: root });
  assert.deepEqual(await (await fetch(`${base}/api/sessions`)).json(), { sessions: [] });
  assert.equal((await fetch(`${base}/api/sessions/r_missing`)).status, 404);
  assert.deepEqual(await (await fetch(`${base}/api/evals`)).json(), { evals: [] });
  assert.equal((await fetch(`${base}/api/evals/ev_missing`)).status, 404);
  assert.match(await (await fetch(base)).text(), /<title>Gauge watch<\/title>/);
  const script = await fetch(`${base}/app.js`);
  assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.match(await script.text(), /function renderTrace/);
  assert.equal((await fetch(`${base}/logo-for-dark.png`)).headers.get("content-type"), "image/png");
  const foreign = await new Promise<number>((resolve, reject) => {
    import("node:http").then(({ request }) =>
      request({ host: "127.0.0.1", port, path: "/api/sessions", headers: { host: "evil.example" } }, (res) => resolve(res.statusCode ?? 0))
        .on("error", reject)
        .end(),
    );
  });
  assert.equal(foreign, 403);
});
