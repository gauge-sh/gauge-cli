import {
  isLocal,
  createLocalMeasurement,
  editLocalMeasurement,
  getLocalMeasurement,
  removeLocalMeasurement,
  localMeasurementView,
  listLocalMeasurements,
} from "./localMeasurements";
import { readFileSync } from "node:fs";
import type { evals } from "@withgauge/api-schemas";
import type { Command } from "commander";
import { CliError, createClient } from "./client";
import { confirmOrAbort } from "./confirm";
import { resolveOrg, resolveOutput } from "./context";
import { parseAgents, readPromptText } from "./flags";
import { printJson } from "./output";
import {
  cadenceLabel,
  type OwnedConfigCreateOpts,
  type OwnedConfigEditOpts,
  ownedConfigFromOpts,
  ownedConfigPatchFromOpts,
  runOverridesFromOpts,
} from "./ownedConfig";

type EvalSet = evals.EvalSet;
type EvalSetListItem = evals.EvalSetListItem;

function evalSetsPath(org: string): string {
  return `/api/v1/orgs/${encodeURIComponent(org)}/eval-sets`;
}

function evalSetPath(org: string, id: string): string {
  return `${evalSetsPath(org)}/${encodeURIComponent(id)}`;
}

function parseCriterion(raw: string): { name: string; rubric: string } {
  const idx = raw.indexOf(":");
  if (idx <= 0 || !raw.slice(idx + 1).trim()) {
    throw new CliError(
      "usage",
      `invalid --criterion "${raw}" (expected "Name: rubric text")`,
    );
  }
  return { name: raw.slice(0, idx).trim(), rubric: raw.slice(idx + 1).trim() };
}

