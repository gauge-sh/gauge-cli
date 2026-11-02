import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getWatchSession, listWatchSessions, readWatchDiff, readWatchTrace } from "./watchData";
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
    JSON.stringify({ state: "preparing", turn: 0, driverPid: 2 ** 30, updatedAt: "2026-10-02T00:00:01.000Z" }),
  );
  const socketPath = join(root, "control.sock");
  await writeFile(join(retry, "session/session.json"), JSON.stringify({ version: 2, socketPath }));
  const controller = createSocketServer((socket) => socket.once("data", () => socket.end(JSON.stringify({
    state: "running", turn: 1, driverPid: 2 ** 30, updatedAt: "2026-10-02T00:00:02.000Z",
  }) + "\n")));
  await new Promise<void>((resolve, reject) => { controller.once("error", reject); controller.listen(socketPath, resolve); });
  t.after(() => { if (controller.listening) controller.close(); });
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
  await appendFile(join(retry, "session/events.ndjson"), '"turn":1,"observedAt":"x","payload":{}}\n');
  assert.deepEqual((await readWatchTrace(root, "r_live", 1))?.events.map((e) => e.seq), [2]);
  assert.equal(await readWatchDiff(root, "r_done"), "+line\n");
  assert.equal(await readWatchDiff(root, "r_live"), "");

  await writeFile(
    join(retry, "session/status.json"),
    JSON.stringify({ state: "running", turn: 1, driverPid: 2 ** 30, updatedAt: "2026-10-02T00:00:02.000Z" }),
  );
  await new Promise<void>((resolve) => controller.close(() => resolve()));
  const [orphan] = await listWatchSessions(root);
  assert.equal(orphan.state, "unavailable");
  assert.equal(orphan.lastKnownState, "running");
  assert.equal(orphan.live, false);

  await attempt(root, "r_queued", 1, { createdAt: "2026-10-03T00:00:00.000Z" });
  const batch = join(root, "batches", "b_one");
  await mkdir(batch, { recursive: true });
  await writeFile(join(batch, "status.json"), JSON.stringify({ state: "running", supervisorPid: process.pid }));
  assert.deepEqual(
    (await listWatchSessions(root)).filter((s) => s.id === "r_queued").map((s) => [s.state, s.live]),
    [["unavailable", false]],
  );
  await writeFile(join(batch, "status.json"), JSON.stringify({ state: "running", supervisorPid: 2 ** 30 }));
  assert.deepEqual(
    (await listWatchSessions(root)).filter((s) => s.id === "r_queued").map((s) => [s.state, s.live]),
    [["unavailable", false]],
  );
  // A later terminal record is observed despite the earlier failed probe.
  await writeFile(join(retry, "session/status.json"), JSON.stringify({ state: "interrupted", turn: 1 }));
  assert.equal((await getWatchSession(root, "r_live"))?.state, "interrupted");
  await writeFile(join(retry, "result.json"), JSON.stringify({ outcome: "completed", turns: 2 }));
  assert.equal((await getWatchSession(root, "r_live"))?.state, "completed");
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
