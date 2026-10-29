import {
  isLocal,
  createLocalMeasurement,
  editLocalMeasurement,
  getLocalMeasurement,
  removeLocalMeasurement,
  localMeasurementView,
  listLocalMeasurements,
} from "./localMeasurements";
import type { ownedConfigurations, visibility } from "@withgauge/api-schemas";
import type { Command } from "commander";
import { CliError, createClient } from "./client";
import { confirmOrAbort } from "./confirm";
import { creatorLabel } from "./createdBy";
import { resolveOrg, resolveOutput } from "./context";
import { readPromptText } from "./flags";
import { printItems, printJson } from "./output";
import {
  cadenceLabel,
  hasRunSettingsFlags,
  type RunSettingsCreateOpts,
  type RunSettingsEditOpts,
  runOverridesFromOpts,
  runSettingsFromOpts,
  runSettingsPatchFromOpts,
} from "./ownedConfig";

type VisibilityPrompt = visibility.VisibilityPrompt;

function visibilityPath(org: string): string {
  return `/api/v1/orgs/${encodeURIComponent(org)}/visibility-prompts`;
}

function promptPath(org: string, id: string): string {
  return `${visibilityPath(org)}/${encodeURIComponent(id)}`;
}

function scenariosPath(org: string, id: string): string {
  return `${promptPath(org, id)}/scenarios`;
}

function scenarioRow(scenario: ownedConfigurations.VisibilityScenario) {
  return {
    id: scenario.id,
    repo: scenario.repoUrl ?? "(empty project)",
    ref: scenario.repoRef ?? "",
    persona: scenario.profile?.name ?? "(default)",
  };
}

export const KIND_CHOICES = ["head-to-head", "open-ended"] as const;

function parseKind(raw: string): visibility.VisibilityPromptKind {
  const upper =
    raw === "open-ended"
      ? "RECOMMEND"
      : raw.trim().toUpperCase().replace(/-/g, "_");
  if (upper !== "HEAD_TO_HEAD" && upper !== "RECOMMEND")
    throw new CliError(
      "usage",
      `invalid --kind "${raw}" (expected: ${KIND_CHOICES.join(" | ")})`,
    );
  return upper;
}

function brandsLabel(v: VisibilityPrompt): string {
  if (v.kind === "HEAD_TO_HEAD") return `${v.brandA} vs ${v.brandB}`;
  return v.branded ? (v.brandA ?? "branded") : "organic";
}

export function preferencePromptRow(v: VisibilityPrompt) {
  return {
    id: v.id,
    name: v.name,
    kind: v.kind === "RECOMMEND" ? "open-ended" : "head-to-head",
    brands: brandsLabel(v),
    market: v.market?.slug ?? "",
    tags: v.tags.join(", "),
    runs: v.runCount,
    "last run": v.lastRunAt ?? "-",
    "created by": creatorLabel(v.createdBy),
  };
}

function printDetail(v: VisibilityPrompt): void {
  console.log(`id:      ${v.id}`);
  console.log(`name:    ${v.name}`);
  console.log(
    `kind:    ${v.kind === "RECOMMEND" ? "open-ended" : "head-to-head"}`,
  );
  console.log(`brands:  ${brandsLabel(v)}`);
  console.log(
    `market:  ${v.market ? `${v.market.name} (${v.market.slug})` : "(none)"}`,
  );
  console.log(`tags:    ${v.tags.join(", ") || "(none)"}`);
  console.log(`runs:    ${v.runCount} (last: ${v.lastRunAt ?? "never"})`);
  console.log(`creator: ${creatorLabel(v.createdBy)}`);
  console.log(`prompt:  ${v.promptText}`);
  console.log(
    `cadence: ${cadenceLabel(v.cadence)} — ${v.sampleCount} sample(s)`,
  );
  console.log(
    `agents:  ${v.agents
      .map((a) =>
        a.models.length ? `${a.agent}:${a.models.join(",")}` : a.agent,
      )
      .join(", ")}`,
  );
  console.log(`skills:  ${v.skillRefs.join(", ") || "(none)"}`);
  console.log(`mcp:     ${v.mcpRefs.join(", ") || "(none)"}`);
  console.log(`conns:   ${v.connectionIds.join(", ") || "(none)"}`);
  console.log(`scenarios: ${v.scenarios.length}`);
  for (const scenario of v.scenarios)
    console.log(
      `  [${scenario.id}] ${scenario.repoUrl ?? "(empty project)"}${scenario.repoRef ? `@${scenario.repoRef}` : ""} — ${scenario.profile?.name ?? "default persona"}`,
    );
}

