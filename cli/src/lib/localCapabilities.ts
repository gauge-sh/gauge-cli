import { CliError } from "./client";

export const LOCAL_MCP_HINT =
  "Gauge exposes no local MCP configuration for registered servers. Hosted sessions can discover and call their tools; supplied files cannot test the live server. If hosted testing is acceptable, start with `gauge onboard`, select a workspace and MCP version, configure any required connection, then preview with --hosted. Login and static verification do not establish server reachability or access. Hosted sessions use credits; previews contact Gauge and may upload inputs. Do not issue hosted commands for a local-only request. See `gauge instructions hillclimb`.";

export function assertLocalCapabilities(
  config: Record<string, unknown>,
  prefix = "",
): void {
  for (const field of [
    "profileId",
    "marketId",
    "skillRefs",
    "mcpRefs",
    "connectionIds",
  ]) {
    const value = config[field];
    if (Array.isArray(value) ? value.length > 0 : Boolean(value))
      throw new CliError(
        "usage",
        `${prefix}${field} requires hosted Gauge.`,
        {
          hint:
            field === "mcpRefs"
              ? LOCAL_MCP_HINT
              : "Use --hosted for personas and hosted assets, or select local files and Skills through named inputs in gauge.json.",
        },
      );
  }
  if (config.addons && Object.keys(config.addons).length > 0)
    throw new CliError("usage", `${prefix}addons requires hosted Gauge.`, {
      hint: "Managed browser addons are unavailable locally. Use --hosted or remove the addon.",
    });
}
