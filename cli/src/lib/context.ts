import type { Command } from "commander";
import { CliError } from "./client";
import { readConfig } from "./config";
import { gaugeState } from "./gaugeState";
import type { OutputFormat } from "./output";

export function resolveOrg(command: Command, fileOrg?: string): string {
  const { org } = command.optsWithGlobals<{ org?: string }>();
  if (org) return org;
  if (fileOrg) return fileOrg;
  const projectOrg = gaugeState(command).config?.org;
  if (typeof projectOrg === "string" && projectOrg) return projectOrg;
  const { defaultOrg } = readConfig();
  if (defaultOrg) return defaultOrg;
  throw new CliError(
    "usage",
    "No organization selected. Pass --org <org> or set a default with `gauge orgs use <slug>`.",
    { needsAccount: true },
  );
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
