import { existsSync, statSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getSessionStatus, SessionUnavailableError } from "@withgauge/local-execution";
import { localId } from "./localLifecycle";
import { openLocalStore } from "./localStore";

const TERMINAL = new Set(["completed", "failed", "canceled", "interrupted"]);

export type WatchSession = {
  id: string;
  batchId: string;
  attempt: number;
  case: string | null;
  agent: string | null;
  model: string | null;
  sample: number | null;
  measurement: { id: string; kind: string; revision: number } | null;
  state: string;
  lastKnownState: string | null;
  live: boolean;
  turns: number;
  detail: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  analyzed: boolean;
};

export type WatchSessionDetail = WatchSession & {
  prompt: string | null;
  criteria: unknown;
  preference: unknown;
};

export type WatchTrace = {
  events: { seq: number; turn: number; observedAt: string; payload: unknown }[];
  inputs: { turn: number; observedAt: string; text?: string; answer?: unknown }[];
};

export async function readJson(path: string): Promise<Record<string, any> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

type Lines = { bytes: number; lines: Record<string, any>[] };
const lineCache = new Map<string, Lines>();

async function readLines(path: string): Promise<Record<string, any>[]> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    lineCache.delete(path);
    return [];
  }
  let cached = lineCache.get(path);
  if (!cached || size < cached.bytes) cached = { bytes: 0, lines: [] };
  if (size > cached.bytes) {
    const buffer = Buffer.alloc(size - cached.bytes);
    const file = await open(path, "r");
    try {
      await file.read(buffer, 0, buffer.length, cached.bytes);
    } finally {
      await file.close();
    }
    // A writer may be mid-append; the trailing partial line waits for the next poll.
    const complete = buffer.lastIndexOf(10) + 1;
    const lines = [...cached.lines];
    for (const line of buffer.subarray(0, complete).toString("utf8").split("\n")) {
      if (!line) continue;
      try {
        lines.push(JSON.parse(line));
      } catch {}
    }
    cached = { bytes: cached.bytes + complete, lines };
  }
  lineCache.set(path, cached);
  return cached.lines;
}

type Attempt = { batchId: string; directory: string; attempt: number };

const specCache = new Map<string, { mtimeMs: number; spec: Record<string, any> | undefined }>();

async function readSpec(attemptDir: string) {
  const path = join(attemptDir, "spec.json");
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
  const cached = specCache.get(path);
  if (cached?.mtimeMs === mtimeMs) return cached.spec;
  const spec = await readJson(path);
  specCache.set(path, { mtimeMs, spec });
  return spec;
}

