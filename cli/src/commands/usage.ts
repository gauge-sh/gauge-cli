import type { billing, ListResponse } from "@withgauge/api-schemas";
import type { Command } from "commander";
import { createClient } from "../lib/client";
import { hostedOnly, resolveOrg, resolveOutput } from "../lib/context";
import { parseLimit } from "../lib/flags";
import { printItems, printJson } from "../lib/output";

type UsageEntry = billing.UsageEntry;

export function register(program: Command): void {
  hostedOnly(program.command("usage"))
    .description("List credit ledger entries")
    .option("--since <window>", 'e.g. "30d", "24h", or an ISO date')
    .option("--limit <n>", "page size (1-200)", parseLimit, 50)
    .option("--cursor <cursor>", "resume from a previous page's nextCursor")
    .action(
      async (
        opts: { since?: string; limit: number; cursor?: string },
        cmd: Command,
      ) => {
        const org = resolveOrg(cmd);
        const res = await createClient().get<ListResponse<UsageEntry>>(
          `/api/v1/orgs/${encodeURIComponent(org)}/usage`,
          { since: opts.since, limit: opts.limit, cursor: opts.cursor },
        );
        if (resolveOutput(cmd) === "json") {
          printJson(res);
          return;
        }
        printItems(
          res.items.map((e) => ({
            createdAt: e.createdAt,
            kind: e.kind,
            delta: e.delta,
            runId: e.runId ?? "",
          })),
          "table",
        );
        if (res.items.length === 0 && !opts.cursor) {
          try {
            const status = await createClient().get<billing.BillingStatus>(
              `/api/v1/orgs/${encodeURIComponent(org)}/billing`,
            );
            if (!status.enforced) {
              process.stderr.write(
                "Billing is not enforced for this org, so runs don't create ledger entries.\n",
              );
            }
          } catch {
          }
        }
        if (res.nextCursor) {
          process.stderr.write(
            `(more results — rerun with --cursor ${res.nextCursor})\n`,
          );
        }
      },
    );
}
