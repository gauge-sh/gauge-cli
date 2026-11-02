import { existsSync, statSync } from "node:fs";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getSessionStatus, SessionUnavailableError, stopSession } from "@withgauge/local-execution";
import { CliError } from "./client";
import { openLocalStore } from "./localStore";

export function localId(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id))
    throw new CliError("usage", "Invalid local ID");
  return id;
}
export const batchDirectory = (gaugeDir: string, id: string) =>
  join(gaugeDir, "batches", localId(id));
export const cancellationRequested = (directory: string) =>
  existsSync(join(directory, "cancel"));

async function directories(path: string): Promise<string[]> {
  try {
    if (!(await lstat(path)).isDirectory()) return [];
    return (await readdir(path, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function localSessions(gaugeDir: string) {
  const sessions: { id: string; batchId: string; directory: string }[] = [];
  for (const id of await directories(join(gaugeDir, "runs"))) {
    const attempts = join(gaugeDir, "runs", id, "attempts");
    for (const n of await directories(attempts)) {
      const attempt = join(attempts, n);
      try {
        if (!(await lstat(join(attempt, "spec.json"))).isFile()) continue;
        const spec = JSON.parse(
          await readFile(join(attempt, "spec.json"), "utf8"),
        );
        if (
          spec.attempt?.runId !== id ||
          String(spec.attempt.n) !== n ||
          typeof spec.attempt.batchId !== "string"
        )
          continue;
        const directory = join(attempt, "session");
        if (existsSync(directory) && !(await lstat(directory)).isDirectory())
          continue;
        sessions.push({ id, batchId: spec.attempt.batchId, directory });
      } catch (error) {
        if (
          !(error instanceof SyntaxError) &&
          (error as NodeJS.ErrnoException).code !== "ENOENT"
        )
          throw error;
      }
    }
  }
  return sessions;
}

async function resultDetail(directory: string): Promise<string | undefined> {
  try {
    const result = JSON.parse(
      await readFile(join(directory, "..", "result.json"), "utf8"),
    );
    return typeof result.detail === "string" ? result.detail : undefined;
  } catch {
    return;
  }
}

function stderrLog(directory: string, state: string): string | undefined {
  if (state !== "failed") return;
  const path = join(directory, "agent.stderr.log");
  try {
    return statSync(path).size ? path : undefined;
  } catch {
    return;
  }
}

export async function localStatus(
  gaugeDir: string,
  filter: { id?: string; batch?: string } = {},
) {
  const sessions = (await localSessions(gaugeDir)).filter(
    (s) =>
      (!filter.id || s.id === filter.id) &&
      (!filter.batch || s.batchId === filter.batch),
  );
  return Promise.all(
    sessions.map(async (session) => {
      try {
        const status = await getSessionStatus(session.directory, { timeoutMs: 1_000 });
        return {
          id: session.id,
          batchId: session.batchId,
          state: status.state,
          turns: status.turn,
          cleanupPending: status.cleanupPending ?? false,
          detail: status.detail ?? (await resultDetail(session.directory)),
          stderrLog: stderrLog(session.directory, status.state),
        };
      } catch (error) {
        try {
          const result = JSON.parse(
            await readFile(
              join(session.directory, "..", "result.json"),
              "utf8",
            ),
          );
          return {
            id: session.id,
            batchId: session.batchId,
            state: result.outcome,
            turns: result.turns,
            detail: result.detail,
            stderrLog: stderrLog(session.directory, result.outcome),
          };
        } catch {
        }

        return {
          id: session.id,
          batchId: session.batchId,
          state: "unavailable",
          lastKnownState: error instanceof SessionUnavailableError ? error.lastKnownStatus?.state : undefined,
          turns: error instanceof SessionUnavailableError ? error.lastKnownStatus?.turn : undefined,
          detail: String(error),
          stderrLog: undefined,
        };
      }
    }),
  );
}

export async function cancelLocal(
  gaugeDir: string,
  filter: { id?: string; batch?: string },
) {
  if (Boolean(filter.id) === Boolean(filter.batch))
    throw new CliError("usage", "Pass a run ID or --batch <batch-id>");
  if (filter.id) localId(filter.id);
  if (filter.batch) localId(filter.batch);
  const sessions = (await localSessions(gaugeDir)).filter((s) =>
    filter.id ? s.id === filter.id : s.batchId === filter.batch,
  );
  if (filter.batch) {
    const directory = batchDirectory(gaugeDir, filter.batch);
    if (existsSync(directory)) {
      if (!(await lstat(directory)).isDirectory())
        throw new CliError("usage", "Cannot cancel this batch because its folder is a symbolic link.", { hint: "Run the command from the original Gauge workspace." });
      await writeFile(join(directory, "cancel"), "", { mode: 0o600 });
    } else if (!sessions.length)
      throw new CliError("not_found", "Local batch not found");
  } else if (!sessions.length)
    throw new CliError("not_found", "Local run not found");
  for (const session of sessions)
    await writeFile(join(session.directory, "..", "cancel"), "", {
      mode: 0o600,
    });
  return Promise.all(
    sessions.map(async (session) => {
      try {
        await stopSession(session.directory);
        return { id: session.id, status: "stopped" };
      } catch (error) {
        return { id: session.id, status: "pending", detail: String(error) };
      }
    }),
  );
}

export async function cleanupLocal(gaugeDir: string) {
  const results: { id: string; status: string; detail?: string }[] = [];
  for (const session of await localSessions(gaugeDir)) {
    if (!existsSync(join(session.directory, "session.json"))) continue;
    try {
      const status = await getSessionStatus(session.directory);
      if (status.state !== "interrupted" && !status.cleanupPending) continue;
      await stopSession(session.directory);
      const final = await getSessionStatus(session.directory);
      try {
        await writeFile(
          join(session.directory, "..", "result.json"),
          JSON.stringify({
            outcome: final.state,
            endedBy: "recovery",
            turns: final.turn,
            endedAt: final.updatedAt,
            detail: final.detail,
          }) + "\n",
          { flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const store = openLocalStore(gaugeDir);
      try {
        const { skipped } = store.repairSessionSummaries([session.id]);
        if (skipped.length) throw new Error(skipped.join("; "));
      } finally {
        store.close();
      }
      results.push({ id: session.id, status: "cleaned" });
    } catch (error) {
      results.push({ id: session.id, status: "error", detail: String(error) });
    }
  }
  return results;
}

export async function localBatchStatus(gaugeDir: string, id: string) {
  const directory = batchDirectory(gaugeDir, id);
  const status = JSON.parse(
    await readFile(join(directory, "status.json"), "utf8"),
  );
  if (status.state === "running" || status.state === "queued") {
    // Batches have no controller endpoint. A saved PID cannot establish liveness
    // for a caller in another namespace; retain the recorded progress as history.
    status.lastKnownState = status.state;
    status.state = "unavailable";
    status.detail = "Batch supervisor status is unavailable; showing last recorded progress.";
  }
  return { ...status, cancelRequested: cancellationRequested(directory) };
}
