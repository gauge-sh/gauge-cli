import type { Command } from "commander";
import { CliError } from "./client";
import { readConfig } from "./config";
import { gaugeState } from "./gaugeState";
import {
  type OrgSource,
  isUuid,
  legacySelection,
  resolveSelection,
} from "./orgDirectory";
import type { OutputFormat } from "./output";

export type OrgSelection = { value: string; source: OrgSource };

export function selectedOrg(
  command: Command,
  fileOrg?: string,
): OrgSelection | undefined {
  const { org } = command.optsWithGlobals<{ org?: string }>();
  if (org) return { value: org, source: "flag" };
  if (fileOrg) return { value: fileOrg, source: "file" };
  const project = gaugeState(command).config;
  if (typeof project?.orgId === "string" && project.orgId) {
    if (!isUuid(project.orgId))
      throw new CliError(
        "usage",
        "Invalid orgId in gauge.json. Run `gauge orgs use <slug> --project`.",
      );
    return { value: project.orgId, source: "project" };
  }
  if (project?.org) legacySelection("project");
  const { orgId, defaultOrg } = readConfig();
  if (orgId) {
    if (!isUuid(orgId))
      throw new CliError(
        "usage",
        "Invalid saved orgId. Run `gauge orgs use <slug>`.",
      );
    return { value: orgId, source: "config" };
  }
  if (defaultOrg) legacySelection("config");
  return undefined;
}

const NO_ORG_MESSAGE =
  "No organization selected. Pass --org <org> or set a default with `gauge orgs use <org>`.";

export async function resolveOrg(
  command: Command,
  fileOrg?: string,
): Promise<string> {
  const selection = selectedOrg(command, fileOrg);
  if (!selection)
    throw new CliError("usage", NO_ORG_MESSAGE, { needsAccount: true });
  return (await resolveSelection(selection.value, selection.source)).id;
}

export function resolveOutput(command: Command): OutputFormat {
  const { output } = command.optsWithGlobals<{ output?: string }>();
  return output === "json" ? "json" : "table";
}

export type HostedOptions = { account?: boolean; hint?: string };

export function requireHosted(
  command: Command,
  { account = false, hint }: HostedOptions = {},
): void {
  const { mode, source } = gaugeState(command);
  if (mode === "local" && (source === "flag" || !account))
    throw new CliError("usage", "This command needs hosted Gauge.", {
      needsAccount: true,
      hint,
    });
}

export function hostedOnly(
  command: Command,
  options: HostedOptions = {},
): Command {
  return command.hook("preAction", (_command, action) =>
    requireHosted(action, options),
  );
}
