import type { Command } from "commander";
import { CliError } from "./client";
import { readConfig } from "./config";
import { gaugeState } from "./gaugeState";
import { type OrgSource, resolveSelection } from "./orgDirectory";
import type { OutputFormat } from "./output";

export type OrgSelection = { value: string; source: OrgSource };

// The org a command targets: --org, then the command's own file (a battery
// spec), then gauge.json `org`, then defaultOrg.
export function selectedOrg(
  command: Command,
  fileOrg?: string,
): OrgSelection | undefined {
  const { org } = command.optsWithGlobals<{ org?: string }>();
  if (org) return { value: org, source: "flag" };
  if (fileOrg) return { value: fileOrg, source: "file" };
  const projectOrg = gaugeState(command).config?.org;
  if (typeof projectOrg === "string" && projectOrg)
    return { value: projectOrg, source: "project" };
  const { defaultOrg } = readConfig();
  if (defaultOrg) return { value: defaultOrg, source: "config" };
  return undefined;
}

const NO_ORG_MESSAGE =
  "No organization selected. Pass --org <org> or set a default with `gauge orgs use <org>`.";

// The {org} an Agents API call sends: the shared organization id when the
// selection resolves to one, else the selection as given (Agents also accepts
// its own slugs, which is how LOCAL workspaces are addressed).
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