async function names(path: string) {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

async function latestAttempt(gaugeDir: string, id: string): Promise<Attempt | undefined> {
  const attempts = join(gaugeDir, "runs", id, "attempts");
  const numbers = (await names(attempts)).map(Number).filter(Number.isSafeInteger);
  for (const n of numbers.sort((a, b) => b - a)) {
    const spec = await readSpec(join(attempts, String(n)));
    if (spec?.attempt?.runId !== id || spec.attempt.n !== n || typeof spec.attempt.batchId !== "string")
      continue;
    return { batchId: spec.attempt.batchId, directory: join(attempts, String(n), "session"), attempt: n };
  }
  return undefined;
}

async function latestAttempts(gaugeDir: string) {
  const ids = await names(join(gaugeDir, "runs"));
  const found = await Promise.all(ids.map((id) => latestAttempt(gaugeDir, id)));
  return new Map(
    ids.flatMap((id, i) => (found[i] ? [[id, found[i]] as const] : [])),
  );
}

let rowCache: { key: string; rows: Map<string, Record<string, any>> } | undefined;

function storeRows(gaugeDir: string): Map<string, Record<string, any>> {
  const path = join(gaugeDir, "gauge.sqlite");
  if (!existsSync(path)) return new Map();
  const key = [path, `${path}-wal`]
    .map((file) => {
      try {
        const { mtimeMs, size } = statSync(file);
        return `${mtimeMs}:${size}`;
      } catch {
        return "";
      }
    })
    .join("|");
  if (rowCache?.key === key) return rowCache.rows;
  try {
    const store = openLocalStore(gaugeDir);
    try {
      rowCache = { key, rows: new Map(store.listSessions().map((row) => [row.id, row])) };
      return rowCache.rows;
    } finally {
      store.close();
    }
  } catch {
    return new Map();
  }
}

async function summarize(
  id: string,
  { batchId, directory, attempt }: Attempt,
  row: Record<string, any> | undefined,
): Promise<{ session: WatchSession; spec: Record<string, any> }> {
  const attemptDir = dirname(directory);
  let [spec = {}, status, result] = await Promise.all([
    readSpec(attemptDir),
    readJson(join(directory, "status.json")),
    readJson(join(attemptDir, "result.json")),
  ]);
  let state: string = result?.outcome ?? status?.state ?? "preparing";
  let lastKnownState: string | null = null;
  let unavailableDetail: string | undefined;
  if (!result && !TERMINAL.has(state)) {
    try {
      status = await getSessionStatus(directory, { timeoutMs: 1_000 });
      state = status.state;
    } catch (error) {
      if (error instanceof SessionUnavailableError) status = error.lastKnownStatus ?? status;
      // A failed preparation or a completed run may have published its result during the probe.
      result = await readJson(join(attemptDir, "result.json"));
      if (result) state = result.outcome;
      else {
        lastKnownState = status?.state ?? "preparing";
        state = "unavailable";
        unavailableDetail = "Controller status is unavailable; the session may still be running. Status will be checked again.";
      }
    }
  }
  const measurement = spec.measurement;
  return {
    spec,
    session: {
      id,
      batchId,
      attempt,
      case: spec.case?.path ?? row?.case ?? null,
      agent: spec.agentName ?? row?.agent ?? null,
      model: spec.agent?.model ?? row?.model ?? null,
      sample: typeof spec.sample === "number" ? spec.sample : null,
      measurement:
        measurement && typeof measurement.id === "string"
          ? { id: measurement.id, kind: measurement.kind, revision: measurement.revision }
          : null,
      state,
      lastKnownState,
      live: !result && state !== "unavailable" && !TERMINAL.has(state),
      turns: result?.turns ?? status?.turn ?? 0,
      detail: unavailableDetail ?? result?.detail ?? status?.detail ?? null,
      createdAt: spec.createdAt ?? row?.createdAt ?? null,
      updatedAt: status?.updatedAt ?? null,
      endedAt: result?.endedAt ?? null,
      durationMs: result?.durationMs ?? null,
      inputTokens: row?.inputTokens ?? null,
      outputTokens: row?.outputTokens ?? null,
      analyzed: row?.analyzed ?? false,
    },
  };
}

export async function listWatchSessions(gaugeDir: string): Promise<WatchSession[]> {
  const rows = storeRows(gaugeDir);
  const sessions = await Promise.all(
    [...(await latestAttempts(gaugeDir))].map(async ([id, attempt]) =>
      (await summarize(id, attempt, rows.get(id))).session,
    ),
  );
  return sessions.sort((a, b) =>
    (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || a.id.localeCompare(b.id),
  );
}

function findAttempt(gaugeDir: string, id: string) {
  return latestAttempt(gaugeDir, localId(id));
}

export async function getWatchSession(
  gaugeDir: string,
  id: string,
): Promise<WatchSessionDetail | undefined> {
  const attempt = await findAttempt(gaugeDir, id);
  if (!attempt) return undefined;
  const { session, spec } = await summarize(id, attempt, storeRows(gaugeDir).get(id));
  return {
    ...session,
    prompt: spec.case?.prompt ?? null,
    criteria: spec.case?.criteria ?? null,
    preference: spec.case?.preference ?? null,
  };
}

export async function readWatchTrace(
  gaugeDir: string,
  id: string,
  after = -1,
): Promise<WatchTrace | undefined> {
  const attempt = await findAttempt(gaugeDir, id);
  if (!attempt) return undefined;
  const [events, inputs] = await Promise.all([
    readLines(join(attempt.directory, "events.ndjson")),
    readLines(join(attempt.directory, "inputs.ndjson")),
  ]);
  return {
    events: events
      .filter((event) => event.seq > after)
      .map(({ seq, turn, observedAt, payload }) => ({ seq, turn, observedAt, payload })),
    inputs: inputs.map(({ turn, observedAt, text, answer }) =>
      typeof text === "string" ? { turn, observedAt, text } : { turn, observedAt, answer },
    ),
  };
}

export async function readWatchDiff(gaugeDir: string, id: string): Promise<string | undefined> {
  const attempt = await findAttempt(gaugeDir, id);
  if (!attempt) return undefined;
  try {
    return await readFile(join(attempt.directory, "diff.patch"), "utf8");
  } catch {
    return "";
  }
}
