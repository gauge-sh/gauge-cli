import type {
  RunCompareResponse,
  RunCompareSide,
  RunCompareStats,
} from "@withgauge/api-schemas/runs";
import type { Agent } from "@withgauge/api-schemas/runs";
import { CliError } from "./client";
import { parseAgents } from "./flags";
import { type LocalRun, parseSince, type RunFilter } from "./localRuns";
import { printItems } from "./output";

const SIDE_KEYS = [
  "request",
  "batch",
  "eval",
  "revision",
  "experiment",
  "trial",
  "agent",
  "model",
  "since",
  "until",
] as const;

const SELECTING_KEYS = new Set([
  "request",
  "batch",
  "eval",
  "experiment",
  "trial",
]);

function csv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function parseCompareSide(
  flag: string,
  pairs: string[],
): RunCompareSide {
  const side: RunCompareSide = {};
  const seen = new Set<string>();
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    const key = eq < 0 ? "" : pair.slice(0, eq).trim();
    const value = eq < 0 ? "" : pair.slice(eq + 1).trim();
    if (!(SIDE_KEYS as readonly string[]).includes(key) || !value)
      throw new CliError(
        "usage",
        `invalid ${flag} "${pair}" (expected key=value with key one of ${SIDE_KEYS.join(", ")})`,
      );
    if (seen.has(key) && key !== "batch")
      throw new CliError("usage", `${flag} ${key}= given twice`);
    seen.add(key);
    if (key === "request") side.runRequest = value;
    else if (key === "batch")
      side.batch = [...(side.batch ?? []), ...csv(value)];
    else if (key === "eval") side.evalSet = value;
    else if (key === "revision") side.evalRevision = value;
    else if (key === "experiment") side.experiment = value;
    else if (key === "trial") side.trial = value;
    else if (key === "agent") side.agent = parseAgents(value);
    else if (key === "model") side.model = csv(value);
    else if (key === "since") side.since = value;
    else side.until = value;
  }
  if (![...seen].some((key) => SELECTING_KEYS.has(key)))
    throw new CliError(
      "usage",
      `${flag} needs request=, batch=, eval=, experiment=, or trial= to select runs`,
    );
  return side;
}

function pct(rate: number | null): string {
  return rate === null ? "" : `${Math.round(rate * 100)}%`;
}

function passCell(stats: RunCompareStats): string {
  return stats.judged === 0
    ? ""
    : `${pct(stats.passRate)} (${stats.passed}/${stats.judged})`;
}

function signed(value: number | null, format: (v: number) => string): string {
  if (value === null) return "";
  return `${value > 0 ? "+" : value < 0 ? "-" : "±"}${format(Math.abs(value))}`;
}

const points = (rate: number) => `${Math.round(rate * 100)}pp`;
const turns = (n: number) => String(Math.round(n * 10) / 10);
const usd = (n: number) => `$${n.toFixed(2)}`;
const secs = (ms: number) => `${Math.round(ms / 1000)}s`;

function pair(
  before: number | null,
  after: number | null,
  delta: number | null,
  format: (v: number) => string,
): string {
  if (before === null && after === null) return "";
  const side = (v: number | null) => (v === null ? "—" : format(v));
  return `${side(before)} → ${side(after)}${delta === null ? "" : ` (${signed(delta, format)})`}`;
}

function row(
  target: string,
  item: RunCompareResponse["overall"],
): Record<string, string | number> {
  const { baseline: a, candidate: b, delta } = item;
  return {
    target,
    runs: `${a.runs} → ${b.runs}`,
    completed: `${a.succeeded}/${a.runs} → ${b.succeeded}/${b.runs}`,
    baseline: passCell(a),
    candidate: passCell(b),
    "Δ pass": signed(delta.passRate, points),
    turns: pair(a.medianTurns, b.medianTurns, delta.medianTurns, turns),
    cost: pair(a.medianUsdCost, b.medianUsdCost, delta.medianUsdCost, usd),
    duration: pair(
      a.medianDurationMs,
      b.medianDurationMs,
      delta.medianDurationMs,
      secs,
    ),
  };
}

