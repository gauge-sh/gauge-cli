import type { billing, orgs } from "@withgauge/api-schemas";
import type { Command } from "commander";
import { createClient } from "../lib/client";
import { hostedOnly, resolveOrg, resolveOutput } from "../lib/context";
import { printJson } from "../lib/output";
import { fmtOverage } from "./billing";

function printSettings(
  s: orgs.OrgSettings,
  billingStatus: billing.BillingStatus,
): void {
  console.log(`slug:            ${s.slug}`);
  console.log(`name:            ${s.name}`);
  console.log(`website:         ${s.website ?? "(none)"}`);
  console.log(
    `max spend/run:   ${s.maxSpendUsd == null ? "(server default)" : `$${s.maxSpendUsd}`}`,
  );
  console.log(`overage:         ${fmtOverage(billingStatus)}`);
  console.log(`auto-join:       ${s.autoJoinDomain ?? "off"}`);
}

export function register(program: Command): void {
  const group = hostedOnly(program.command("org"))
    .description(
      "This org's settings, read-only (see `gauge orgs` for the org list)",
    );

  group
    .command("get")
    .description("Show the org's settings (edit them in the web app)")
    .action(async (_opts: unknown, cmd: Command) => {
      const org = resolveOrg(cmd);
      const client = createClient();
      const base = `/api/v1/orgs/${encodeURIComponent(org)}`;
      const [settings, billingStatus] = await Promise.all([
        client.get<orgs.OrgSettings>(base),
        client.get<billing.BillingStatus>(`${base}/billing`),
      ]);
      if (resolveOutput(cmd) === "json")
        printJson({
          ...settings,
          paymentType: billingStatus.paymentType ?? null,
          creditLine: billingStatus.creditLine ?? null,
        });
      else printSettings(settings, billingStatus);
    });
}
