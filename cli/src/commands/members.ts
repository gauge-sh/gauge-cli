import type { invites, orgs } from "@withgauge/api-schemas";
import type { Command } from "commander";
import { createClient } from "../lib/client";
import { hostedOnly, resolveOrg, resolveOutput } from "../lib/context";
import { printItems, printJson } from "../lib/output";

export function register(program: Command): void {
  const group = hostedOnly(program.command("members"))
    .description("Team members and pending invites (read-only)");

  group
    .command("list")
    .description("List members and pending invites")
    .action(async (_opts: unknown, cmd: Command) => {
      const org = await resolveOrg(cmd);
      const client = createClient();
      const base = `/api/v1/orgs/${encodeURIComponent(org)}`;
      const [members, pending] = await Promise.all([
        client.get<orgs.ListMembersResponse>(`${base}/members`),
        client.get<invites.ListInvitesResponse>(`${base}/invites`),
      ]);
      if (resolveOutput(cmd) === "json") {
        printJson({ members: members.items, invites: pending.items });
        return;
      }
      printItems(
        members.items.map((m) => ({
          email: m.email ?? "",
          name: m.name ?? "",
          joined: m.joinedAt,
        })),
        "table",
      );
      if (pending.items.length > 0) {
        console.log("\npending invites:");
        printItems(
          pending.items.map((i) => ({
            id: i.id,
            email: i.email,
            "invited by": i.invitedBy.email ?? i.invitedBy.name ?? "",
            expires: i.expiresAt,
          })),
          "table",
        );
      }
    });
}
