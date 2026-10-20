import type { billing } from "@withgauge/api-schemas";
import type { Command } from "commander";
import { createClient } from "../lib/client";
import { hostedOnly, resolveOrg, resolveOutput } from "../lib/context";
import { printJson } from "../lib/output";

type BillingStatus = billing.BillingStatus;

function fmtDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}

export function fmtOverage(s: BillingStatus): string {
  const line = s.creditLine;
  if (!line) return s.paymentType === "card" ? "n/a (card)" : "—";
  if (line.limitUsd <= 0) return "off (credit line limit $0)";
  return `$${line.usedUsd.toFixed(2)} of $${line.limitUsd.toFixed(2)} credit line`;
}

function statusLines(s: BillingStatus): [string, string][] {
  return [
    ["Plan", s.plan ?? "free"],
    ["Subscription", s.subscriptionStatus ?? "—"],
    ["Payment", s.paymentType ?? "—"],
    ["Balance", `${s.balance} credits`],
    [
      "Allowance / cycle",
      s.allowance === null ? "—" : `${s.allowance} credits`,
    ],
    [
      "Period",
      s.currentPeriodStart || s.currentPeriodEnd
        ? `${fmtDate(s.currentPeriodStart)} → ${fmtDate(s.currentPeriodEnd)}`
        : "—",
    ],
    ["Used this period", `${s.creditsUsedThisPeriod} credits`],
    ["Runs this period", String(s.runsThisPeriod)],
    ["Overage", fmtOverage(s)],
    ["Can run eval", s.canRunByWorkload.eval ? "yes" : "no"],
    ["Can run preference", s.canRunByWorkload.visibility ? "yes" : "no"],
    ["Can run generic", s.canRunByWorkload.generic ? "yes" : "no"],
    ["Billing enforced", s.enforced ? "yes" : "no"],
  ];
}

export function register(program: Command): void {
  const group = hostedOnly(program.command("billing"))
    .description("Billing & credits");

  group
    .command("status")
    .description("Show credit balance, plan, payment, and overage")
    .action(async (_opts: unknown, cmd: Command) => {
      const org = resolveOrg(cmd);
      const status = await createClient().get<BillingStatus>(
        `/api/v1/orgs/${encodeURIComponent(org)}/billing`,
      );
      if (resolveOutput(cmd) === "json") {
        printJson(status);
        return;
      }
      const lines = statusLines(status);
      const width = Math.max(...lines.map(([label]) => label.length));
      for (const [label, value] of lines) {
        console.log(`${label.padEnd(width)}  ${value}`);
      }
    });
}
