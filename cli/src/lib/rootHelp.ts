import type { Command, Help } from "commander";
import { topicForCommand } from "../instructions";
import { header, readGaugeState } from "./gaugeState";
import { style } from "./output";
import { CLI_VERSION } from "../version";

const EXAMPLES: [string, string][] = [
  ["gauge init --local", "Initialize a workspace; creates no measurements"],
  ["gauge instructions hillclimb", "Choose inputs and prepare a first pilot"],
  ["gauge eval create --help", "Save a task and success criteria"],
  ["gauge run --eval <id> --local", "Run a saved eval; rerun after input changes"],
];

const GROUPS: [string, Record<string, string>][] = [
  [
    "Get started",
    {
      instructions: "Instructions for coding agents",
      init: "Initialize a Gauge workspace",
      local: "Configure local execution",
      "install-skill": "Install the Gauge agent skill",
      onboard: "Sign in and set up your workspace",
      status: "One-shot org summary (Gauge account)",
    },
  ],
  [
    "Evals (local or hosted)",
    {
      eval: "Manage saved evals",
      preference: "Manage saved preference prompts",
      run: "Start runs and read them",
      query: "Query local runs and findings or hosted analytics",
      cleanup: "Clean interrupted local sessions",
      models: "List models, harnesses, and providers",
    },
  ],
  [
    "Hosted tools (Gauge account)",
    {
      personas: "Manage simulated-user personas",
      skills: "Manage agent skills",
      mcp: "Manage MCP servers",
      optimizations: "Edit what agents read and rerun their sessions",
    },
  ],
  [
    "Insights (Gauge account)",
    {
      stats: "Analytics over your runs",
      dashboards: "Saved dashboards",
      issues: "The same finding across many sessions (also called findings)",
    },
  ],
  [
    "Gauge Chat (AI visibility)",
    {
      chat: "Prompts, topics, answers, citations, queries",
    },
  ],
  [
    "Organization (Gauge account)",
    {
      orgs: "List and switch organizations",
      org: "This org's settings",
      members: "Team members and invites",
      repos: "Manage repositories",
      connections: "Stored credentials (no secrets)",
      keys: "Manage BYOK provider keys",
      brands: "Manage org brands",
      tags: "Manage org tags",
      billing: "Billing and credits",
      usage: "Credit ledger entries",
    },
  ],
  [
    "Account",
    {
      auth: "Sign in, sign out, and tokens",
      whoami: "Show the signed-in user",
    },
  ],
  [
    "CLI",
    {
      config: "Manage local CLI config",
      telemetry: "Enable or disable anonymous CLI usage telemetry",
      update: "Update to the latest version",
      feedback: "Send feedback to the Gauge team",
    },
  ],
];

