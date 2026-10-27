import { type Command, Option } from "commander";
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

const TYPES = { friction: "problems", objection: "reasons" } as const;
type IssueType = keyof typeof TYPES;

export type ListedIssue = IssueRow & { type: IssueType; product: string };

export function flattenBlocks(
  type: IssueType,
  blocks: IssueBlock[],
): { issues: ListedIssue[]; ungrouped: number } {
  return {
    issues: blocks.flatMap((block) =>
      block.issues.map((issue) => ({ ...issue, type, product: block.product })),
    ),
    ungrouped: blocks.reduce((sum, block) => sum + block.ungrouped, 0),
  };
}

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
      "Friction and objections across your products, most sessions first",
    )
    .addOption(
      new Option("--type <type>", "only this type").choices(Object.keys(TYPES)),
    )
    .action(async (opts: { type?: IssueType }, cmd: Command) => {
      const org = await resolveOrg(cmd);
      const types = opts.type
        ? [opts.type]
        : (Object.keys(TYPES) as IssueType[]);
      const results = await Promise.all(
        types.map(async (type) => {
          const res = await createClient().get<{ blocks: IssueBlock[] }>(
            issuesPath(org),
            { kind: TYPES[type] },
          );
          return flattenBlocks(type, res.blocks);
        }),
      );
      const issues = results
        .flatMap((r) => r.issues)
        .sort((a, b) => b.sessions - a.sessions);
      if (resolveOutput(cmd) === "json") return printJson(issues);
      if (!issues.length)
        console.log(
          "No issues yet. Issues group the findings from analyzed eval and preference runs.",
        );
      else
        printItems(
          issues.map((issue) => ({
            id: issue.id,
            type: issue.type,
            product: issue.product,
            sessions: issue.sessions,
            title: issue.title,
            impact: impactLine(issue),
          })),
          "table",
        );
      const ungrouped = results.reduce((sum, r) => sum + r.ungrouped, 0);
      if (ungrouped)
        console.log(
          `${ungrouped} more finding${ungrouped === 1 ? " is" : "s are"} not in an issue yet`,
        );
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