export async function listPreferencePrompts(
  cmd: Command,
): Promise<VisibilityPrompt[]> {
  if (isLocal(cmd)) return listLocalMeasurements(cmd, "preference");
  const res =
    await createClient().get<visibility.ListVisibilityPromptsResponse>(
      visibilityPath(await resolveOrg(cmd)),
    );
  return res.items;
}

export async function getPreferencePrompt(
  cmd: Command,
  id: string,
): Promise<void> {
  const vp = isLocal(cmd)
    ? localMeasurementView(getLocalMeasurement(cmd, "preference", id))
    : await createClient().get<VisibilityPrompt>(
        promptPath(await resolveOrg(cmd), id),
      );
  if (resolveOutput(cmd) === "json") printJson(vp);
  else printDetail(vp);
}

export type PreferenceCreateOpts = RunSettingsCreateOpts & {
  name: string;
  kind?: string;
  text?: string;
  file?: string;
  brandA?: string;
  brandB?: string;
  branded?: boolean;
  repo?: string;
  ref?: string;
  persona?: string;
  market?: string;
  tag: string[];
};

export async function createPreferencePrompt(
  cmd: Command,
  opts: PreferenceCreateOpts,
): Promise<void> {
  if (opts.kind === undefined)
    throw new CliError(
      "usage",
      `--kind is required with --preference (${KIND_CHOICES.join(" | ")})`,
    );
  if (opts.ref !== undefined && opts.repo === undefined)
    throw new CliError("usage", "--ref requires --repo");
  const hasScenario = opts.repo !== undefined || opts.persona !== undefined;
  const body: visibility.CreateVisibilityPromptBodyInput = {
    name: opts.name,
    promptText: readPromptText(opts),
    kind: parseKind(opts.kind),
    branded: opts.branded,
    brandA: opts.brandA ?? null,
    brandB: opts.brandB ?? null,
    marketId: opts.market ?? null,
    tags: opts.tag.length > 0 ? opts.tag : undefined,
    ...(hasRunSettingsFlags(opts) ? runSettingsFromOpts(opts) : {}),
    scenarios: hasScenario
      ? [
          {
            repoUrl: opts.repo ?? null,
            repoRef: opts.ref ?? null,
            profileId: opts.persona ?? null,
          },
        ]
      : [],
  };
  const created = isLocal(cmd)
    ? createLocalMeasurement(cmd, "preference", body)
    : await createClient().post<VisibilityPrompt>(
        visibilityPath(await resolveOrg(cmd)),
        body,
      );
  if (resolveOutput(cmd) === "json") printJson(created);
  else console.log(`Created preference prompt ${created.id}`);
}

export type PreferenceEditOpts = RunSettingsEditOpts & {
  name?: string;
  text?: string;
  file?: string;
  brandA?: string;
  brandB?: string;
  branded?: boolean;
  organic?: boolean;
  market?: string;
  clearMarket?: boolean;
  tag: string[];
  clearTags?: boolean;
};