function readCriteriaFile(path: string): evals.CriterionInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path === "-" ? 0 : path, "utf8"));
  } catch (e) {
    throw new CliError(
      "usage",
      `could not read --criteria-file: ${e instanceof Error ? e.message : e}`,
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new CliError(
      "usage",
      "--criteria-file must be a non-empty JSON array of {id?, name, rubric}",
    );
  return parsed as evals.CriterionInput[];
}

function criteriaFromOpts(opts: {
  criterion: string[];
  criteriaFile?: string;
}): evals.CriterionInput[] | undefined {
  if (opts.criterion.length > 0 && opts.criteriaFile !== undefined)
    throw new CliError("usage", "--criterion and --criteria-file conflict");
  if (opts.criteriaFile !== undefined)
    return readCriteriaFile(opts.criteriaFile);
  if (opts.criterion.length > 0) return opts.criterion.map(parseCriterion);
  return undefined;
}

function repoLabel(e: EvalSet): string {
  if (!e.repoUrl) return "(default scaffold)";
  return e.repoRef ? `${e.repoUrl}@${e.repoRef}` : e.repoUrl;
}

function passRateLabel(stats: evals.EvalSetStat): string {
  if (stats.judgedRuns === 0) return "-";
  return `${Math.round((stats.passedRuns / stats.judgedRuns) * 100)}% (${stats.passedRuns}/${stats.judgedRuns})`;
}

export function evalSetRow(e: EvalSetListItem) {
  return {
    id: e.id,
    name: e.name,
    repo: repoLabel(e),
    criteria: e.criteria.length,
    tags: e.tags.join(", "),
    "pass rate": passRateLabel(e.stats),
    runs: e.stats.runCount,
  };
}

function printDetail(e: EvalSet): void {
  console.log(`id:       ${e.id}`);
  console.log(`name:     ${e.name}`);
  console.log(`repo:     ${repoLabel(e)}`);
  console.log(`persona:  ${e.profile ? e.profile.name : "(default persona)"}`);
  console.log(`tags:     ${e.tags.join(", ") || "(none)"}`);
  console.log(`cadence:  ${cadenceLabel(e.cadence)}`);
  console.log(`samples:  ${e.sampleCount}`);
  console.log(
    `agents:   ${e.agents.map((agent) => `${agent.agent}${agent.models.length > 0 ? `:${agent.models.join(",")}` : ""}`).join("; ")}`,
  );
  console.log(`skills:   ${e.skillRefs.join(", ") || "(none)"}`);
  console.log(`mcp:      ${e.mcpRefs.join(", ") || "(none)"}`);
  console.log(`conns:    ${e.connectionIds.join(", ") || "(none)"}`);
  console.log(`prompt:   ${e.promptText}`);
  console.log("criteria:");
  for (const c of e.criteria) console.log(`  [${c.id}] ${c.name}: ${c.rubric}`);
}

export async function listEvalSets(
  cmd: Command,
  opts: { agents?: string; models?: string; since?: string },
): Promise<EvalSetListItem[]> {
  if (isLocal(cmd)) {
    if (opts.agents || opts.models || opts.since)
      throw new CliError(
        "usage",
        "Local eval list does not support stats filters yet; use gauge query --local.",
      );
    return listLocalMeasurements(cmd, "eval");
  }
  const res = await createClient().get<evals.ListEvalSetsResponse>(
    evalSetsPath(resolveOrg(cmd)),
    {
      agents:
        opts.agents === undefined
          ? undefined
          : parseAgents(opts.agents).join(","),
      models: opts.models,
      since: opts.since,
    },
  );
  return res.items;
}

export async function getEvalSet(cmd: Command, id: string): Promise<void> {
  const evalSet = isLocal(cmd)
    ? localMeasurementView(getLocalMeasurement(cmd, "eval", id))
    : await createClient().get<EvalSet>(evalSetPath(resolveOrg(cmd), id));
  if (resolveOutput(cmd) === "json") printJson(evalSet);
  else printDetail(evalSet);
}

export type EvalSetCreateOpts = OwnedConfigCreateOpts & {
  name: string;
  text?: string;
  file?: string;
  criterion: string[];
  criteriaFile?: string;
  tag: string[];
  input?: string[];
};

export async function createEvalSet(
  cmd: Command,
  opts: EvalSetCreateOpts,
): Promise<void> {
  const criteria = criteriaFromOpts(opts);
  if (!criteria)
    throw new CliError(
      "usage",
      "at least one --criterion (or --criteria-file) is required",
    );
  const body: evals.CreateEvalSetBodyInput = {
    name: opts.name,
    promptText: readPromptText(opts),
    ...ownedConfigFromOpts(opts),
    criteria,
    tags: opts.tag.length > 0 ? opts.tag : undefined,
  };
  if (!isLocal(cmd) && opts.repo === undefined)
    console.error(
      "note: no --repo — this eval set will run against the default Gauge scaffold, NOT your repository. Use `gauge eval edit <id> --repo <url>` to retarget.",
    );
  if (!isLocal(cmd) && opts.input?.length)
    throw new CliError(
      "usage",
      "Named project inputs on saved measurements are local-only; use a hosted case file for project inputs.",
    );
  const created = isLocal(cmd)
    ? createLocalMeasurement(cmd, "eval", { ...body, inputs: opts.input ?? [] })
    : await createClient().post<EvalSet>(evalSetsPath(resolveOrg(cmd)), body);
  if (resolveOutput(cmd) === "json") printJson(created);
  else console.log(`Created eval set ${created.id}`);
}

export type EvalSetEditOpts = OwnedConfigEditOpts & {
  name?: string;
  text?: string;
  file?: string;
  criterion: string[];
  criteriaFile?: string;
  tag: string[];
  clearTags?: boolean;
  input?: string[];
  clearInputs?: boolean;
};

export async function editEvalSet(
  cmd: Command,
  id: string,
  opts: EvalSetEditOpts,
): Promise<void> {
  const body: evals.UpdateEvalSetBody = ownedConfigPatchFromOpts(opts);
  if (opts.name !== undefined) body.name = opts.name;
  if (opts.text !== undefined || opts.file !== undefined)
    body.promptText = readPromptText(opts);

  const criteria = criteriaFromOpts(opts);
  if (criteria) body.criteria = criteria;

  if (opts.tag.length > 0 && opts.clearTags)
    throw new CliError("usage", "--tag and --clear-tags conflict");
  if (opts.clearTags) body.tags = [];
  else if (opts.tag.length > 0) body.tags = opts.tag;

  if (
    Object.keys(body).length === 0 &&
    !opts.input?.length &&
    !opts.clearInputs
  )
    throw new CliError("usage", "nothing to change");
  const inputPatch = opts.clearInputs
    ? { inputs: [] }
    : opts.input?.length
      ? { inputs: opts.input }
      : {};
  if (!isLocal(cmd) && (opts.clearInputs || opts.input?.length))
    throw new CliError(
      "usage",
      "Named project inputs on saved measurements are local-only",
    );
  const updated = isLocal(cmd)
    ? editLocalMeasurement(cmd, "eval", id, { ...body, ...inputPatch })
    : await createClient().patch<EvalSet>(
        evalSetPath(resolveOrg(cmd), id),
        body,
      );
  if (resolveOutput(cmd) === "json") printJson(updated);
  else console.log(`Updated eval set ${updated.id}`);
}

export async function removeEvalSet(cmd: Command, id: string): Promise<void> {
  if (isLocal(cmd)) removeLocalMeasurement(cmd, "eval", id);
  else await createClient().delete<void>(evalSetPath(resolveOrg(cmd), id));
  if (resolveOutput(cmd) !== "json") console.log(`Deleted eval set ${id}`);
}


export async function runEvalSet(
  cmd: Command,
  id: string,
  opts: {
    yes?: boolean;
    agent: string[];
    samples?: string;
  },
): Promise<void> {
  const org = resolveOrg(cmd);
  const overrides = runOverridesFromOpts(opts);
  await confirmOrAbort(
    Object.keys(overrides).length > 0
      ? "Run this eval now with these overrides? The stored configuration stays unchanged."
      : "Run this eval's stored configuration now?",
    opts.yes,
  );
  const result = await createClient().post<evals.RunEvalSetResponse>(
    `${evalSetPath(org, id)}/run`,
    overrides,
  );
  if (resolveOutput(cmd) === "json") printJson(result);
  else {
    console.log(
      `Started ${result.runIds.length} run${result.runIds.length === 1 ? "" : "s"} in batch ${result.batchIds[0] ?? ""}`,
    );
    for (const batch of result.batchIds)
      console.log(`Runs: gauge run list --batch ${batch}`);
    if (result.runRequestId)
      console.log(`Wait: gauge --org ${org} run wait ${result.runRequestId}`);
  }
}
