import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listWatchSessions } from "./lib/watchData";
import { createWatchServer, listenOnFreePort, WATCH_HOST } from "./lib/watchServer";

const IDLE_MS = 30 * 60_000;
const STALE_MS = 60 * 60_000;
const [gaugeDir, version] = process.argv.slice(2);
const statePath = join(gaugeDir, "watch.json");
let lastRequest = Date.now();

const server = createWatchServer(gaugeDir, version, () => {
  lastRequest = Date.now();
});
const port = await listenOnFreePort(server);
const url = `http://${WATCH_HOST}:${port}`;
await writeFile(
  `${statePath}.tmp`,
  JSON.stringify({ pid: process.pid, port, url, version, startedAt: new Date().toISOString() }),
  { mode: 0o600 },
);
await rename(`${statePath}.tmp`, statePath);
console.log(`Gauge watch listening on ${url}`);

async function shutdown() {
  try {
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    if (saved.pid === process.pid) await rm(statePath, { force: true });
  } catch {}
  server.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
setInterval(async () => {
  if (Date.now() - lastRequest < IDLE_MS) return;
  const sessions = await listWatchSessions(gaugeDir).catch(() => []);
  const active = sessions.some(
    (session) =>
      session.live &&
      Date.now() - Date.parse(session.updatedAt ?? session.createdAt ?? "") < STALE_MS,
  );
  if (!active) await shutdown();
}, 60_000).unref();