export async function editPreferencePrompt(
  cmd: Command,
  id: string,
  opts: PreferenceEditOpts,
): Promise<void> {
  const body: visibility.UpdateVisibilityPromptBody = {
    ...runSettingsPatchFromOpts(opts),
  };
  if (opts.name !== undefined) body.name = opts.name;
  if (opts.text !== undefined || opts.file !== undefined)
    body.promptText = readPromptText(opts);
  if (opts.brandA !== undefined) body.brandA = opts.brandA;
  if (opts.brandB !== undefined) body.brandB = opts.brandB;

  if (opts.branded && opts.organic)
    throw new CliError("usage", "--branded and --organic conflict");
  if (opts.branded) body.branded = true;
  else if (opts.organic) body.branded = false;

  if (opts.market !== undefined && opts.clearMarket)
    throw new CliError("usage", "--market and --clear-market conflict");
  if (opts.clearMarket) body.marketId = null;
  else if (opts.market !== undefined) body.marketId = opts.market;

  if (opts.tag.length > 0 && opts.clearTags)
    throw new CliError("usage", "--tag and --clear-tags conflict");
  if (opts.clearTags) body.tags = [];
  else if (opts.tag.length > 0) body.tags = opts.tag;

  if (Object.keys(body).length === 0)
    throw new CliError("usage", "nothing to change");
  const updated = isLocal(cmd)
    ? editLocalMeasurement(cmd, "preference", id, body)
    : await createClient().patch<VisibilityPrompt>(
        promptPath(await resolveOrg(cmd), id),
        body,
      );
  if (resolveOutput(cmd) === "json") printJson(updated);
  else console.log(`Updated preference prompt ${updated.id}`);
}

export async function removePreferencePrompt(
  cmd: Command,
  id: string,
): Promise<void> {
  if (isLocal(cmd)) removeLocalMeasurement(cmd, "preference", id);
  else await createClient().delete<void>(promptPath(await resolveOrg(cmd), id));
  if (resolveOutput(cmd) !== "json")
    console.log(`Deleted preference prompt ${id}`);
}

export async function listScenarios(cmd: Command, id: string): Promise<void> {
  const vp = isLocal(cmd)
    ? localMeasurementView(getLocalMeasurement(cmd, "preference", id))
    : await createClient().get<VisibilityPrompt>(
        promptPath(await resolveOrg(cmd), id),
      );
  if (resolveOutput(cmd) === "json") printJson(vp.scenarios);
  else printItems(vp.scenarios.map(scenarioRow), "table");
}

export async function addScenario(
  cmd: Command,
  id: string,
  opts: { repo?: string; ref?: string; persona?: string },
): Promise<void> {
  if (opts.ref !== undefined && opts.repo === undefined)
    throw new CliError("usage", "--ref requires --repo");
  if (isLocal(cmd)) {
    if (opts.persona)
      throw new CliError("usage", "Personas require hosted Gauge");
    const row = getLocalMeasurement(cmd, "preference", id);
    const updated = editLocalMeasurement(cmd, "preference", id, {
      scenarios: [
        ...(row.scenarios as object[]),
        {
          repoUrl: opts.repo ?? null,
          repoRef: opts.ref ?? null,
          profileId: null,
        },
      ],
    });
    const scenario = (updated.scenarios as { id: string }[]).at(-1)!;
    if (resolveOutput(cmd) === "json") printJson(scenario);
    else console.log(`Added scenario ${scenario.id}`);
    return;
  }
  const created =
    await createClient().post<ownedConfigurations.VisibilityScenario>(
      scenariosPath(await resolveOrg(cmd), id),
      {
        repoUrl: opts.repo ?? null,
        repoRef: opts.ref ?? null,
        profileId: opts.persona ?? null,
      },
    );
  if (resolveOutput(cmd) === "json") printJson(created);
  else console.log(`Added scenario ${created.id}`);
}

export async function removeScenario(
  cmd: Command,
  id: string,
  scenarioId: string,
): Promise<void> {
  if (isLocal(cmd)) {
    const row = getLocalMeasurement(cmd, "preference", id);
    const scenarios = row.scenarios as { id: string }[];
    if (!scenarios.some((s) => s.id === scenarioId))
      throw new CliError("usage", `Unknown scenario: ${scenarioId}`);
    editLocalMeasurement(cmd, "preference", id, {
      scenarios: scenarios.filter((s) => s.id !== scenarioId),
    });
    if (resolveOutput(cmd) !== "json")
      console.log(`Removed scenario ${scenarioId}`);
    return;
  }
  await createClient().delete<void>(
    `${scenariosPath(await resolveOrg(cmd), id)}/${encodeURIComponent(scenarioId)}`,
  );
  if (resolveOutput(cmd) !== "json")
    console.log(`Removed scenario ${scenarioId}`);
}

