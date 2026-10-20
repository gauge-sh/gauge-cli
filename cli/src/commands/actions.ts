import type { actions } from "@withgauge/api-schemas";
import type { Command } from "commander";
import { CliError, createClient } from "../lib/client";
import { hostedOnly, resolveOrg, resolveOutput } from "../lib/context";
import { printItems, printJson } from "../lib/output";

function actionsPath(org: string): string {
  return `/api/v1/orgs/${encodeURIComponent(org)}/actions`;
}

const STATUS_CHOICES = ["open", "resolved", "dismissed"] as const;

function parseStatus(raw: string): actions.ActionStatus {
  const upper = raw.trim().toUpperCase();
  if (!["OPEN", "RESOLVED", "DISMISSED"].includes(upper))
    throw new CliError(
      "usage",
      `invalid status "${raw}" (expected: ${STATUS_CHOICES.join(" | ")})`,
    );
  return upper as actions.ActionStatus;
}

export function register(program: Command): void {
  const group = hostedOnly(program.command("actions"))
    .description("The action center: recommended follow-ups");

  group
    .command("list")
    .description("List actions, highest-leverage first")
    .option("--status <status>", "filter: open | resolved | dismissed (csv)")
    .action(async (opts: { status?: string }, cmd: Command) => {
      const org = resolveOrg(cmd);
      const res = await createClient().get<actions.ListActionsResponse>(
        actionsPath(org),
        {
          status:
            opts.status === undefined
              ? undefined
              : opts.status
                  .split(",")
                  .map((s) => parseStatus(s))
                  .join(","),
        },
      );
      if (resolveOutput(cmd) === "json") printJson(res.items);
      else
        printItems(
          res.items.map((a) => ({
            id: a.id,
            priority: a.priority,
            status: a.status,
            title: a.title,
            evidence: a.evidenceCount,
            surface: a.sourceType,
          })),
          "table",
        );
    });

  group
    .command("status <id> <status>")
    .description("Transition an action: open | resolved | dismissed")
    .option("--note <text>", "resolution note (recorded when closing)")
    .action(
      async (
        id: string,
        status: string,
        opts: { note?: string },
        cmd: Command,
      ) => {
        const org = resolveOrg(cmd);
        const updated = await createClient().patch<actions.Action>(
          `${actionsPath(org)}/${encodeURIComponent(id)}`,
          { status: parseStatus(status), note: opts.note },
        );
        if (resolveOutput(cmd) === "json") printJson(updated);
        else console.log(`Action ${updated.id} is now ${updated.status}`);
      },
    );
}