export function compareWarnings(result: RunCompareResponse): string[] {
  const warnings: string[] = [];
  for (const name of ["baseline", "candidate"] as const) {
    const side = result.sides[name];
    const stats = result.overall[name];
    if (stats.runs === 0)
      warnings.push(
        `${name} matched no runs. Check its selectors; optimization trial runs need trial=<trialId>.`,
      );
    else if (stats.finished < stats.runs)
      warnings.push(
        `${name} has ${stats.runs - stats.finished} of ${stats.runs} runs still in progress, so its numbers are partial. Run \`gauge run wait <request-id>\` first.`,
      );
    if (stats.judged < stats.finished)
      warnings.push(
        `${name} has ${stats.finished - stats.judged} finished runs without a verdict (not judged yet, or no criteria). Its pass rate covers judged runs only.`,
      );
    for (const mixed of side.mixedRevisions ?? [])
      warnings.push(
        `${name}: ${mixed.evalSetId ? `eval ${mixed.evalSetId}` : `case prompt ${mixed.promptId}`} ran under ${mixed.revisions.length} revisions (${mixed.revisions.join(", ")}): it was edited between runs. Add --${name} revision=<hash> to pick one.`,
      );
    if (side.truncated)
      warnings.push(
        `${name} matched too many runs; only the newest were compared. Narrow it with since=, until=, or batch=.`,
      );
  }
  return warnings;
}

export function printComparison(result: RunCompareResponse): void {
  const revisions = (name: "baseline" | "candidate") =>
    result.sides[name].evalRevisions.join(", ") || "—";
  console.log(
    `Baseline revision: ${revisions("baseline")}. Candidate revision: ${revisions("candidate")}.`,
  );
  for (const name of ["baseline", "candidate"] as const) {
    for (const trial of result.sides[name].trials ?? [])
      console.log(
        `${name}: ${trial.runs} run${trial.runs === 1 ? "" : "s"} from optimization trial ${trial.key} "${trial.title}" (${trial.kind}).`,
      );
  }
  console.log("Medians are baseline → candidate (difference).");
  console.log("");
  printItems(
    [
      row("all", result.overall),
      ...result.targets.map((target) =>
        row(`${target.agent} ${target.model || "(default)"}`, target),
      ),
    ],
    "table",
  );
  const before = new Map(
    result.overall.baseline.criteria.map((c) => [c.name, c]),
  );
  const after = new Map(
    result.overall.candidate.criteria.map((c) => [c.name, c]),
  );
  if (result.overall.delta.criteria.length > 0) {
    console.log("");
    printItems(
      result.overall.delta.criteria.map((c) => {
        const a = before.get(c.name);
        const b = after.get(c.name);
        return {
          criterion: c.name,
          baseline:
            a && a.judged > 0
              ? `${pct(a.passRate)} (${a.passed}/${a.judged})`
              : "",
          candidate:
            b && b.judged > 0
              ? `${pct(b.passRate)} (${b.passed}/${b.judged})`
              : "",
          "Δ pass": signed(c.passRate, points),
        };
      }),
      "table",
    );
  }
}

const LOCAL_AGENTS = new Set<Agent>([
  "CLAUDE_CODE",
  "CODEX_CLI",
  "CURSOR",
  "PI",
  "OPENCODE",
]);
const LOCAL_TERMINAL_STATES = new Set([
  "completed",
  "failed",
  "canceled",
  "interrupted",
]);

