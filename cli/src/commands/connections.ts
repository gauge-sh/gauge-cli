import type { connections } from "@withgauge/api-schemas";
import type { Command } from "commander";
import { createClient } from "../lib/client";
import { hostedOnly, resolveOrg, resolveOutput } from "../lib/context";
import { printItems, printJson } from "../lib/output";

function connectionsPath(org: string): string {
  return `/api/v1/orgs/${encodeURIComponent(org)}/connections`;
}

export function register(program: Command): void {
  const group = hostedOnly(program.command("connections"))
    .description("Inspect the org's stored credentials (no secrets)");

  group
    .command("list")
    .description("List credentials with the ids --connection accepts")
    .action(async (_opts: unknown, cmd: Command) => {
      const org = await resolveOrg(cmd);
      const res = await createClient().get<connections.ListConnectionsResponse>(
        connectionsPath(org),
      );
      if (resolveOutput(cmd) === "json") {
        printJson(res.items);
        return;
      }
      printItems(
        res.items.map((c) => ({
          id: c.id,
          name: c.handle,
          vendor: c.profileLabel,
          placeholder: [c.credentialKey, c.basicPasswordKey]
            .filter(Boolean)
            .join(", "),
          domains: c.allowedHosts.join(", "),
          kind: c.kind,
          value: c.last4 ? `····${c.last4}` : "",
        })),
        "table",
      );
    });
}
