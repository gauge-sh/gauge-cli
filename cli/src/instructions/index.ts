import { CliError } from "../lib/client";
import { type GaugeState, header, instructionMode } from "../lib/gaugeState";
import { EVAL } from "./eval";
import { INIT } from "./init";
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
| Skill, npm package (CLI or SDK), and docs-as-files inputs | yes | yes |
| Eval and preference cases in gauge-cases/ | yes, your coding agent analyzes | yes, judged |
| \`run\`, \`run list\`, \`run compare\`, \`models list\`, \`cleanup\`, \`feedback\` | yes | yes |
| Binary, website preview routing, and MCP inputs | no | yes |
| Saved eval sets and preference prompts | yes | yes |
| Project inputs and previews on saved measurement launches | yes | use case files/specs |
| Structured findings and queries | yes, supported fields | yes |
| Personas, recurring schedules, PR checks | no | yes |
| Optimizations (managed docs rewriting) | no | yes |
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
measures which tools agents choose and why. Optimizations test improvements to
your docs, CLI, and skills against those measurements.

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
- Confirm before launches spend credits. Use \`--yes\` for work already approved.
- Retry writes with their supported idempotency flag; blind retries can launch
  duplicate paid sessions.
- Report measured results with sample counts and evidence, including limits.
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

Gauge measures trials; you author changes. To fix one owned finding from
\`gauge run insight\`, start with \`--finding <id>\`. Otherwise run \`gauge optimizations baselines\`
to discover eligible runs, then start with \`--from-run\`.
Read authoring context, write a hypothesis, preview the complete change, save,
and launch. Gauge resumes saved baseline states (checkpoints) when compatible, or starts fresh.
Follow \`nextAction\`; watch exits 4 when input is needed. Verify actual change
exposure, task scores, sample counts, and failed sessions separately. Keep the
measurement fixed, confirm paid launches, and retry writes safely. Adopt the
winner; use \`handoff\` for implementation in your source repository.

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
- Report CLI friction, gaps, or bugs, with no account:
  \`gauge feedback -m "<what happened>" --kind friction|missing|bug\`.

${MODES}

To switch this repo to hosted, run \`gauge onboard\`, then \`gauge init --hosted\`.
`;

const OPTIMIZATIONS = `---
name: gauge-optimizations
description: Discover observed surfaces, choose a baseline, and test docs, CLI,
  or skill changes against a Gauge eval or preference prompt.
---

# Optimizations

Gauge measures; you author. Use -o json on reads. Discover before starting.

## The loop

    gauge optimizations baselines --eval <id> -o json
    gauge run insight <run-id> -o json
    gauge run get <run-id> --logs -o json
    gauge optimizations start --eval <id> --from-run <run-id> --yes

Discovery returns observed owned surfaces, evidence, judging, eligibility, and nextCursor.
Choose a run that encountered the surface you want to improve. Missing evidence is unknown.
--from-run reuses its eligible baseline (possibly several runs) and inherits its model.
Use --preference for preference prompts, or --target <agent:model> to establish a baseline.
A new baseline may spend credits. Only use --yes for approved spending.
To fix one owned finding, start --finding <findingId> alone: it becomes the target, and its
session sets the baseline, subject, and model. run insight prints each finding's Optimize: line.

    gauge optimizations watch <id>            # exit 4 = your turn, not failure
    gauge optimizations authoring <id>          # targets, guidance, revision
    gauge optimizations page <id> --url <url> -o json

Follow nextAction: WAIT → watch; AUTHOR_TRIAL → author; LAUNCH_ROUND → launch.
Check page.source: scrape is current content, not the captured baseline response.
Write each trial in round.json as one hypothesis with changes: [...] across any surfaces, using the authoring revision.
Docs use exact find/replace edits or body with rewriteReason; a skill edit carries its complete files.
CLI: cli-change --file takes v3 {schemaVersion:3,target,rules,shippingIntent}; its output is a CLI_INTERVENTION change's after.

    gauge optimizations round preview <id> --file round.json -o json
    gauge optimizations round save <id> --file round.json --digest <previewDigest>
    gauge optimizations launch <id> --yes
    gauge optimizations watch <id>
    gauge optimizations trial <id> <trial> -o json

Checkpoints are saved states of baseline runs: resuming one avoids repeating earlier work.
Gauge selects checkpoints automatically before the affected interaction, or starts fresh with a reason.
Omit startingPoints and fork flags; you do not select a checkpoint. Check candidateExecution,
candidateDelivery (exposure, observedArtifacts, evidenceComplete), scores, counts, and failed sessions.
Better scores alone are not proof. Keep eval/prompt/criteria fixed; repeat if inconclusive.
The trial's ledger is its result: did each target come back, move later, or vanish; what is new?
Record it: judge <id> <trial> --direction BETTER|WORSE|MIXED|UNCHANGED|UNCLEAR --summary <text>
--target <observationId>=RESOLVED|RETURNED|MOVED|UNCLEAR. Unexercised change: UNCLEAR.
Adopt <id> <trial> selects the winner; handoff <id> gives source instructions; complete <id> finishes.
Neither deploys. Single-trial retries: trials add --idempotency-key.
`;

export const TOPICS: Record<string, Topic> = {
  root: { name: "gauge", hosted: ROOT, local: ROOT_LOCAL },
  init: { name: "gauge-init", hosted: INIT, shared: true, command: "init" },
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
