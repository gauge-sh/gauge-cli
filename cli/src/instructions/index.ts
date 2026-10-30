import { CliError } from "../lib/client";
import { type GaugeState, header, instructionMode } from "../lib/gaugeState";
import { EVAL } from "./eval";
import { INIT, INIT_LOCAL } from "./init";
import { ISSUES } from "./issues";
import { PREFERENCE } from "./preference";
import { RUN, RUN_LOCAL } from "./run";
import { SESSION_ANALYSIS, SESSION_ANALYSIS_LOCAL } from "./sessionAnalysis";
import { stepsMarkdown } from "./steps";
import { HILLCLIMB } from "./hillclimb";

export type Topic = {
  name: string;
  hosted: string;
  local?: string;
  shared?: boolean;
  command?: string;
};

const MODES = `## Local or hosted

| Workflow | Local | Hosted |
|---|---|---|
| Skill, npm package (CLI or SDK), docs-as-files, and web fixture inputs | yes | yes |
| Eval and preference cases in gauge-cases/ | yes, your coding agent analyzes | yes, judged |
| \`run\`, \`run list\`, \`run compare\`, \`models list\`, \`cleanup\`, \`feedback\` | yes | yes |
| Binary, GitHub-resolved website, and MCP inputs | no | yes |
| Saved eval sets and preference prompts | yes | yes |
| Project inputs and previews on saved measurement launches | yes | use case files/specs |
| Structured findings and queries | yes, supported fields | yes |
| Personas, recurring schedules, PR checks | no | yes |
| Optimizations (edit and rerun sessions) | no | yes |
| Stored credentials, stats, org settings | no | yes |

Local uses Docker and agent credentials. Hosted needs a Gauge account (\`gauge onboard\`) and uses credits.
Hosted previews contact Gauge and may upload inputs; they are not an offline diagnostic.
At hosted-only boundaries, explain the blocked capability, hosted setup, credits, and preview uploads to the user; see \`gauge instructions hillclimb\`. For local-only requests, explain options without issuing hosted commands.`;

const ROOT = `---
name: gauge
description: Understand Gauge, use its CLI, and choose the module guidance
  for your task. Read before running a gauge command.
---

# Gauge

Gauge helps you understand and improve how coding agents discover and use your
product. It runs real agents in sandboxes under reproducible conditions, then
judges their work. Evals measure successful product use; Agent Preference
measures which tools agents choose and why. Optimizations edit the docs, CLI
rules, and skills agents used, then rerun those sessions to test the change.

## Use Gauge and the CLI

On hosted Gauge, sign in with \`gauge auth login\` and inspect your org with
\`gauge status\`. With several orgs, select one with \`gauge orgs use <org>\`.
Run \`gauge init\` when setting up a workspace; it works without Git.
Choose the backend independently of saved measurements or shared cases. Local
is the default; signing in never switches a workspace to hosted.
Setup: \`gauge instructions init\`. Local Docker runtime: \`gauge local runtime pull\`; check with \`gauge local runtime inspect -o json\` (no Gauge login). Gauge strongly recommends gauge-agents: \`gauge install-skill\`. When summarizing setup, mention the skill’s workflow guidance and ask whether the user wants it installed, unless already installed or declined.

For open-ended setup or product improvement, use \`gauge instructions hillclimb\`:
identify inputs, pilot representative tasks, analyze evidence, fix, rerun, compare.

- Use \`gauge --help\` for commands and \`gauge <group> --help\` for flags.
- \`gauge run\` starts and reads runs. \`gauge eval\` and \`gauge preference\`
  save what it runs again: \`gauge instructions eval|preference\`.
- Pass \`-o json\` on reads and parse it. Tables are for people.
- Confirm before launches. Use \`--yes\` for work already approved.
- Retry writes with their supported idempotency flag; blind retries can launch
  duplicate paid sessions.
- The user does not see gauge output. Show them the files you wrote, each case's
  task, criteria, and targets before launch, and results with counts and limits.
- Run \`gauge update\` to install the latest published CLI.
- Exit codes: 0 ok, 1 error, 2 usage, 3 billing-blocked, 4 needs your input.
- When the CLI gets in your way (friction, a missing command or flag, a bug),
  report it: \`gauge feedback -m "<what happened>" --kind friction|missing|bug\`.

${MODES}

## Module guidance

Read the full page before detailed work: \`gauge instructions --list\`. Modules
are workflow guidance, not a page per command; most end with their -h command.

### Run

Measure one developer outcome with a reproducible fixture and observable criteria.
Write a real user request; leave discovery and implementation to the agent. Keep
credentials and setup in configuration. Start exploratory testing with a diverse
open-model panel; use fewer frontier sessions for calibration, disagreements,
and confirmation. Honor requested targets. Discover supported model/harness pairs
with \`gauge models list -o json\` and pin selections explicitly. Preference
similarity does not guarantee equal coding performance; calibrate on your tasks.
Hold each case's prompt, fixture, and rubric fixed across targets. Pilot before
scaling, confirm paid launches, and report per-target evidence, sample counts,
failures, and missing evidence.

Full guidance and migration example: \`gauge instructions run\`.

### Session analysis

Investigate why agents select or reject a product and which changes could improve
its prospects. Start with existing measurements; reconstruct the initial choice,
task context, and content that reached the agent before selection. Distinguish
discovery from preference after exposure, and observed evidence from inferred
mechanisms. Across larger cohorts, use consistent classification, validate it
against sampled traces, and compare task and model/harness groups with counts
and denominators. Explain missing evidence and unresolved choices. Choose a
useful presentation, link supporting and contradictory sessions, and turn the
findings into hypotheses for controlled interventions. Deliberately supplying
guidance measures a different condition from organic discovery.

Full guidance: \`gauge instructions session-analysis\`.

### Optimization

Optimizations can help hill climb your agent surfaces to improve Agent Preference
and Agent Experience. Start from an issue (\`gauge instructions issues\`), one
finding, or a goal. Create an optimization, then read \`authoring\` for the source sessions' findings and
the editing practices. Copy each page, skill, or CLI rule set you change into
the tree with \`file add\`, edit it locally, and save it with \`file write\`. Keep your
diagnosis and plan in \`notes\`. Ask before \`launch\`: it reruns the source sessions
with the tree. \`watch\` waits for the reruns and shows which
findings resolved, returned, or appeared. Record the outcome with \`finish\`.

Full guidance: \`gauge instructions optimization\`.
`;