export function localCompareFilter(
  flag: string,
  side: RunCompareSide,
): RunFilter {
  const hostedOnly = [
    side.runRequest !== undefined && "request=",
    side.experiment !== undefined && "experiment=",
    side.trial !== undefined && "trial=",
  ].filter(Boolean);
  if (hostedOnly.length > 0)
    throw new CliError(
      "usage",
      `${flag} ${hostedOnly.join(", ")} select hosted runs; local sides take batch=, eval=<saved id>, revision=<number>, agent=, model=, since=, until=`,
    );
  if ((side.batch?.length ?? 0) > 1)
    throw new CliError("usage", `${flag} takes one batch= locally`);
  if ((side.agent?.length ?? 0) > 1 || (side.model?.length ?? 0) > 1)
    throw new CliError(
      "usage",
      `${flag} takes one agent= and one model= locally`,
    );
  if (side.evalRevision !== undefined && !/^[1-9]\d*$/.test(side.evalRevision))
    throw new CliError(
      "usage",
      `${flag} local revision= must be a positive integer`,
    );
  return {
    batch: side.batch?.[0],
    evalId: side.evalSet,
    measurementRevision:
      side.evalRevision === undefined ? undefined : Number(side.evalRevision),
    agent: side.agent?.[0],
    model: side.model?.[0],
    since: side.since
      ? parseSince(side.since, Date.now(), "since=")
      : undefined,
    until: side.until
      ? parseSince(side.until, Date.now(), "until=")
      : undefined,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function localStats(runs: LocalRun[]): RunCompareStats {
  const judged = runs.filter(
    (run) =>
      run.criterionResults?.length &&
      run.criterionResults.every(
        (criterion) => criterion.outcome !== "UNASSESSABLE",
      ),
  );
  const passed = judged.filter((run) =>
    run.criterionResults!.every((criterion) => criterion.outcome === "PASS"),
  ).length;
  const byCriterion = new Map<
    string,
    { name: string; judged: number; passed: number }
  >();
  for (const run of runs)
    for (const criterion of run.criterionResults ?? []) {
      const current = byCriterion.get(criterion.name) ?? {
        name: criterion.name,
        judged: 0,
        passed: 0,
      };
      if (criterion.outcome !== "UNASSESSABLE") {
        current.judged++;
        if (criterion.outcome === "PASS") current.passed++;
      }
      byCriterion.set(criterion.name, current);
    }
  const recorded = (values: (number | null | undefined)[]) =>
    values.filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    );
  return {
    runs: runs.length,
    finished: runs.filter((run) => LOCAL_TERMINAL_STATES.has(run.outcome))
      .length,
    succeeded: runs.filter((run) => run.outcome === "completed").length,
    judged: judged.length,
    passed,
    passRate: judged.length ? passed / judged.length : null,
    medianTurns: median(recorded(runs.map((run) => run.turns))),
    medianUsdCost: null,
    medianDurationMs: median(recorded(runs.map((run) => run.durationMs))),
    criteria: [...byCriterion.values()].map((criterion) => ({
      ...criterion,
      passRate: criterion.judged ? criterion.passed / criterion.judged : null,
    })),
  };
}

function diff(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : b - a;
}

function localRow(
  baseline: LocalRun[],
  candidate: LocalRun[],
): RunCompareResponse["overall"] {
  const a = localStats(baseline);
  const b = localStats(candidate);
  return {
    baseline: a,
    candidate: b,
    delta: {
      passRate: diff(a.passRate, b.passRate),
      medianTurns: diff(a.medianTurns, b.medianTurns),
      medianUsdCost: null,
      medianDurationMs: diff(a.medianDurationMs, b.medianDurationMs),
      criteria: [
        ...new Set(
          [...a.criteria, ...b.criteria].map((criterion) => criterion.name),
        ),
      ].map((name) => ({
        name,
        passRate: diff(
          a.criteria.find((criterion) => criterion.name === name)?.passRate ??
            null,
          b.criteria.find((criterion) => criterion.name === name)?.passRate ??
            null,
        ),
      })),
    },
  };
}

export function compareLocalRuns(
  baseline: LocalRun[],
  candidate: LocalRun[],
): RunCompareResponse {
  const targets = new Map<string, { agent: Agent; model: string }>();
  for (const run of [...baseline, ...candidate]) {
    const agent = LOCAL_AGENTS.has(run.agent as Agent)
      ? (run.agent as Agent)
      : undefined;
    if (agent)
      targets.set(`${run.agent} ${run.model}`, { agent, model: run.model });
  }
  const forTarget = (runs: LocalRun[], key: string) =>
    runs.filter((run) => `${run.agent} ${run.model}` === key);
  return {
    overall: localRow(baseline, candidate),
    targets: [...targets].map(([key, target]) => ({
      ...target,
      ...localRow(forTarget(baseline, key), forTarget(candidate, key)),
    })),
    sides: {
      baseline: localRevisionMetadata(baseline),
      candidate: localRevisionMetadata(candidate),
    },
  };
}

function localRevisionMetadata(
  runs: LocalRun[],
): RunCompareResponse["sides"]["baseline"] {
  const byMeasurement = new Map<string, Set<string>>();
  const allRevisions = new Set<string>();
  for (const run of runs) {
    if (
      run.measurementRevision === undefined ||
      run.measurementRevision === null
    )
      continue;
    const revision = String(run.measurementRevision);
    allRevisions.add(revision);
    if (run.evalId) {
      const revisions = byMeasurement.get(run.evalId) ?? new Set<string>();
      revisions.add(revision);
      byMeasurement.set(run.evalId, revisions);
    }
  }
  return {
    evalRevisions: [...allRevisions].sort((a, b) => Number(a) - Number(b)),
    mixedRevisions: [...byMeasurement]
      .filter(([, revisions]) => revisions.size > 1)
      .map(([evalSetId, revisions]) => ({
        evalSetId,
        promptId: null,
        revisions: [...revisions],
      })),
    truncated: false,
  };
}

export function localCompareWarnings(result: RunCompareResponse): string[] {
  const warnings = compareWarnings(result)
    .filter((warning) => !warning.includes("matched no runs"))
    .map((warning) =>
      warning
        .replace(
          "gauge run wait <request-id>",
          "gauge run wait --batch <batch-id> --local",
        )
        .replace("revision=<hash>", "revision=<number>")
        .replace(
          "not judged yet, or no criteria",
          "analysis missing, unassessable criteria, or no criteria",
        ),
    );
  for (const name of ["baseline", "candidate"] as const)
    if (result.overall[name].runs === 0)
      warnings.unshift(
        `${name} matched no local runs. Check its selectors: batch=, eval=<saved id>, revision=<number>, agent=, model=, since=, until=. \`gauge run list --local\` shows the values.`,
      );
  return warnings;
}
