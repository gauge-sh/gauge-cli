import type { summary } from "@withgauge/api-schemas";
import type { Command } from "commander";
import { createClient } from "../lib/client";
import { hostedOnly, resolveOrg, resolveOutput } from "../lib/context";
import { printJson } from "../lib/output";

function pct(rate: number | null): string {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}

function delta(pp: number | null): string {
  if (pp == null) return "";
  const rounded = Math.round(pp);
  return rounded === 0 ? "" : ` (${rounded > 0 ? "+" : ""}${rounded}pp)`;
}

export function register(program: Command): void {
  hostedOnly(program.command("status"))
    .description("One-shot org summary: actions, Agent Preference, agent experience")
    .action(async (_opts: unknown, cmd: Command) => {
      const org = resolveOrg(cmd);
      const s = await createClient().get<summary.HomeSummary>(
        `/api/v1/orgs/${encodeURIComponent(org)}/summary`,
      );
      if (resolveOutput(cmd) === "json") {
        printJson(s);
        return;
      }
      if (!s.hasAnyRuns) {
        console.log(
          "No runs yet. Create an eval (`gauge eval create`) or run one (`gauge run --eval <id>`).",
        );
        return;
      }
      console.log(`last synthesis: ${s.lastSynthesisAt ?? "never"}`);

      console.log("\nagent experience:");
      if (!s.agentExperience.ok) {
        console.log(`  (unavailable: ${s.agentExperience.error})`);
      } else if (s.agentExperience.data.cards.length === 0) {
        console.log("  (no judged runs in the last 30 days)");
      } else {
        for (const card of s.agentExperience.data.cards) {
          console.log(
            `  ${card.name}: ${pct(card.passRate)}${delta(card.deltaPP)} over ${card.judgedRuns} judged run(s)`,
          );
        }
        const extra =
          s.agentExperience.data.setCount - s.agentExperience.data.cards.length;
        if (extra > 0) console.log(`  (+${extra} more — see the dashboard)`);
      }

      console.log("\nAgent Preference:");
      if (!s.visibility.ok) {
        console.log(`  (unavailable: ${s.visibility.error})`);
      } else if (s.visibility.data.cards.length === 0) {
        console.log("  (no preference runs in the last 30 days)");
      } else {
        for (const card of s.visibility.data.cards) {
          const owned = card.owned
            ? `${card.owned.name} #${card.owned.rank}, chosen ${pct(card.owned.chosenRate)}${delta(card.chosenDeltaPP)}`
            : "no owned brand ranked";
          console.log(`  ${card.name}: ${owned}`);
        }
      }

      console.log("\nopen actions:");
      if (!s.actions.ok) {
        console.log(`  (unavailable: ${s.actions.error})`);
      } else if (s.actions.data.length === 0) {
        console.log("  (none)");
      } else {
        for (const a of s.actions.data.slice(0, 5)) {
          console.log(`  [${a.priority}] ${a.title} (${a.id})`);
        }
        if (s.actions.data.length > 5)
          console.log(
            `  (+${s.actions.data.length - 5} more — \`gauge actions list\`)`,
          );
      }
    });
}