function formatIntro(
  lines: string[],
  helper: Help,
  width: number,
  code: (text: string) => string,
  spaced = false,
): string[] {
  return lines.flatMap((line, i) => {
    const bullet = line.startsWith("- ");
    const indent = bullet ? "  " : "";
    const gap =
      spaced && i > 0 && !bullet && !lines[i - 1].startsWith("- ") ? [""] : [];
    const text = (bullet ? line.slice(2) : line).replace(
      /`([^`]+)`/g,
      (span, inner: string) => {
        const styled = code(inner);
        return (styled === inner ? span : styled).replaceAll(" ", "\0");
      },
    );
    return [
      ...gap,
      ...helper
        .boxWrap(text, width - indent.length)
        .replaceAll("\0", " ")
        .split("\n")
        .map((row, j) => (j === 0 && bullet ? "- " : indent) + row),
    ];
  });
}

function padFor(rows: string[][]): number {
  return Math.max(...rows.map(([term]) => term.length)) + 2;
}

function formatTable(
  rows: string[][],
  indent: string,
  helper: Help,
  width: number,
  color: (text: string) => string,
  pad = padFor(rows),
): string[] {
  return rows.flatMap(([term, text]) => {
    const [first, ...rest] = helper
      .boxWrap(text, width - indent.length - pad)
      .split("\n");
    const head = `${indent}${color(term.padEnd(pad))}${first}`;
    if (term.length >= pad)
      return [
        `${indent}${color(term)}`,
        ...[first, ...rest].map((row) => indent + " ".repeat(pad) + row),
      ];
    return [head, ...rest.map((row) => indent + " ".repeat(pad) + row)];
  });
}

function firstClause(text: string): string {
  return text.split(/[.:;(]| — /)[0].trim();
}

export function formatRootHelp(program: Command, helper: Help): string {
  const bold = style("1");
  const dim = style("2");
  const green = style("32");
  const width = helper.helpWidth ?? 80;
  const state = readGaugeState(program.opts());
  const visible = new Map(
    helper
      .visibleCommands(program)
      .filter((cmd) => cmd.name() !== "help")
      .map((cmd) => [cmd.name(), cmd]),
  );

  const sections = GROUPS.map(([title, summaries]): [string, string[][]] => [
    title,
    Object.entries(summaries).filter(([name]) => visible.delete(name)),
  ]);
  if (visible.size)
    sections.push([
      "Other",
      [...visible.values()].map((cmd) => [
        cmd.name(),
        firstClause(cmd.summary() || cmd.description()),
      ]),
    ]);
  const options = helper
    .visibleOptions(program)
    .map((option) => [
      helper.optionTerm(option),
      firstClause(option.description),
    ]);

  const table = (rows: string[][], indent: string, pad?: number) =>
    formatTable(rows, indent, helper, width, green, pad);
  const commandPad = padFor(sections.flatMap(([, rows]) => rows));

  const lines = [
    "",
    `${bold("Gauge CLI")} ${dim(`v${CLI_VERSION}`)}`,
    "",
    ...formatIntro(
      program.description().split(/(?<=\.) /),
      helper,
      width,
      green,
    ),
    "",
    ...formatIntro(
      [
        "Gauge strongly recommends the gauge-agents skill for coding agents: `gauge install-skill`. It makes Gauge workflow guidance discoverable in future sessions.",
        ...header(state, undefined, true),
      ],
      helper,
      width,
      green,
      true,
    ),
    "",
    bold(" EXAMPLES"),
    ...table(EXAMPLES, "   "),
    "",
    bold(" COMMANDS"),
  ];
  for (const [title, rows] of sections) {
    if (!rows.length) continue;
    lines.push("", bold(`   ${title}`), ...table(rows, "     ", commandPad));
  }
  lines.push(
    "",
    bold(" OPTIONS"),
    ...table(options, "   "),
    "",
    ` Run ${green("gauge <command> --help")} for details on any command.`,
    "",
  );
  return lines.join("\n");
}

export function formatCommandHelp(cmd: Command, helper: Help): string {
  const bold = style("1");
  const green = style("32");
  const width = helper.helpWidth ?? 80;
  const path: string[] = [];
  for (let c: Command | null = cmd; c; c = c.parent) path.unshift(c.name());
  const name = path.join(" ");
  const usage = [name, cmd.usage()].join(" ");
  let root = cmd;
  while (root.parent) root = root.parent;
  const rows = {
    ARGUMENTS: helper
      .visibleArguments(cmd)
      .map((arg) => [
        helper.argumentTerm(arg),
        helper.argumentDescription(arg),
      ]),
    COMMANDS: helper
      .visibleCommands(cmd)
      .filter((sub) => sub.name() !== "help")
      .map((sub) => [
        helper.subcommandTerm(sub),
        helper.subcommandDescription(sub),
      ]),
    OPTIONS: helper
      .visibleOptions(cmd)
      .map((option) => [
        helper.optionTerm(option),
        helper.optionDescription(option),
      ]),
    "GLOBAL OPTIONS": helper
      .visibleGlobalOptions(cmd)
      .filter(
        (option) =>
          root.options.includes(option) && option.long !== "--version",
      )
      .map((option) => [
        helper.optionTerm(option),
        helper.optionDescription(option),
      ]),
  };
  const pad = Math.min(
    padFor(
      Object.values(rows)
        .flat()
        .concat([["", ""]]),
    ),
    Math.floor(width / 3),
  );

  const lines = [
    "",
    bold(name) + (cmd.aliases().length ? ` (${cmd.aliases().join(", ")})` : ""),
  ];
  const description = helper.commandDescription(cmd);
  if (description)
    lines.push(
      "",
      ...formatIntro(description.split("\n"), helper, width - 1, green).map(
        (row) => ` ${row}`,
      ),
    );
  lines.push("", bold(" USAGE"), `   ${usage}`);
  for (const [title, items] of Object.entries(rows)) {
    if (!items.length) continue;
    lines.push(
      "",
      bold(` ${title}`),
      ...formatTable(items, "   ", helper, width, green, pad),
    );
  }
  if (rows.COMMANDS.length)
    lines.push(
      "",
      ` Run ${green(`${name} <command> --help`)} for details on any command.`,
    );
  const topic = path[1] && topicForCommand(path[1]);
  if (topic)
    lines.push(
      "",
      ` Run ${green(`gauge instructions ${topic}`)} for explicit guidance.`,
    );
  lines.push("");
  return lines.join("\n");
}
