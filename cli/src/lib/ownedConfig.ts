import type { ownedConfigurations } from "@withgauge/api-schemas";
import type { Command } from "commander";
import type { Lifecycle } from "@withgauge/api-schemas/lifecycle";
import {
  addLifecycleOptions,
  addLifecycleEditOptions,
  hasLifecycleFlags,
  lifecyclePatchFromOpts,
  type LifecycleOpts,
} from "./lifecycle";
import { CliError } from "./client";
import { buildAgentRoster, collect, validateAssetRefs } from "./flags";

type OwnedConfigInput = ownedConfigurations.OwnedConfigurationBody;
type Cadence = NonNullable<OwnedConfigInput["cadence"]>;

export function parseCadence(raw: string | undefined): Cadence {
  const cadence = (raw ?? "NONE").trim().toUpperCase();
  if (!["NONE", "DAILY", "WEEKLY", "MONTHLY"].includes(cadence))
    throw new CliError(
      "usage",
      `invalid cadence "${raw}" (expected none, daily, weekly, or monthly)`,
    );
  return cadence as Cadence;
}

export function parseSampleCount(raw: string | undefined): number {
  const value = Number(raw ?? "1");
  if (!Number.isSafeInteger(value) || value < 1 || value > 50)
    throw new CliError("usage", "--samples must be an integer from 1 to 50");
  return value;
}

export type OwnedConfigCreateOpts = LifecycleOpts & {
  repo?: string;
  ref?: string;
  persona?: string;
  agent: string[];
  skill: string[];
  mcp: string[];
  connection: string[];
  cadence: string;
  samples: string;
};

export type OwnedConfigEditOpts = LifecycleOpts & {
  repo?: string;
  ref?: string;
  clearRef?: boolean;
  clearRepo?: boolean;
  persona?: string;
  clearPersona?: boolean;
  agent: string[];
  skill: string[];
  clearSkills?: boolean;
  mcp: string[];
  clearMcp?: boolean;
  connection: string[];
  clearConnections?: boolean;
  cadence?: string;
  samples?: string;
};

export function ownedConfigFromOpts(
  opts: OwnedConfigCreateOpts,
): OwnedConfigInput {
  if (opts.ref !== undefined && opts.repo === undefined)
    throw new CliError("usage", "--ref requires --repo");
  if (opts.agent.length === 0)
    throw new CliError("usage", "at least one --agent is required");
  return {
    ...lifecyclePatchFromOpts(opts),
    repoUrl: opts.repo ?? null,
    repoRef: opts.ref ?? null,
    profileId: opts.persona ?? null,
    agents: buildAgentRoster(opts.agent),
    skillRefs: validateAssetRefs("skill", opts.skill),
    mcpRefs: validateAssetRefs("mcp", opts.mcp),
    connectionIds: opts.connection,
    cadence: parseCadence(opts.cadence),
    sampleCount: parseSampleCount(opts.samples),
  };
}

export function ownedConfigPatchFromOpts(
  opts: OwnedConfigEditOpts,
  lifecycle?: Lifecycle | null,
): Partial<OwnedConfigInput> {
  const patch: Partial<OwnedConfigInput> = lifecyclePatchFromOpts(
    opts,
    lifecycle,
  );

  if ((opts.repo !== undefined || opts.ref !== undefined) && opts.clearRepo)
    throw new CliError("usage", "--repo/--ref and --clear-repo conflict");
  if (opts.ref !== undefined && opts.clearRef)
    throw new CliError("usage", "--ref and --clear-ref conflict");
  if (opts.clearRepo) {
    patch.repoUrl = null;
    patch.repoRef = null;
  } else {
    if (opts.repo !== undefined) patch.repoUrl = opts.repo;
    if (opts.clearRef) patch.repoRef = null;
    else if (opts.ref !== undefined) patch.repoRef = opts.ref;
  }

  if (opts.persona !== undefined && opts.clearPersona)
    throw new CliError("usage", "--persona and --clear-persona conflict");
  if (opts.clearPersona) patch.profileId = null;
  else if (opts.persona !== undefined) patch.profileId = opts.persona;

  if (opts.agent.length > 0) patch.agents = buildAgentRoster(opts.agent);

  if (opts.skill.length > 0 && opts.clearSkills)
    throw new CliError("usage", "--skill and --clear-skills conflict");
  if (opts.clearSkills) patch.skillRefs = [];
  else if (opts.skill.length > 0)
    patch.skillRefs = validateAssetRefs("skill", opts.skill);

  if (opts.mcp.length > 0 && opts.clearMcp)
    throw new CliError("usage", "--mcp and --clear-mcp conflict");
  if (opts.clearMcp) patch.mcpRefs = [];
  else if (opts.mcp.length > 0)
    patch.mcpRefs = validateAssetRefs("mcp", opts.mcp);

  if (opts.connection.length > 0 && opts.clearConnections)
    throw new CliError(
      "usage",
      "--connection and --clear-connections conflict",
    );
  if (opts.clearConnections) patch.connectionIds = [];
  else if (opts.connection.length > 0) patch.connectionIds = opts.connection;

  if (opts.cadence !== undefined) patch.cadence = parseCadence(opts.cadence);
  if (opts.samples !== undefined)
    patch.sampleCount = parseSampleCount(opts.samples);

  return patch;
}

