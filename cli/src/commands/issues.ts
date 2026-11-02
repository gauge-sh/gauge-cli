import { type Command, Option } from "commander";
import { createClient } from "../lib/client";
import { hostedOnly, resolveOrg, resolveOutput } from "../lib/context";
import { printItems, printJson } from "../lib/output";

type IssueStatus = "OPEN" | "FIXED" | "MUTED";

type IssueState = {
  status: IssueStatus;
  statusAt: string | null;
  statusBy: string | null;
  cameBackAt: string | null;
  check: {
    status: "RUNNING" | "VERIFIED" | "STILL_SEEN" | "INCONCLUSIVE";
    sessions: number | null;
    seen: number | null;
    createdAt: string;
    runs?: { runId: string; status: string; seen: boolean | null }[];
  } | null;
};

type IssueRow = {
  id: string;
  title: string;
  description: string;
  sessions: number;
  wentTo: { name: string; sessions: number }[];
  impact: { effect: string; sessions: number }[] | null;
  issue: IssueState;
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

type IssueDetail = IssueState & {
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

type PastRun = {
  sourceRunId: string;
  title: string;
  agent: string;
  model: string;
  modelName: string | null;
  sessions: number;
  recommended: boolean;
};

const TYPES = { friction: "problems", objection: "reasons" } as const;
type IssueType = keyof typeof TYPES;
const STATUSES = ["open", "fixed", "muted", "all"] as const;

/** One line on where an issue stands. */
export function statusLine(issue: IssueState): string {
  const { check } = issue;
  if (check?.status === "RUNNING")
    return `${issue.status.toLowerCase()}, recheck running`;
  if (issue.status === "FIXED")
    return `fixed${issue.statusBy ? ` by ${issue.statusBy}` : ""}`;
  if (issue.status === "MUTED")
    return `muted${issue.statusBy ? ` by ${issue.statusBy}` : ""}`;
  if (issue.cameBackAt) return "open, came back after a fix";
  const fresh =
    check && (issue.statusAt == null || check.createdAt > issue.statusAt);
  if (fresh && check.status === "VERIFIED")
    return `open, looks fixed: 0 of ${check.sessions} runs on the last recheck`;
  if (fresh && check.status === "STILL_SEEN")
    return `open, still seen in ${check.seen} of ${check.sessions} runs on the last recheck`;
  return "open";
}

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
    .addOption(
      new Option("--status <status>", "only issues with this status")
        .choices(STATUSES)
        .default("open"),
    )
    .action(
      async (
        opts: { type?: IssueType; status: (typeof STATUSES)[number] },
        cmd: Command,
      ) => {
      const org = await resolveOrg(cmd);
      const types = opts.type
        ? [opts.type]
        : (Object.keys(TYPES) as IssueType[]);
      const results = await Promise.all(
        types.map(async (type) => {
          const res = await createClient().get<{ blocks: IssueBlock[] }>(
            issuesPath(org),
            { kind: TYPES[type], status: opts.status },
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
            status: statusLine(issue.issue),
            impact: impactLine(issue),
          })),
          "table",
        );
      const ungrouped = results.reduce((sum, r) => sum + r.ungrouped, 0);
      if (ungrouped)
        console.log(
          `${ungrouped} more finding${ungrouped === 1 ? " is" : "s are"} not in an issue yet`,
        );
      },
    );

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
      console.log(`Status: ${statusLine(issue)}`);
      const reruns = issue.check?.runs ?? [];
      if (reruns.length)
        console.log(
          `Last recheck: ${reruns
            .map(
              (r) =>
                `${r.runId} ${r.seen ? "showed it" : r.seen === false ? "clean" : r.status.toLowerCase()}`,
            )
            .join(", ")}`,
        );
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

  for (const [name, status, description] of [
    ["fix", "FIXED", "Mark an issue fixed. It reopens if agents hit it again"],
    ["mute", "MUTED", "Mute an issue. New findings still collect, but it never reopens"],
    ["reopen", "OPEN", "Move a fixed or muted issue back to open"],
  ] as const)
    group
      .command(`${name} <id>`)
      .description(description)
      .action(async (id: string, _opts: unknown, cmd: Command) => {
        const res = await createClient().patch<{ id: string; status: IssueStatus }>(
          `${issuesPath(await resolveOrg(cmd))}/${encodeURIComponent(id)}`,
          { status },
        );
        if (resolveOutput(cmd) === "json") return printJson(res);
        console.log(`${res.id} is ${res.status.toLowerCase()}`);
      });

  group
    .command("recheck <id>")
    .alias("verify")
    .description(
      "Preview, then with --confirm rerun, past runs that showed an issue (spends credits). `issues get` shows which still show it; a fixed issue that shows it reopens",
    )
    .option(
      "--run <runId...>",
      "the past runs to repeat, from the preview (default: the 3 checked ones, at most 10)",
    )
    .option("--confirm", "launch the reruns; without it, only preview them")
    .action(
      async (
        id: string,
        opts: { run?: string[]; confirm?: boolean },
        cmd: Command,
      ) => {
        const path = `${issuesPath(await resolveOrg(cmd))}/${encodeURIComponent(id)}/recheck`;
        const json = resolveOutput(cmd) === "json";
        if (!opts.confirm) {
          const { runs } = await createClient().get<{ runs: PastRun[] }>(path);
          const picked = new Set(
            opts.run ??
              runs.filter((r) => r.recommended).map((r) => r.sourceRunId),
          );
          if (json)
            return printJson({
              runs: runs.map((r) => ({
                ...r,
                picked: picked.has(r.sourceRunId),
              })),
              confirm: `gauge issues recheck ${id}${opts.run ? ` --run ${opts.run.join(" ")}` : ""} --confirm`,
            });
          console.log(
            `Recheck would rerun ${picked.size} of ${runs.length} past runs (the latest per prompt, agent, and model):`,
          );
          printItems(
            runs.map((r) => ({
              picked: picked.has(r.sourceRunId) ? "✓" : "",
              run: r.sourceRunId,
              prompt: r.title,
              agent: `${r.agent} ${r.modelName ?? r.model}`,
              "seen in": r.sessions,
            })),
            "table",
          );
          console.log(`Run it:  gauge issues recheck ${id}${opts.run ? ` --run ${opts.run.join(" ")}` : ""} --confirm`);
          console.log(`Choose:  gauge issues recheck ${id} --run <runId>... --confirm`);
          return;
        }
        const res = await createClient().post<{
          checkId: string;
          runIds: string[];
        }>(path, opts.run ? { runIds: opts.run } : {});
        if (json) return printJson(res);
        console.log(
          `Started ${res.runIds.length} run${res.runIds.length === 1 ? "" : "s"}. When they are analyzed, see the result with: gauge issues get ${id}`,
        );
      },
    );
}