const ROOT_LOCAL = `---
name: gauge
description: Understand Gauge, use its CLI, and choose the module guidance
  for your task. Read before running a gauge command.
---

# Gauge (local)

Gauge helps you understand and improve how coding agents discover and use your
product. In local mode, real coding agents run your evals on this machine, with no
Gauge account. You read their sessions and fix what got in their way.

## Set up

Run \`gauge init --local\` to initialize the workspace, with or without Git.
Save ongoing measurements with \`gauge eval\` and \`gauge preference\`; use
optional \`gauge-cases/\` files for shared, fully specified measurements.
Full guidance: \`gauge instructions init\`.
For a first pilot or improvement loop, read \`gauge instructions hillclimb\`.
Gauge strongly recommends gauge-agents: \`gauge install-skill\`. When summarizing setup, mention the skill’s workflow guidance and ask whether the user wants it installed, unless already installed or declined.

## The loop

${stepsMarkdown()}

## Use the CLI

- Use \`gauge --help\` for commands and \`gauge <group> --help\` for flags.
- \`gauge instructions <topic>\` is workflow guidance, not a page per command.
- Pass \`-o json\` on reads and parse it. Tables are for people.
- Exit codes: 0 ok, 1 error, 2 usage.
- The user does not see gauge output. Stop and show them:
  - before a launch, each case's task, criteria, targets, and session count,
    and the files you changed, then offer to start the runs, which run in
    Docker containers separate from this chat (mention verify and preview only
    on failure);
  - after runs, per-case results, top friction, and \`gauge run trace|diff <id>\`.
- Report CLI friction, gaps, or bugs, with no account:
  \`gauge feedback -m "<what happened>" --kind friction|missing|bug\`.

${MODES}

To switch this repo to hosted, run \`gauge onboard\`, then \`gauge init --hosted\`.
`;