export type RunSettingsCreateOpts = Omit<
  OwnedConfigCreateOpts,
  "repo" | "ref" | "persona"
>;
export type RunSettingsEditOpts = Omit<
  OwnedConfigEditOpts,
  "repo" | "ref" | "clearRef" | "clearRepo" | "persona" | "clearPersona"
>;

type RunSettingsInput = Omit<
  OwnedConfigInput,
  "repoUrl" | "repoRef" | "profileId" | "agents"
> & { agents?: OwnedConfigInput["agents"] };

export function addRunSettingsCreateOptions(command: Command): Command {
  return addLifecycleOptions(command)
    .option(
      "--agent <agent[:m1,m2]>",
      "agent and optional model pins (repeatable)",
      collect,
      [] as string[],
    )
    .option(
      "--skill <name@label>",
      "staged skill (repeatable)",
      collect,
      [] as string[],
    )
    .option(
      "--mcp <name@label>",
      "MCP server (repeatable)",
      collect,
      [] as string[],
    )
    .option(
      "--connection <id>",
      "connection id (repeatable)",
      collect,
      [] as string[],
    )
    .option("--cadence <cadence>", "none | daily | weekly | monthly", "none")
    .option("--samples <n>", "sample count from 1 to 50", "1");
}

export function addRunSettingsEditOptions(command: Command): Command {
  return addLifecycleEditOptions(command)
    .option(
      "--agent <agent[:m1,m2]>",
      "replace agents and model pins (repeatable)",
      collect,
      [] as string[],
    )
    .option(
      "--skill <name@label>",
      "replace skills (repeatable)",
      collect,
      [] as string[],
    )
    .option("--clear-skills", "remove all skills")
    .option(
      "--mcp <name@label>",
      "replace MCP servers (repeatable)",
      collect,
      [] as string[],
    )
    .option("--clear-mcp", "remove all MCP servers")
    .option(
      "--connection <id>",
      "replace connections (repeatable)",
      collect,
      [] as string[],
    )
    .option("--clear-connections", "remove all connections")
    .option("--cadence <cadence>", "none | daily | weekly | monthly")
    .option("--samples <n>", "sample count from 1 to 50");
}

export function hasRunSettingsFlags(opts: RunSettingsCreateOpts): boolean {
  return (
    hasLifecycleFlags(opts) ||
    opts.agent.length > 0 ||
    opts.skill.length > 0 ||
    opts.mcp.length > 0 ||
    opts.connection.length > 0 ||
    opts.cadence.toUpperCase() !== "NONE" ||
    opts.samples !== "1"
  );
}

export function runSettingsFromOpts(
  opts: RunSettingsCreateOpts,
): RunSettingsInput {
  return {
    ...lifecyclePatchFromOpts(opts),
    ...(opts.agent.length > 0 ? { agents: buildAgentRoster(opts.agent) } : {}),
    skillRefs: validateAssetRefs("skill", opts.skill),
    mcpRefs: validateAssetRefs("mcp", opts.mcp),
    connectionIds: opts.connection,
    cadence: parseCadence(opts.cadence),
    sampleCount: parseSampleCount(opts.samples),
  };
}

export function runSettingsPatchFromOpts(
  opts: RunSettingsEditOpts,
  lifecycle?: Lifecycle | null,
): Partial<RunSettingsInput> {
  return ownedConfigPatchFromOpts(opts, lifecycle);
}

export function runOverridesFromOpts(opts: {
  agent: string[];
  samples?: string;
}): { agents?: OwnedConfigInput["agents"]; sampleCount?: number } {
  return {
    ...(opts.agent.length > 0 ? { agents: buildAgentRoster(opts.agent) } : {}),
    ...(opts.samples !== undefined
      ? { sampleCount: parseSampleCount(opts.samples) }
      : {}),
  };
}

export function cadenceLabel(cadence: Cadence): string {
  return cadence === "NONE" ? "manual" : cadence.toLowerCase();
}