export async function runPreferencePrompt(
  cmd: Command,
  id: string,
  opts: {
    scenario: string[];
    yes?: boolean;
    agent: string[];
    samples?: string;
  },
): Promise<void> {
  const org = await resolveOrg(cmd);
  const overrides = runOverridesFromOpts(opts);
  const settings =
    Object.keys(overrides).length > 0
      ? "these overrides (stored settings stay unchanged)"
      : "the stored settings";
  await confirmOrAbort(
    opts.scenario.length > 0
      ? `Run ${opts.scenario.length} selected scenario${opts.scenario.length === 1 ? "" : "s"} with ${settings} now?`
      : `Run every scenario of this prompt with ${settings} now?`,
    opts.yes,
  );
  const result =
    await createClient().post<visibility.RunVisibilityPromptResponse>(
      `${promptPath(org, id)}/run`,
      {
        visibilityScenarioIds:
          opts.scenario.length > 0 ? opts.scenario : undefined,
        ...overrides,
      },
    );
  if (resolveOutput(cmd) === "json") printJson(result);
  else {
    console.log(
      `Started ${result.runIds.length} run${result.runIds.length === 1 ? "" : "s"} across ${result.batchIds.length} scenario${result.batchIds.length === 1 ? "" : "s"}`,
    );
    for (const batch of result.batchIds)
      console.log(`Runs: gauge run list --batch ${batch}`);
  }
}

export async function listPreferencePromptRuns(
  cmd: Command,
  id: string,
  opts: { limit?: string; cursor?: string },
): Promise<void> {
  const res =
    await createClient().get<visibility.ListVisibilityPromptRunsResponse>(
      `${promptPath(await resolveOrg(cmd), id)}/runs`,
      { limit: opts.limit, cursor: opts.cursor },
    );
  if (resolveOutput(cmd) === "json") {
    printJson(res);
    return;
  }
  printItems(
    res.items.map((r) => ({
      id: r.id,
      status: r.status,
      agent: r.agent,
      model: r.resolvedModel ?? r.model ?? "",
      source: r.triggeredBy?.source ?? "",
      credits: r.creditsCharged ?? "",
      created: r.createdAt,
      verdict: r.verdict?.status ?? "-",
    })),
    "table",
  );
  if (res.nextCursor)
    console.error(`(more results — rerun with --cursor ${res.nextCursor})`);
}

export async function markets(
  cmd: Command,
  opts: { add?: string },
): Promise<void> {
  if (isLocal(cmd))
    throw new CliError("usage", "Markets require hosted Gauge. Pass --hosted.");
  const client = createClient();
  const base = `/api/v1/orgs/${encodeURIComponent(await resolveOrg(cmd))}/markets`;
  if (opts.add !== undefined) {
    const market = await client.post<visibility.OrgMarket>(base, {
      marketId: opts.add,
    });
    if (resolveOutput(cmd) === "json") printJson(market);
    else console.log(`Tracking market ${market.name} (${market.slug})`);
    return;
  }
  const res = await client.get<visibility.ListMarketsResponse>(base);
  if (resolveOutput(cmd) === "json") {
    printJson(res);
    return;
  }
  printItems(
    [
      ...res.tracked.map((m) => ({
        id: m.marketId,
        slug: m.slug,
        name: m.name,
        tracked: "yes",
        source: m.source,
      })),
      ...res.addable.map((m) => ({
        id: m.marketId,
        slug: m.slug,
        name: m.name,
        tracked: "no",
        source: "",
      })),
    ],
    "table",
  );
}
