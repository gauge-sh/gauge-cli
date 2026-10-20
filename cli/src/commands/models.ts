import type { executionTargets } from "@withgauge/api-schemas";
import type { Command } from "commander";
import { createClient } from "../lib/client";
import { resolveOrg, resolveOutput } from "../lib/context";
import { gaugeState } from "../lib/gaugeState";
import { LOCAL_AGENTS } from "../lib/localExecutor";
import { printItems, printJson } from "../lib/output";

export function executionTargetsPath(org: string): string {
  return `/api/v1/orgs/${encodeURIComponent(org)}/execution-targets`;
}

export function capabilityLabel(
  capabilities: executionTargets.ExecutionTargetCapabilities,
): string {
  return Object.entries(capabilities)
    .filter(([, supported]) => supported)
    .map(([name]) => (name === "agentContext" ? "context" : name))
    .join(", ");
}

export function register(program: Command): void {
  const group = program
    .command("models")
    .description("Discover supported models, harnesses, and providers");

  group
    .command("list", { isDefault: true })
    .description(
      "List execution targets available to the organization. Local: the agents local runs support, with default models",
    )
    .action(async (_opts: unknown, cmd: Command) => {
      if (gaugeState(cmd).mode === "local") {
        const agents = Object.entries(LOCAL_AGENTS).map(([agent, target]) => ({
          agent,
          harness: target.kind,
          defaultModel: target.model,
        }));
        if (resolveOutput(cmd) === "json") printJson(agents);
        else printItems(agents, "table");
        return;
      }
      const org = resolveOrg(cmd);
      const response =
        await createClient().get<executionTargets.ExecutionTargetsResponse>(
          executionTargetsPath(org),
        );
      if (resolveOutput(cmd) === "json") {
        printJson(response.items);
        return;
      }
      printItems(
        response.items.map((target) => ({
          model: target.model,
          name: target.modelLabel,
          harness: target.harnessSlug,
          provider: target.providerSlug,
          capabilities: capabilityLabel(target.capabilities),
        })),
        "table",
      );
    });
}
