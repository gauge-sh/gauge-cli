import type { Command } from "commander";
import { createClient } from "../lib/client";
import { hostedOnly, resolveOrg, resolveOutput } from "../lib/context";
import { printItems, printJson } from "../lib/output";

type IssueRow = {
  id: string;
  title: string;
  description: string;
  sessions: number;
  wentTo: { name: string; sessions: number }[];
  impact: { effect: string; sessions: number }[] | null;
};

type IssueBlock = {
  product: string;
  kind: string;
  headline: string;
  sessions: number;
  total: number;
  issues: IssueRow[];
  ungrouped: number;
};

type IssueDetail = {
  id: string;
  kind: string;
  product: string;
  title: string;
  description: string;
  instances: {
    id: string;
    runId: string;
    label: string;
    detail: string;
    effect: string;
    agent: string;
    model: string;
    chose: string[];
  }[];
};

function issuesPath(org: string): string {
  return `/api/v1/orgs/${encodeURIComponent(org)}/issues`;
}

export function impactLine(issue: Pick<IssueRow, "impact" | "wentTo">) {
  if (issue.impact)
    return issue.impact
      .map((i) => `${i.effect.toLowerCase().replace("_", " ")} ${i.sessions}`)
      .join(", ");
  return issue.wentTo.map((w) => `${w.name} ${w.sessions}`).join(", ");
}

export function register(program: Command): void {
  const group = hostedOnly(program.command("issues")).description(
    "The same finding across many sessions, by impact. Also called findings",
  );

  group
    .command("list")
    .description(
      "Issues per owned product, most sessions first: problems from evals, or --reasons from preference prompts",
    )
    .option("--reasons", "why agents passed on your product")
    .action(async (opts: { reasons?: boolean }, cmd: Command) => {
      const res = await createClient().get<{ blocks: IssueBlock[] }>(
        issuesPath(await resolveOrg(cmd)),
        { kind: opts.reasons ? "reasons" : "problems" },
      );
      if (resolveOutput(cmd) === "json") return printJson(res.blocks);
      if (!res.blocks.length)
        console.log(
          "No issues yet. Issues group the findings from analyzed eval and preference runs.",
        );
      for (const block of res.blocks) {
        console.log(`\n${block.product}: ${block.headline}`);
        printItems(
          block.issues.map((issue) => ({
            id: issue.id,
            sessions: issue.sessions,
            title: issue.title,
            [block.kind === "OBJECTION" ? "went to" : "impact"]:
              impactLine(issue),
          })),
          "table",
        );
        if (block.ungrouped)
          console.log(
            `${block.ungrouped} more finding${block.ungrouped === 1 ? " is" : "s are"} not in an issue yet`,
          );
      }
    });

  group
    .command("get <id>")
    .description(
      "One issue and its findings: run, finding id, effect, and agent",
    )
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const issue = await createClient().get<IssueDetail>(
        `${issuesPath(await resolveOrg(cmd))}/${encodeURIComponent(id)}`,
      );
      if (resolveOutput(cmd) === "json") return printJson(issue);
      console.log(`${issue.title} (${issue.product}, ${issue.kind})`);
      console.log(issue.description);
      printItems(
        issue.instances.map((f) => ({
          run: f.runId,
          finding: f.id,
          effect: f.effect,
          agent: `${f.agent} ${f.model}`,
          label: f.label,
        })),
        "table",
      );
    });
}