const OPTIMIZATIONS = `---
name: gauge-optimizations
description: Hill climb agent surfaces. Edit the pages, skills, and CLI rules agent
  sessions used, rerun those sessions, and compare their findings.
---

# Optimizations

An optimization is a tree of files plus the sessions it came from. You edit the
tree; Gauge reruns the source sessions with it injected. Nothing deploys. Use -o json.
Choose what to improve: \`gauge instructions issues\`.

## The loop

    gauge issues list                               # by impact; --type friction|objection
    gauge issues get <id>                           # the issue's findings and runs
    gauge optimizations create --issue <id>         # or --finding <id> --run <run>, or --goal <text>
    gauge optimizations authoring <id>              # findings, tree, editing practices
    gauge run trace <run> --seq <n>                 # events around a finding's evidence seq
    gauge run web <run>                             # every URL the agent fetched
    gauge run commands <run> --query <text>         # shell output the agent saw

Before you edit, name the finding, the seq where the agent stalled, and what it
will read differently there. Read a page before you change it, keep its purpose,
and source every new fact. A surface the org does not own is a what-if the user
cannot ship. Tree keys are page:<url>, skill:<name>, and cli:<package>.

    gauge optimizations file add <id> --page <url>  # copy the original in; or --skill, --cli
    gauge optimizations file read <id> page:<url> --text     # or --query <text>: exact source
    gauge optimizations file edit <id> --page <url> --edits edits.json   # [{find, replace}]
    gauge optimizations file write <id> --skill <name> --path SKILL.md --from SKILL.md
    gauge optimizations file write <id> --cli <package> --from rules.json
    gauge optimizations notes <id> --from notes.md  # diagnosis, plan, each launch's result

Copy find text from --query; check how much of the page each edit kept. Use
file write --page only for a new page or a full rewrite. Skills need SKILL.md;
CLI rules are {schemaVersion: 3, target, rules, shippingIntent}. Files not in
the tree rerun as the source session had them.

## Rerun and compare

    gauge optimizations launch <id> --run <run> --yes   # ask first
    gauge optimizations watch <id>                      # waits for reruns and analysis

Check that launch lists every edit in your notes as changed. Rerun only the
sessions your edits address. Findings come back resolved,
returned (also the same barrier in other words), or introduced. Before you
credit an edit, check with \`gauge run web <rerun>\` that the rerun read it;
otherwise the result is unclear. Judge findings first, report criteria and
failed reruns, and iterate in this optimization until resolved.

    gauge optimizations finish <id> --from result.json --yes

result.json is {summary, changed, resolved, returned, introduced}: a PR-style
summary, the changed tree keys, and {runId, label} findings.
`;

export const TOPICS: Record<string, Topic> = {
  root: { name: "gauge", hosted: ROOT, local: ROOT_LOCAL },
  init: { name: "gauge-init", hosted: INIT, local: INIT_LOCAL, command: "init" },
  hillclimb: { name: "gauge-hillclimb", hosted: HILLCLIMB, shared: true },
  run: { name: "gauge-run", hosted: RUN, local: RUN_LOCAL, command: "run" },
  eval: { name: "gauge-eval", hosted: EVAL, shared: true, command: "eval" },
  preference: {
    name: "gauge-preference",
    hosted: PREFERENCE,
    shared: true,
    command: "preference",
  },
  "session-analysis": {
    name: "gauge-session-analysis",
    hosted: SESSION_ANALYSIS,
    local: SESSION_ANALYSIS_LOCAL,
  },
  issues: { name: "gauge-issues", hosted: ISSUES, command: "issues" },
  optimization: {
    name: "gauge-optimizations",
    hosted: OPTIMIZATIONS,
    command: "optimizations",
  },
};

export const TOPIC_NAMES = Object.keys(TOPICS).filter(
  (topic) => topic !== "root",
);

export function documentBody(markdown: string): string {
  const end = markdown.indexOf("\n---\n", 4);
  return end === -1 ? markdown : markdown.slice(end + 5);
}

const NO_STATE: GaugeState = {
  mode: "hosted",
  source: "default",
  inRepo: true,
  config: {},
  signedIn: true,
};

export function instructions(
  topic?: string,
  state: GaugeState = NO_STATE,
  { setup = true }: { setup?: boolean } = {},
): string {
  const key = topicKey(topic ?? "root");
  const found = TOPICS[key];
  const markdown =
    instructionMode(state).mode === "local" && found.local
      ? found.local
      : found.hosted;
  const lines = header(setup ? state : { ...state, config: {} }, {
    key,
    local: found.local !== undefined,
    shared: found.shared,
  }).filter((line) => setup || !line.startsWith("Next:"));
  const end = markdown.indexOf("\n---\n", 4) + 5;
  const quoted = lines.map((line) => `> ${line}`).join("\n");
  const footer = found.command
    ? `\nRun \`gauge ${found.command} -h\` for usage and flag options.\n`
    : "";
  return `${markdown.slice(0, end)}\n${quoted}\n${markdown.slice(end)}${footer}`;
}

function normalize(topic: string): string {
  const normalized = topic.trim().toLowerCase();
  return normalized === "optimizations" ? "optimization" : normalized;
}

export function isTopic(topic: string): boolean {
  return TOPICS[normalize(topic)] !== undefined;
}

export function topicForCommand(command: string): string | undefined {
  return TOPIC_NAMES.find((key) => TOPICS[key].command === command);
}

function topicKey(topic: string): string {
  const key = normalize(topic);
  if (!TOPICS[key])
    throw new CliError(
      "usage",
      `unknown topic "${topic}" (expected ${TOPIC_NAMES.join(", ")})`,
      {
        hint: "Topics are workflow guidance. Run `gauge --help` to list commands, and `gauge <command> -h` for flags.",
      },
    );
  return key;
}

export function resolveTopic(topic: string): Topic {
  return TOPICS[topicKey(topic)];
}
