import { openLocalStore } from "./localStore";
import { readCurrentAnalysis } from "./localAnalysis";
import { join } from "node:path";
import { CliError } from "./client";

export type LocalRun = {
  id: string;
  batchId: string;
  evalId: string | null;
  preferenceId?: string | null;
  measurementRevision?: number | null;
  createdAt?: string;
  case: string | null;
  agent: string;
  model: string;
  attempt: number;
  outcome: string;
  endedBy: string;
  turns: number | null;
  durationMs?: number | null;
  criterionResults?: {
    id: string;
    name: string;
    outcome: "PASS" | "FAIL" | "UNASSESSABLE";
  }[];
  endedAt: string;
  analyzed: boolean;
  attemptDir: string;
  resultsDir: string;
};

export type RunFilter = {
  ids?: string[];
  batch?: string;
  evalId?: string;
  preferenceId?: string;
  measurementRevision?: number;
  agent?: string;
  model?: string;
  outcome?: string;
  since?: Date;
  until?: Date;
  case?: string;
  analyzed?: boolean;
};

export function listLocalRuns(
  gaugeDir: string,
  filter: RunFilter = {},
): LocalRun[] {
  const store = openLocalStore(gaugeDir);
  try {
    return store
      .listSessions()
      .map(
        (session): LocalRun => ({
          ...session,
          evalId:
            session.measurementKind === "eval"
              ? (session.measurementId ?? null)
              : null,
          preferenceId:
            session.measurementKind === "preference"
              ? (session.measurementId ?? null)
              : null,
          endedBy: session.endedBy ?? "",
          endedAt: session.endedAt ?? "",
          attemptDir: join(
            gaugeDir,
            "runs",
            session.id,
            "attempts",
            String(session.attempt),
          ),
          resultsDir: join(gaugeDir, "runs", session.id, "results"),
        }),
      )
      .filter((run) => matches(run, filter))
      .map((run) => {
        const analysis = readCurrentAnalysis(store, run.id);
        if (!analysis) return run;
        const session = store.getSession(run.id)!;
        const item = session.configuration?.case as
          | { criteria?: { id: string; name?: string }[] }
          | undefined;
        const names = new Map(
          (item?.criteria ?? []).map((criterion) => [
            criterion.id,
            criterion.name,
          ]),
        );
        return {
          ...run,
          criterionResults: analysis.criteria.map((criterion) => ({
            id: criterion.criterionId,
            name: names.get(criterion.criterionId) ?? criterion.criterionId,
            outcome: criterion.outcome,
          })),
        };
      });
  } finally {
    store.close();
  }
}

function matches(run: LocalRun, filter: RunFilter): boolean {
  return (
    (!filter.ids?.length || filter.ids.includes(run.id)) &&
    (!filter.batch || run.batchId === filter.batch) &&
    (!filter.evalId || run.evalId === filter.evalId) &&
    (!filter.preferenceId || run.preferenceId === filter.preferenceId) &&
    (filter.measurementRevision === undefined ||
      run.measurementRevision === filter.measurementRevision) &&
    (!filter.agent || run.agent === filter.agent) &&
    (!filter.model || run.model === filter.model) &&
    (!filter.outcome || filter.outcome.split(",").includes(run.outcome)) &&
    (!filter.since ||
      Date.parse(run.createdAt ?? run.endedAt) >= filter.since.getTime()) &&
    (!filter.until ||
      Date.parse(run.createdAt ?? run.endedAt) <= filter.until.getTime()) &&
    (!filter.case || run.case === filter.case) &&
    (filter.analyzed === undefined || run.analyzed === filter.analyzed)
  );
}

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseSince(
  window: string,
  now = Date.now(),
  flag = "--since",
): Date {
  const relative = /^(\d+)([mhd])$/.exec(window.trim());
  if (relative)
    return new Date(now - Number(relative[1]) * UNIT_MS[relative[2]]);
  const at = Date.parse(window);
  if (Number.isNaN(at))
    throw new CliError(
      "usage",
      `invalid ${flag} "${window}" (expected 24h, 7d, or an ISO date)`,
    );
  return new Date(at);
}
