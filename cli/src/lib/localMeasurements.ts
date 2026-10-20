import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Command } from "commander";
import { createEvalSetBodySchema } from "@withgauge/api-schemas/evals";
import { createVisibilityPromptBodySchema } from "@withgauge/api-schemas/visibility";
import { CliError } from "./client";
import { assertLocalCapabilities } from "./localCapabilities";
import { gaugeState } from "./gaugeState";
import {
  openLocalStore,
  type LocalMeasurement,
  type MeasurementKind,
} from "./localStore";
import type { CaseSpec } from "./caseSpec";
import { runOverridesFromOpts } from "./ownedConfig";
import { readCurrentAnalysis } from "./localAnalysis";

type Criterion = { id: string; name: string; rubric: string };
type Scenario = {
  id: string;
  repoUrl: string | null;
  repoRef: string | null;
  profileId: null;
};

export function localDirectory(command: Command): string {
  const state = gaugeState(command);
  if (!state.root)
    throw new CliError(
      "usage",
      "No Gauge workspace found. Run `gauge init` in this directory first.",
    );
  if (state.config === null)
    throw new CliError("usage", "gauge.json is not valid JSON");
  return join(state.root, ".gauge");
}
export function isLocal(command: Command): boolean {
  return gaugeState(command).mode === "local";
}
export function withLocalStore<T>(
  command: Command,
  fn: (store: ReturnType<typeof openLocalStore>) => T,
): T {
  const store = openLocalStore(localDirectory(command));
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function normalize(
  kind: MeasurementKind,
  raw: Record<string, unknown>,
  previous?: LocalMeasurement,
): Record<string, unknown> & { name: string; promptText: string } {
  const { inputs, ...definition } = raw;
  const scenarioInputs = Array.isArray(definition.scenarios)
    ? (definition.scenarios as Record<string, unknown>[])
    : undefined;
  if (scenarioInputs)
    definition.scenarios = scenarioInputs.map(
      ({ id: _id, ...scenario }) => scenario,
    );
  const parsed = (
    kind === "eval" ? createEvalSetBodySchema : createVisibilityPromptBodySchema
  ).safeParse(definition);
  if (!parsed.success)
    throw new CliError(
      "usage",
      `Invalid ${kind}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  const value = parsed.data as Record<string, unknown> & {
    name: string;
    promptText: string;
  };
  value.name = value.name.trim();
  value.promptText = value.promptText.trim();
  if (!value.name || !value.promptText)
    throw new CliError(
      "usage",
      "A measurement needs a nonempty name and prompt.",
    );
  if (value.cadence && value.cadence !== "NONE")
    throw new CliError(
      "usage",
      "Local measurements do not support managed schedules. Use --cadence none or --hosted.",
    );
  if (value.nextRunAt)
    throw new CliError(
      "usage",
      "Local measurements do not support scheduled start times. Use --hosted.",
    );
  assertLocalCapabilities(value);
  if (
    inputs !== undefined &&
    (!Array.isArray(inputs) || inputs.some((x) => typeof x !== "string" || !x))
  )
    throw new CliError(
      "usage",
      "inputs must be an array of project input names",
    );
  value.inputs = [...new Set((inputs as string[] | undefined) ?? [])];
  value.tags = [
    ...new Set(
      ((value.tags as string[] | undefined) ?? [])
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
  if (kind === "eval") {
    if (value.repoRef && !value.repoUrl)
      throw new CliError(
        "usage",
        "A repository ref requires a repository URL.",
      );
    const ids = new Set<string>();
    const existing = new Set(
      (previous?.criteria as Criterion[] | undefined)?.map(
        (criterion) => criterion.id,
      ),
    );
    value.criteria = (
      value.criteria as { id?: string; name?: string; rubric: string }[]
    ).map((c) => {
      const rubric = c.rubric.trim();
      if (!rubric)
        throw new CliError("usage", "Every criterion needs a nonempty rubric.");
      if (c.id && previous && !existing.has(c.id))
        throw new CliError(
          "usage",
          `Unknown criterion ID: ${c.id}. Omit id to add a new criterion.`,
        );
      const id = c.id ?? `cr_${randomUUID()}`;
      if (!id || ids.has(id))
        throw new CliError("usage", `Duplicate or empty criterion ID: ${id}`);
      ids.add(id);
      return {
        id,
        name: c.name?.trim() || deriveCriterionName(rubric),
        rubric,
      };
    });
  } else {
    value.brandA =
      typeof value.brandA === "string" ? value.brandA.trim() || null : null;
    value.brandB =
      typeof value.brandB === "string" ? value.brandB.trim() || null : null;
    if (value.kind === "HEAD_TO_HEAD") {
      if (
        !value.brandA ||
        !value.brandB ||
        String(value.brandA).toLowerCase() ===
          String(value.brandB).toLowerCase()
      )
        throw new CliError(
          "usage",
          "Head-to-head preference needs two different --brand-a and --brand-b values",
        );
      [value.brandA, value.brandB] = [
        String(value.brandA),
        String(value.brandB),
      ].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    }
    value.branded = value.kind === "HEAD_TO_HEAD" || Boolean(value.branded);
    value.agents ??= [
      { agent: "CLAUDE_CODE", models: [] },
      { agent: "CODEX_CLI", models: [] },
    ];
    const scenarios = value.scenarios as Record<string, unknown>[];
    if (!previous && scenarios.length === 0)
      scenarios.push({ repoUrl: null, repoRef: null, profileId: null });
    if (scenarios.some((s) => s.profileId))
      throw new CliError(
        "usage",
        "Local scenarios do not support hosted personas",
      );
    const seen = new Set<string>();
    const ids = new Set<string>();
    const existing = new Set(
      (previous?.scenarios as Scenario[] | undefined)?.map(
        (scenario) => scenario.id,
      ),
    );
    value.scenarios = scenarios.map((scenario, index) => {
      const repoUrl =
        typeof scenario.repoUrl === "string"
          ? scenario.repoUrl.trim() || null
          : null;
      const repoRef =
        typeof scenario.repoRef === "string"
          ? scenario.repoRef.trim() || null
          : null;
      if (repoRef && !repoUrl)
        throw new CliError(
          "usage",
          "A scenario ref requires a repository URL.",
        );
      const key = JSON.stringify([repoUrl, repoRef]);
      if (seen.has(key))
        throw new CliError(
          "usage",
          "This prompt already has the same scenario.",
        );
      seen.add(key);
      const suppliedId = scenarioInputs?.[index]?.id;
      if (
        suppliedId !== undefined &&
        (typeof suppliedId !== "string" ||
          !previous ||
          !existing.has(suppliedId))
      )
        throw new CliError(
          "usage",
          `Unknown scenario ID: ${suppliedId}. Omit id to add a scenario.`,
        );
      const id =
        typeof suppliedId === "string" ? suppliedId : `sc_${randomUUID()}`;
      if (ids.has(id))
        throw new CliError("usage", `Duplicate scenario ID: ${id}`);
      ids.add(id);
      return { id, repoUrl, repoRef, profileId: null };
    });
  }
  return value;
}
function editable(row: LocalMeasurement): Record<string, unknown> {
  const { id, revision, measurementKind, createdAt, updatedAt, ...definition } =
    row;
  return definition;
}
export function createLocalMeasurement(
  command: Command,
  kind: MeasurementKind,
  definition: Record<string, unknown>,
): LocalMeasurement {
  return withLocalStore(command, (store) =>
    store.createMeasurement(kind, normalize(kind, definition)),
  );
}
export function editLocalMeasurement(
  command: Command,
  kind: MeasurementKind,
  id: string,
  patch: Record<string, unknown>,
): LocalMeasurement {
  return withLocalStore(command, (store) => {
    const current = store.requireMeasurement(id, kind);
    const value = normalize(kind, { ...editable(current), ...patch }, current);
    if (!("criteria" in patch) && current.criteria)
      value.criteria = current.criteria;
    if (!("scenarios" in patch) && current.scenarios)
      value.scenarios = current.scenarios;
    return store.updateMeasurement(id, value);
  });
}
export function getLocalMeasurement(
  command: Command,
  kind: MeasurementKind,
  id: string,
): LocalMeasurement {
  return withLocalStore(command, (store) =>
    measurementWithStats(store, store.requireMeasurement(id, kind)),
  );
}
export function removeLocalMeasurement(
  command: Command,
  kind: MeasurementKind,
  id: string,
): void {
  withLocalStore(command, (store) => {
    store.requireMeasurement(id, kind);
    store.deleteMeasurement(id);
  });
}
export function localMeasurementView(row: LocalMeasurement): any {
  return {
    profile: null,
    suiteId: null,
    market: null,
    position: 0,
    runCount: 0,
    lastRunAt: null,
    cadence: "NONE",
    sampleCount: 1,
    repoUrl: null,
    repoRef: null,
    agents: [],
    skillRefs: [],
    mcpRefs: [],
    connectionIds: [],
    stats: { passRates: [], runCount: 0, judgedRuns: 0, passedRuns: 0 },
    ...row,
    scenarios: Array.isArray(row.scenarios)
      ? row.scenarios.map((s) => ({ ...s, profile: null }))
      : [],
  };
}
export function listLocalMeasurements(
  command: Command,
  kind: MeasurementKind,
): any[] {
  return withLocalStore(command, (store) =>
    store
      .listMeasurements(kind)
      .map((row) => localMeasurementView(measurementWithStats(store, row))),
  );
}

function measurementWithStats(
  store: ReturnType<typeof openLocalStore>,
  row: LocalMeasurement,
): LocalMeasurement {
  const sessions = store.listSessions({ measurementId: row.id });
  const stats: {
    runCount: number;
    judgedRuns: number;
    passedRuns: number;
    passRates: {
      agent: string;
      model: string;
      runId: string;
      finishedAt: string | null;
      passed: number;
      total: number;
    }[];
  } = {
    runCount: sessions.length,
    judgedRuns: 0,
    passedRuns: 0,
    passRates: [],
  };
  for (const session of sessions) {
    const analysis = readCurrentAnalysis(store, session.id);
    if (!analysis) continue;
    const outcomes = analysis.criteria.map((criterion) => criterion.outcome);
    const verdict = outcomes.includes("FAIL")
      ? false
      : !outcomes.length || outcomes.includes("UNASSESSABLE")
        ? null
        : true;
    if (verdict === null) continue;
    stats.judgedRuns++;
    if (verdict) stats.passedRuns++;
    if (!stats.passRates.some((rate) => rate.agent === session.agent))
      stats.passRates.push({
        agent: session.agent,
        model: session.model,
        runId: session.id,
        finishedAt: session.endedAt,
        passed: outcomes.filter((outcome) => outcome === "PASS").length,
        total: outcomes.length,
      });
  }
  return {
    ...row,
    runCount: sessions.length,
    lastRunAt:
      sessions
        .map((session) => session.createdAt)
        .sort()
        .at(-1) ?? null,
    stats,
  };
}

function deriveCriterionName(rubric: string): string {
  const trimmed = rubric.replace(/^\s*(?:[-*•]|\(?\d+[.)])\s+/, "").trim();
  const first = trimmed.split(/(?<=[.!?])\s|\n/)[0]?.trim() ?? "";
  return (/\p{L}/u.test(first) ? first : trimmed.replace(/\s+/g, " "))
    .replace(/[.!?]+$/, "")
    .trim();
}

export function localMeasurementSpec(
  command: Command,
  kind: MeasurementKind,
  id: string,
  opts: { agent: string[]; samples?: string; scenario?: string[] },
): {
  spec: CaseSpec;
  measurement: {
    id: string;
    kind: MeasurementKind;
    revision: number;
    criterionIds?: string[];
  };
} {
  const row = getLocalMeasurement(command, kind, id);
  const settings: Record<string, unknown> = {
    ...row,
    ...runOverridesFromOpts(opts),
  };
  const agents =
    settings.agents as CaseSpec["cases"][number]["config"]["agents"];
  if (!agents?.length)
    throw new CliError(
      "usage",
      "Choose at least one agent with --agent before launching this local measurement",
    );
  let scenarios: (Pick<Scenario, "repoUrl" | "repoRef"> & { id?: string })[] =
    kind === "preference"
      ? (settings.scenarios as Scenario[])
      : [
          {
            repoUrl: (settings.repoUrl as string | null) ?? null,
            repoRef: (settings.repoRef as string | null) ?? null,
          },
        ];
  if (!scenarios.length)
    throw new CliError(
      "usage",
      "This preference prompt has no scenarios. Add one with gauge preference scenarios add <id> before running it.",
    );
  if (opts.scenario?.length) {
    for (const selected of opts.scenario)
      if (!scenarios.some((s) => s.id === selected))
        throw new CliError("usage", `Unknown local scenario: ${selected}`);
    scenarios = scenarios.filter(
      (s) => s.id !== undefined && opts.scenario!.includes(s.id),
    );
  }
  const cases = scenarios.map((scenario, index) => ({
    key: `${kind}-${index + 1}`,
    prompt: String(settings.promptText),
    ...(kind === "eval"
      ? {
          criteria: (settings.criteria as any[]).map((c) => ({
            name: c.name,
            rubric: c.rubric,
          })),
        }
      : {
          preference:
            settings.kind === "HEAD_TO_HEAD"
              ? {
                  kind: "head-to-head" as const,
                  brandA: String(settings.brandA),
                  brandB: String(settings.brandB),
                }
              : {
                  kind: "open-ended" as const,
                  branded: Boolean(settings.branded),
                },
        }),
    config: {
      agents,
      sampleCount: Number(settings.sampleCount ?? 1),
      repoUrl: scenario.repoUrl,
      repoRef: scenario.repoRef,
      inputs: settings.inputs as string[],
    },
  }));
  return {
    spec: { version: 2, cases },
    measurement: {
      id,
      kind,
      revision: row.revision,
      ...(kind === "eval"
        ? { criterionIds: (row.criteria as { id: string }[]).map((c) => c.id) }
        : {}),
    },
  };
}
