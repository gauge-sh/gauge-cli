import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { localSessions } from "./localLifecycle";
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

async function readJson(path: string): Promise<Record<string, any> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function readLines(path: string): Promise<Record<string, any>[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const lines: Record<string, any>[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      // A writer may be mid-append; the next poll sees the complete line.
    }
  }
  return lines;
}

function alive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function latestAttempts(gaugeDir: string) {
  const latest = new Map<string, { batchId: string; directory: string; attempt: number }>();
  for (const session of await localSessions(gaugeDir)) {
    const attempt = Number(basename(dirname(session.directory)));
    const previous = latest.get(session.id);
    if (!previous || attempt > previous.attempt)
      latest.set(session.id, { ...session, attempt });
  }
  return latest;
}

function storeRows(gaugeDir: string) {
  if (!existsSync(join(gaugeDir, "gauge.sqlite"))) return new Map();
  try {
    const store = openLocalStore(gaugeDir);
    try {
      return new Map(store.listSessions().map((row) => [row.id, row]));
    } finally {
      store.close();
    }
  } catch {
    return new Map();
  }
}

async function summarize(
  id: string,
  { batchId, directory, attempt }: { batchId: string; directory: string; attempt: number },
  row: Record<string, any> | undefined,
): Promise<{ session: WatchSession; spec: Record<string, any> }> {
  const attemptDir = dirname(directory);
  const [spec = {}, status, result] = await Promise.all([
    readJson(join(attemptDir, "spec.json")),
    readJson(join(directory, "status.json")),
    readJson(join(attemptDir, "result.json")),
  ]);
  let state: string = result?.outcome ?? status?.state ?? "preparing";
  if (!result && status && !TERMINAL.has(status.state) && !alive(status.driverPid))
    state = "interrupted";
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
      live: !result && !TERMINAL.has(state),
      turns: result?.turns ?? status?.turn ?? 0,
      detail: result?.detail ?? status?.detail ?? null,
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

async function findAttempt(gaugeDir: string, id: string) {
  return (await latestAttempts(gaugeDir)).get(id);
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
