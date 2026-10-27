# @withgauge/cli

`gauge` — the [Gauge](https://agents.withgauge.com) command-line interface.
Manage your eval sets, Agent Preference prompts, and agent runs, and watch runs
live from your terminal.

```sh
npm install -g @withgauge/cli
gauge update              # update the CLI to the latest published version
gauge onboard             # sign in and create a workspace (account only)
gauge auth login          # (or just sign in)
gauge orgs use <org>      # set your default organization
gauge init                # initialize a workspace; local is the default
gauge init --hosted       # set a private hosted backend preference
gauge init --cases        # optionally scaffold shared gauge-cases/
```

Requires Node.js ≥ 22.13.

## Workspace and local storage

`gauge init --local` works without Git. It writes a minimal shared manifest:

```json
{ "version": 2, "inputs": {} }
```

The private `.gauge/config.json` contains `{ "version": 1, "backend": "local" }`.
`.gauge/.gitignore` ignores all workspace state. SQLite in `.gauge/gauge.sqlite`
stores saved measurements, revisions, launch/session summaries, and published
analyses. Raw transcripts, normalized events, diffs, and diagnostics remain under
`.gauge/runs/`; input blobs and batch lifecycle files remain alongside them.

Moving the workspace preserves identity. Fresh clones or linked worktrees start
independently; switching Git branches keeps local history. Do not treat `.gauge/`
as a disposable cache. Credentials and user preferences stay user-level.
`gauge run repair --local` rebuilds session summaries from durable artifacts while
preserving authored measurements and analyses. It does not rerun sessions or judges.

## Analyze local sessions

Your coding agent reads evidence and publishes a structured analysis:

```sh
gauge instructions session-analysis --local
gauge run analysis schema --local > analysis.schema.json
gauge run get <run-id> --logs --local -o json
# Author analysis.json against the printed schema and session evidence.
gauge run analysis save <run-id> --file analysis.json --local
gauge run insight <run-id> --local
```

Publication validates the versioned schema, criterion coverage, and evidence
references, then saves findings, product choices, and criterion judgments in one
transaction. Reanalysis creates a revision and updates the current analysis.
`run insight` leads with Friction, Objections, and Opportunities in either backend.
A Markdown file alone does not mark a session analyzed. Unknown future schema
versions produce an upgrade error without altering saved data. Database schema
migrations preserve analyses and never silently reinterpret old judgments.

## Local Docker runtime

Local runs need Docker running Linux containers and an agent credential. Linux
is the container OS, not a requirement for your host: Docker Desktop on macOS
provides a Linux daemon and shares the local files used by sessions.
Install the runtime without a Gauge account or a source checkout:

```sh
gauge local runtime pull
gauge local runtime inspect -o json
gauge run --local --dry-run
```

Each CLI release pins its tested public `ghcr.io/gauge-sh/gauge-runtime` image by
immutable digest. Inspection reports the reference, local image ID, registry
digest, contract, platform, and readiness errors. `ready` covers local image
metadata; agent credential checks happen separately. Neither inspection nor a
dry run downloads an image. `pull` explicitly downloads the supported image;
previously pulled images can be reused offline (agent calls still need network
access). Pull progress goes to stderr so JSON output remains parseable.

The runtime includes native `linux/amd64` and `linux/arm64` images. Docker selects
the matching image on Intel/AMD or Apple Silicon/ARM machines. No architecture
emulation is needed. Docker must be able to bind-mount this machine's temporary
and input directories; an unrelated remote Docker server cannot access them.
On Windows, run the CLI inside WSL because Gauge uses Unix sockets and UID/GID.

## Local agent credentials

Local provider credentials are separate from a Gauge account and hosted credential
brokering. Use native harness logins or configure a named environment reference:

```sh
gauge local profiles set work --agent CODEX_CLI --provider openai --auth api_key --env TEAM_OPENAI_KEY
gauge local profiles use work
gauge local profiles inspect work -o json
gauge run --local --profile work --dry-run -o json
```

`--env` takes the variable's name, never its secret value. Profiles store only
references; list and inspect output do not expose credentials. Update a profile
with `set ... --replace` or remove it with `remove <profile>` without deleting
the native login. Local readiness checks do not verify provider acceptance or
model access. Use `gauge local profiles --help` for profile commands and
`gauge instructions --local` for the local workflow.

## Anonymous CLI telemetry

The installed CLI collects command usage by default to help improve Gauge.
Opt out for your user account or for a single process:

```sh
gauge telemetry disable
gauge telemetry status
gauge telemetry enable
GAUGE_TELEMETRY_DISABLED=1 gauge run --verify
```

The environment variable overrides the saved preference. These controls work
without an account or network access and support `-o json`. They apply to CLI
command telemetry; authenticated Gauge API requests have separate server-side
usage analytics.

Each `cli_command_invoked` event contains only the canonical command name
(for example, `run list`), its UTC invocation timestamp, CLI version, and a
random installation UUID. Arguments, flag values, file paths, prompts, file
contents, environment variables, errors, and account identifiers are excluded.
The UUID is independent of login and is never linked to your Gauge account.
This is pseudonymous usage tracking: an installation can be recognized across
commands, but no personal identity is sent. HTTP requests necessarily expose a
source IP to the receiving infrastructure; event properties mask IP addresses,
disable GeoIP enrichment, and disable person-profile creation.

Preferences live in `~/.config/gauge/telemetry.json` and the UUID in
`~/.config/gauge/telemetry-id` (respecting `XDG_CONFIG_HOME`). They are shared
across repositories, independently of each repository's `.gauge/` results.
Deleting `telemetry-id` resets the identity on the next collected command.
Consumers are installations, not necessarily individual people. Session
analysis can group an installation's events using a 30-minute inactivity gap;
the CLI does not generate a different identity for each invocation.

Collection occurs when a parsed command is about to run, including commands
whose handlers subsequently fail. Help, version, parsing errors, telemetry
controls, and source development runs are excluded. A detached worker handles
all telemetry storage and network access, with a two-second request timeout
and a three-second worker lifetime. Commands never wait for delivery, and
failures are silent. There are no retries or offline queue, so events may be
lost. Corrupt or unreadable preferences suppress collection until repaired.

Events go to Gauge's existing PostHog project using its public ingestion key.
The [capture API](https://posthog.com/docs/api/capture) and
[anonymous event controls](https://posthog.com/docs/product-analytics/capture-events#advanced-anonymous-vs-identified-events)
describe the transport and person-profile behavior.

## Local or hosted

For an end-to-end improvement loop, run `gauge instructions hillclimb`. It guides
your coding agent to identify product inputs, propose a representative pilot,
inspect and publish findings, implement a focused change, and rerun to compare.
Init and the generated `AGENTS.md` point to this guidance. `gauge install-skill`
installs the Gauge skill, which directs agents to the installed CLI's instructions.

Execution backend is independent of definition source. Resolve an explicit
`--local`/`--hosted` flag, then `.gauge/config.json`, user preference, and finally
local. Signing in does not change the backend. `gauge.json` is the shared project
manifest for named inputs, optional case discovery, and GitHub checks. It never
contains the execution preference. Git is optional for workspace initialization.

| Workflow | Local | Hosted |
|---|---|---|
| Skill, npm package (CLI or SDK), and `files` inputs | yes | yes |
| Docs supplied as `files` inputs | yes | yes |
| Web fixture JSON: exact pages, scopes, and origin proxying | yes | yes |
| Eval and Agent Preference cases in `gauge-cases/` | yes (you read the sessions) | yes (judged) |
| `run`, `run list`, `run compare --local`, `models list`, `cleanup`, `feedback` | yes | yes |
| Binary, website, and MCP inputs | no | yes |
| Saved eval sets and preference prompts | yes | yes |
| Project inputs and previews on saved measurement launches | yes | use case files/specs |
| Findings and summary queries | yes, supported fields | yes |
| Personas, recurring schedules, PR checks | no | yes |
| Optimizations (managed docs rewriting) | no | yes |
| Stored credentials for MCP servers and connections | no | yes |
| Additional reporting datasets, dashboards, org settings | no | yes |

Local runs need Docker and the agent's own login (`claude` or
`ANTHROPIC_API_KEY` for Claude Code; `codex login` for Codex, Pi, and
OpenCode). They do not need a Gauge account. Hosted runs need a Gauge account
(`gauge onboard`) and use credits. In local mode, a hosted-only command says so
and prints the next step.

For coding agents, we recommend the
[`gauge-agents` skill](https://github.com/gauge-sh/gauge-skills/tree/main/gauge-agents).
It makes Gauge CLI guidance and repository setup workflows discoverable in future
sessions. Install it separately from repo setup, running from your project root:

```sh
gauge install-skill
```

In a terminal, select your coding agent and installation scope in the installer.
Project scope adds skill files to this repo; global scope makes the skill available
across projects. The command runs the pinned `skills@1.5.0` installer through npx
and forwards its prompts and output. When a coding agent runs it, the command
installs for that agent at project scope without prompts and prints a short summary.
To choose the agent or scope explicitly:

```sh
gauge install-skill --agent claude-code --yes          # this project
gauge install-skill --agent codex --global --yes       # across projects
```

Repeat `--agent` to target multiple agents. `--yes` requires an explicit agent
target; `--copy` copies files instead of creating symlinks.

## Usage

```sh
gauge status                      # the org at a glance
gauge eval list                   # saved eval sets
gauge preference list             # saved Agent Preference prompts
gauge models list                 # supported model × harness × provider targets
gauge eval edit <id> --cadence weekly --samples 3   # when and how much it runs
gauge run --eval <id>             # launch now (ORG-funded, credit-gated)
gauge run watch <run-id>          # follow a run as the agent works
gauge stats rankings -o json      # brand rankings (share of voice) as JSON
gauge query -d ecosystem -m installs,install_rate -o json   # a flexible report
```

`gauge instructions` prints a Gauge overview, CLI setup and usage rules, and
roughly 100 words of essential guidance per module. Each summary points to
`gauge instructions <topic>` for the full page. `gauge --help` points agents at
it. Install the Gauge skill with `gauge install-skill` to make this guidance
discoverable in future sessions. Read instructions from the installed CLI so
they match its commands.

Use `gauge instructions run` before writing evals or starting runs: it covers
developer tasks, model selection, observable judging criteria, and a complete
migration example. Use `gauge instructions eval` and `gauge instructions preference` to save eval sets and
preference prompts, and `gauge instructions session-analysis` to investigate
product choices, source exposure, and interventions, from individual traces to
larger cohorts.
Use `gauge instructions optimization` for the full optimization workflow.
`gauge instructions --list` shows available topics.

Run `gauge --help` (or `gauge <command> --help`) for the full command set:
run, eval, preference, models, personas, skills, mcp, repos, optimizations,
brands, tags, actions, dashboards, members, org, provider keys,
billing, usage, stats, query, and more.

## Run committed Markdown evals

File evals keep the task, run settings, and judged criteria in Git. Create
`gauge-cases/healthcheck.md` with YAML frontmatter and a Markdown task body:

```markdown
---
criteria:
  - name: Healthcheck responds
    rubric: The endpoint returns HTTP 200 without authentication.
config:
  repoUrl: https://github.com/acme/app
  repoRef: main
  agents:
    - agent: CODEX_CLI
---

Add a /health endpoint and run the relevant app checks.
```

Check your setup, then preview and run the current working-tree cases and inputs:

```sh
gauge run --verify              # local; includes uncommitted working-tree edits
gauge run --verify -o json      # versioned global/per-input yes/no/unknown checklist
gauge run --dry-run
gauge run --yes
gauge run wait <request-id> -o json
```

Cases default to `gauge-cases/**/*.md`. `--files` accepts quoted paths/globs and overrides
that convention for `--dry-run` and `run`. Interactive CLI launches snapshot current
working-tree definitions in either backend, including uncommitted edits. Selected
filesystem inputs are packaged for local execution or hosted upload; explicit remote
artifacts retain their declared source. GitHub checks fetch committed definitions.
Content digests identify the exact bytes separately from Git provenance.
Preview `inputSnapshots` includes the selected source `path`,
`gaugeArchive: { sha256, bytes }`, and the archived `files` (the first 100) with
`fileCount`. Those values describe Gauge's delivery archive, which contains the
selected files. `unattachedInputs` names the `gauge.json` inputs that the launch
leaves out. For npm inputs it contains the `.tgz`; the raw
tarball has a different hash and size. Each launch takes a fresh snapshot.
Each case owns its agents, models, consumer repository/ref, Persona and criteria.
The optional `config.inputs` selects named inputs; all attach by default.

A `web-fixture` input controls what agents receive from specific HTTPS URLs:
exact pages, 404s for missing pages under a scope, or an origin routed to a
preview. Declare it as `"docs": { "type": "web-fixture", "path": "fixtures/docs.json" }`,
select it with `config.inputs`, and override it with `--input docs=path.json`
on either backend. Local runs serve fixtures through a gateway container;
`gauge local runtime inspect` and `pull` cover its image. See
[web fixture inputs](https://github.com/gauge-sh/gauge-cli/blob/main/docs/local-web-fixtures.md).

`verify` reads the repository's current files, including non-ignored untracked files,
without login, network access, a PR, built CI artifacts, or sandbox compute. It checks
configuration, case input references, Git input paths, and recognizable workflow
checkout/upload declarations. An input-only repository with no cases is valid setup.
Each attempted global/per-input check reports `yes` (established locally), `no`
(a definite problem), or `unknown` (a specific static question could not be resolved,
such as an expression-based artifact name or a referenced reusable workflow).
Missing optional configuration and zero cases are informational findings, excluded
from checklist counts. Eligible workflow triggers are checked as declarations;
event filters and runtime conditions are not evaluated against a candidate PR.
Live input delivery, artifact contents, sandbox execution, App activation, and
account settings are outside this command's scope and do not create unknown rows.
Exit 1 means at least one `no`; exit 0 means no definite static problem was found.
No workflow code is executed.

`gauge run --verify -o json` writes exactly one JSON object to stdout, including on
validation failure. The versioned report provides:

- `version: 1` and `mode: "local-static"` identify the report contract and scope.
- `status` is `failed` if any check is `no`, otherwise `incomplete` if any check is
  `unknown`, otherwise `passed`. It describes static checks only.
- `summary` contains `yes`, `no`, and `unknown` counts.
- `global` and `inputs[].checks` contain checks with stable `id`, `state`, and
  explanatory `detail` fields; `inputs[].name` identifies each input.
- `facts.configFilePresent` and `facts.caseCount` expose discovered facts without
  parsing prose. A `null` value means inspection did not reach that fact; zero cases
  is distinct from case discovery being skipped or failing.
- `info` contains informational findings with stable `id` and `detail` fields.
- `notChecked` lists excluded capabilities as machine-readable identifiers.

For example, an agent can select unresolved checks with:

```sh
gauge run --verify -o json | jq '{status, facts, global: [.global[] | select(.state != "yes")], inputs: [.inputs[] | {name, checks: [.checks[] | select(.state != "yes")]}]}'
```

An optional `gauge.json` declares inputs produced by your normal CI or committed
alongside your product:

```json
{
  "version": 2,
  "org": "my-org",
  "inputs": {
    "cli": {
      "type": "npm-package",
      "source": { "type": "github-actions", "workflow": ".github/workflows/package.yml" },
      "path": "*.tgz",
      "install": "environment"
    },
    "docs": {
      "type": "files",
      "source": { "type": "git" },
      "paths": ["docs/**/*.md"]
    }
  }
}
```

Gauge waits for your PR build and tests its uploaded artifacts. Keep the workflow's
existing checkout settings, including GitHub's default merge checkout. Omit
`source.artifact` when the workflow uploads one artifact, or select it by name.

For automatic checks, connect the Gauge GitHub App with repository access and
Actions read permission. Set `org` and enable the repository and target branches
in **Settings → GitHub**. Waiting for inputs starts no sessions and spends no
session credits.
Fork pull requests are disabled by default. Check **Allow fork pull requests** to let
workspace members authorize an evaluation from its GitHub check. Authorization
covers one PR revision and uses workspace credits; new revisions and explicit
reruns require fresh approval. Configured inputs determine when an authorized
evaluation is ready to run.
A failed run or absent/expired artifact returns an actionable input failure.
Absent runs have a five-minute discovery grace period; known running or queued
CI can continue past an hour. Abandoned requests expire after seven days. Reruns retain captured bytes. CI metadata reports a revision; it
does not independently prove which checkout the workflow compiled.

To run automatic PR checks only when relevant files change, add `checks` to
`gauge.json`:

```json
"checks": {
  "paths": ["agents/**", "docs.json", "snippets/**"]
}
```

Paths are repository-relative, case-sensitive globs; matching any pattern runs
the checks. `**` matches nested directories, including hidden files. Use 1–32
patterns; exclusions (`!`) are not supported. Changes to `gauge.json` or your
configured case paths always count. Deleted files and both names of renamed
files are included. Without root `checks`, every eligible PR update reaches case
selection.

With CLI 0.16.0 or later, a case can narrow its own automatic PR triggers in its
Markdown frontmatter (alongside its other `config` settings):

```yaml
config:
  agents:
    - agent: CODEX_CLI
  checks:
    paths: ["cli/**", "packages/shared/**"]
```

Root `checks.paths`, when present, must match first. The App then runs matching
cases and all cases without a filter. Changes to `gauge.json` select every case;
editing a case selects that case regardless of its filter. If no cases match,
the check is skipped before preparing inputs or reserving credits. `config.inputs`
only chooses inputs; it does not define change triggers.

The first check uses the PR diff. After a passing evaluation, later updates
compare against that evaluated commit, so unrelated follow-up edits can skip.
A failed or unfinished evaluation, a changed target branch, or an unavailable
or incomplete diff causes a run. Skipped checks start no sessions and reserve
no credits. GitHub's rerun action runs regardless of paths; explicit CLI runs
also ignore this automatic-check filter.

File inputs stay outside the consumer repository and their paths are provided to
the agent. npm packages install with ordinary npm using the VM's Node/npm runtime.
`install` defaults to `environment`: a separate tools directory with the package's
own declared commands on PATH, including login shells. `workspace` adds a consumer
application dependency and accepts libraries without commands. Transitive registry
dependency ranges remain live. Plan output shows the installation destination and,
when a previous matching preparation captured it, command metadata. Otherwise it
reports that commands will be determined during preparation; planning never downloads
archives or starts VMs.

Native executables use `type: "binary"`, with already unpacked files in a GitHub
Actions artifact (or small committed Git files):

```json
"gh": {
  "type": "binary",
  "source": {
    "type": "github-actions",
    "workflow": ".github/workflows/package.yml",
    "artifact": "gh-linux"
  },
  "paths": ["dist/**"],
  "platform": "linux-x64",
  "commands": { "gh": "dist/bin/gh" }
}
```

Paths are relative to the uploaded artifact root. Use your normal PR build;
for `actions/upload-artifact@v7`, use `archive: true`. Include companion files in
`paths` and explicitly map 1–32 command names to ordinary selected files. Gauge
validates Linux x86-64 ELF executables in its isolated artifact processor, restores
executable permissions, preserves the bundle outside the consumer repository, and
exposes the commands on PATH, including login shells. A candidate command overrides
an installed product command with the same name; two inputs selected by the same
case cannot expose the same command (including captured npm environment commands).

The first version supports ELF executables and PIE binaries compatible with the
consumer Linux runtime. It does not unpack nested release archives, install OS
packages, alter library search paths, or run arbitrary installation/version-check
commands. Prefer a static binary or build against a compatible Linux runtime;
header validation cannot prove shared-library compatibility. Scripts, macOS,
Windows, and ARM executables are unsupported. A missing loader/library encountered
when the agent invokes the command appears in session execution evidence, not in
static validation. Harness/runtime names (including shells, Node/npm, Python, Git,
archive/setup utilities, and agent commands) are reserved; use a different alias
for such a candidate. `GAUGE_INPUTS` gives the preserved bundle path.

A Skill input has `type: "skill"` and `path: "skills/product"`, or a path to a ZIP,
`.tar.gz`, or `.tgz` whose root contains `SKILL.md`. Use `path: "."` for a Skill at
the source root. Gauge validates and extracts selected archives in isolation and
stages the Skill in the coding agent's native discovery location. File inputs use
`paths` to select committed files or files inside an Actions artifact.

Gauge tests the artifact uploaded by your PR's successful build. Keep your
existing checkout settings. The GitHub check links to the selected build;
rerun Gauge to test the latest build.

### Run from your own CI or local build

With CLI 0.18.0 or later, supply built inputs directly to run without the GitHub App:

```sh
gauge --org my-org run --input product-analytics=./dist/skill.zip --yes -o json > request.json
gauge --org my-org run wait "$(jq -er '.runRequestId' request.json)" --check -o json > results.json
```

`--check` fails the job unless the verdict is `PASSED` or `MEASURED`. Without
it, `run wait` exits 0 once the request settles, whatever the verdict.

Set `GAUGE_API_TOKEN` as a CI secret and replace `my-org` with your workspace slug.
This can run immediately after your build in the same CI job.

Repeat `--input name=path` for each input. The path replaces the input's
configured files entirely; only its type and settings carry over. It may be a
glob, using the same syntax as `gauge.json`; quote it so the shell passes it
through. Skills accept a directory containing `SKILL.md` or a ZIP/tar.gz archive;
npm inputs accept a packed `.tgz` or a glob matching exactly one. Files inputs
accept a directory, a single file, or a glob; archive paths are relative to the
directory, or to the glob's directory before its first wildcard. Binary inputs
accept a directory or glob, with `commands` relative to it.
Use a dedicated build directory: links are rejected, and common credential files
and `node_modules` are excluded. Each input is limited to 512 MiB and 20,000 files.

With `--input`, Gauge uses your current evaluation files, including uncommitted
edits. No Git checkout is required when all selected inputs are supplied locally.
Inputs without an override keep their configured source. You can omit `source`
in `gauge.json` to default to Git; the override replaces it for this run.
Website previews and private consumer repositories still require their configured
access. Public consumer repositories and the default workspace need no GitHub App.

`wait -o json` returns the verdict, session results, criterion explanations, and
session links. It exits 0 once the request settles, whatever the verdict. Add
`--check` to exit 1 unless the verdict is `PASSED` or `MEASURED`; the results
JSON is still the only output. Automatic PR checks continue to use configured
sources; disable those checks in Gauge's GitHub settings if CI owns the trigger.
Save `results.json` as a CI artifact even when the check fails.

### Antigravity (hosted)

Antigravity is available to organizations enrolled in Antigravity access. Run
`gauge models list --hosted` to find the available model identifiers, then select
one with `--agent antigravity:<model>` when creating or launching a saved eval or
preference prompt. Case files and JSON specs use `agent: ANTIGRAVITY` with the
model identifier in `models`.

Launch with `--hosted`, for example:

```sh
gauge run --eval <id> --agent antigravity:<model> --hosted
```

For case files or a JSON case spec, preview with `gauge run --hosted --dry-run`
or `gauge run --apply cases.json --hosted --dry-run` before launching.
Hosted previews contact Gauge and may upload inputs; launches use credits.
The server checks organization access and model availability. Antigravity cannot
run locally yet.

### Authenticated MCP servers

Connect your account in Gauge's MCP setup, completing OAuth in your browser when
required. Add the server's versioned reference to each case's `config.mcpRefs`.
Gauge manages credentials for the session; keep tokens out of prompts and Git.

### Website previews

Website inputs use `type: "website"` and a canonical HTTPS origin in `url`.
The preview can come from `source: { "type": "github-deployment", "environment": "preview" }`
or a `github-pr-comment` source with an exact `author`, literal `bodyIncludes`
marker, and a readiness `pattern` with named `url` and `sha` captures. Gauge selects
candidate-specific evidence; timestamps alone cannot establish the revision.
Comments must belong to a unique open same-repository PR at the candidate head.
Previews must be public HTTPS origins, without authentication or path prefixes.
They are fetched live rather than snapshotted.

Canonical-site preview routing requires hosted execution. Local runs reject
website inputs, including `--input` overrides, before checking Docker or credentials.
For local content-only testing, supply docs as a `files` input or put a reachable
preview URL directly in the prompt. Inputs never include `.gauge/`. Confirm that the preview contains the edits
and is reachable from the agent's environment; the host's localhost is not
automatically reachable from a container. These alternatives change exposure and
do not test discovery of the canonical docs. Static verification validates
configuration; it does not prove backend support, delivery, or an eval pass.

Editor schemas are published at
`https://agents.withgauge.com/schemas/gauge/v2.8.0/gauge.json` and
`https://agents.withgauge.com/schemas/gauge/v2.8.0/case.json`. Associate them in editor
settings; `gauge.json` does not accept a `$schema` field. These release URLs are
immutable. Cases default to `gauge-cases/`, or use explicit `cases` paths.

`--org` overrides the committed organization. Root `cases` can change discovery;
root `version` defaults to 2. Saved evals use `gauge run --eval <id>`.

## Measurements own their configuration

Saved eval sets and preference prompts provide a stable grouping for sessions
plus editable templates and defaults. Local records live in workspace SQLite;
hosted records live in your organization. Launches freeze identity, revision, and
effective settings. Renaming or editing a measurement preserves its history.
Local measurements run on demand; recurring schedules, personas, markets, and
hosted resource references require hosted execution. Measurements do not store
project inputs: attach them to a local launch with
`gauge run --eval <id> --input <name>`, or `--input <name>=<path>` to replace the
configured files.

An **eval** is one prompt against one configuration. This hosted example uses
registered skills and recurring scheduling; omit those hosted features locally:

```sh
gauge eval create --name "add a healthcheck" \
  --text "Add a /health endpoint that returns 200 OK." \
  --criterion "Returns 200: the endpoint responds 200 with no auth" \
  --repo https://github.com/acme/api --ref main \
  --agent claude-code:claude-opus-4-8 --agent codex \
  --skill acme-cli@1.2.0 \
  --cadence weekly --samples 3
```

`gauge eval edit <id>` changes any of it later; omitted flags keep their
stored value, and each `--clear-*` flag empties one field. To measure the same
prompt against a second repository or roster, copy the eval in the app and edit
the copy — one eval is always one configuration.

A **preference prompt** is a reusable question. The following hosted example
uses scenarios and recurring scheduling. Locally, save a prompt and launch it
on demand with `gauge run --preference <id> --local`. It owns one set of run
settings — roster, resources, cadence, samples — and any number of
**scenarios**, each one repository × persona cell. Every scenario runs with
the prompt's settings, so one prompt measures the same question across several
repositories and personas at once:

```sh
gauge preference create --name "CLI deployment preference" \
  --kind head-to-head --brand-a acme --brand-b globex \
  --text "Which CLI should I use to deploy?" \
  --agent claude-code --cadence daily \
  --repo https://github.com/acme/api             # first scenario

gauge preference edit <promptId> --agent codex --samples 3 --cadence weekly
gauge preference scenarios list <promptId>
gauge preference scenarios add  <promptId> --persona <profileId>
gauge preference scenarios add  <promptId> --repo https://github.com/acme/web --persona <profileId>
gauge preference scenarios rm   <promptId> --scenario <scenarioId>
```

A prompt with zero scenarios is a valid definition — it simply never comes due.
Sessions per launch = scenarios × agent/model targets × samples. Omit the
run-settings flags on `create` and the org's default roster applies.

## Hosted schedules

`--cadence none` is "manual": the measurement stops coming due and runs only
when you launch it. There is no separate pause or enabled flag, in the CLI or
the app. `--cadence daily|weekly|monthly` puts it back on a rhythm, and
`gauge preference get <id>` reads a manual prompt back as `cadence: manual`.

`gauge run --eval <id>` and `gauge run --preference <id>` are the separate
immediate launches. They use the stored configuration and ask before spending
(`--yes` skips the prompt for scripts).
`gauge run --preference <id> --scenario <scenarioId>` (repeatable) runs a subset;
omit it and every scenario runs. On a recurring cadence, an eval launch or a
full preference launch moves the next scheduled run to one period from now. A
scenario subset leaves the schedule unchanged.

## Optimizations (hosted)

Start by finding runs that encountered the surface you want to improve:

```sh
gauge instructions optimization
gauge optimizations baselines --eval ev_1 -o json
gauge run insight run_1 -o json
gauge run get run_1 --logs -o json
gauge optimizations start --eval ev_1 --from-run run_1 --yes
gauge optimizations watch cl_1
```

`baselines` returns observed owned surfaces grouped by run, source evidence,
judging status, eligibility (including the baseline's complete run set), and a
`nextCursor` for `--cursor`. It uses the UI baseline picker's compatibility rules
and recent 100-batch eligibility window. Missing evidence is unknown; the list
is an analysis summary, not an exhaustive inventory of every trace event.
`--from-run` inherits the eligible baseline's harness/model and reuses its runs.
A stale choice fails instead of silently buying a new baseline. `--target` is
an alternative when you need to establish a baseline; do not combine it with
`--from-run`. Use `--preference` instead of `--eval` for preference prompts.

```sh
gauge optimizations authoring cl_1 > context.json
gauge optimizations page cl_1 --url https://docs.acme.dev/auth -o json
# Author round.json using context.revision and the observed baseline evidence.
gauge optimizations round preview cl_1 --file round.json -o json
gauge optimizations round save cl_1 --file round.json --digest <previewDigest>
gauge optimizations launch cl_1 --yes
gauge optimizations watch cl_1
gauge optimizations trial cl_1 R1.1 -o json
gauge optimizations adopt cl_1 R1.1 --yes
gauge optimizations handoff cl_1
gauge optimizations complete cl_1 --yes
```

A round is `{revision, trials: [{trial: {title, hypothesis, lever, intervention}}]}`.
Docs `REWRITE_DOCS` proposals supply `after.pages` with URL and exact `edits`
(`find`/`replace`), or a complete `body` and `rewriteReason`. Check the page's
`source`: `scrape` means current fetched content, not the captured response.

For CLI trials, inspect `cliIntervention.guidance` and `targets` in authoring
and use `gauge run get <id> --logs` for the cited command evidence. `cli-change --file change.json`
accepts v3 `{schemaVersion:3, target, rules, shippingIntent}` and returns a sealed
bundle to put in `CLI_INTERVENTION.after`. It does not save or launch. The old
catalog/invocation-ID workflow is retired. Skills use `skill-files` and the
complete edited file bundle.

A checkpoint is a saved state of a baseline run. Resuming it avoids repeating
earlier work. Gauge automatically selects a compatible checkpoint before the
affected interaction for docs and CLI candidates, or starts fresh with a reason.
You do not select a checkpoint; omit checkpoint choices and fork flags. Skills
start fresh. Inspect
`runs[].candidateExecution` for actual starting mode and `candidateDelivery`
for exposure, observed artifacts, and evidence completeness. A score improvement
does not prove the change was exercised. Report sample counts and failed sessions.

Read `nextAction` on optimization detail; `watch` exits 4 when input is needed.
Round save replaces pending drafts but never launches. Use `--yes` for approved
spending and `trials add --idempotency-key` when retrying single-trial writes.
Adoption selects a winner without changing the baseline or deploying the change;
`handoff` supplies instructions to implement it in your source repository.

## Compare runs

`gauge run compare` answers before/after questions in one call. Each side takes
repeatable `key=value` selectors: `request=`, `batch=`, `eval=`, `revision=`,
`experiment=`, `trial=`, `agent=`, `model=`, `since=`, and `until=`.

```sh
gauge run compare --baseline request=<id> --candidate request=<id>
gauge run compare --baseline eval=<id> --baseline until=2026-10-01 \
                  --candidate eval=<id> --candidate since=2026-10-01
```

It prints the pass rate, each criterion's pass rate, and median turns, cost,
and duration, for all runs and per agent and model. `-o json` returns the same
data with deltas.

With `--local` it compares local session summaries. Use saved measurement IDs
with `eval=` and `revision=<number>`, or select a `batch`, `agent`, `model`, and
time window. Compare preference runs by batch. The comparison uses current published
criterion judgments and recorded turns/duration; unknown metrics and unassessable
criteria stay out of their denominators. Completion is distinct from a judged result.
Inspect findings with `gauge run insight` and query capabilities with `gauge query fields`.

```sh
gauge run compare --local --baseline batch=<id> --candidate batch=<id>
```

Each run has an `evalRevision`: a hash of its prompt, repository, persona,
agent context, and criteria. `gauge eval edit` changes the revision of new
runs. Each case has its own revision. `gauge run list` shows it, and `compare`
warns when one eval or case ran under more than one revision; add
`revision=<hash>` to pick one. `compare` also warns when a side matched no
runs, has runs in progress, or has runs without a verdict.

Optimization trial runs test a changed configuration, so `eval=` and other
selectors leave them out. Add `trial=<trialId>` to compare one trial's runs,
including runs it reused. `gauge run list` shows the trial key and id.
`compare` prints the trial behind each side's trial runs. `gauge run list` and
`gauge run get` show a run's `optimizationTrial`.

To try other agents or sample counts once, without editing the saved measurement, pass
`--agent` and `--samples` to `gauge run --eval <id>` or `--preference <id>`.
The stored configuration stays unchanged.

`gauge run status <request-id>` prints a launch request's progress and
per-session results once, without waiting.

## Models, reports, and scripting

Use `gauge models list` before pinning models. It reads the organization's live
catalog and shows every selectable logical model with its harness, provider,
and effective capabilities. Open harnesses use `--agent pi:<model>` and
`--agent opencode:<model>` just like the frontier harnesses.

`gauge query` uses SQLite locally and the reporting API when hosted. Both expose
`findings`; local also supports run summaries. Discover capabilities with
`gauge query datasets` and `gauge query fields --dataset findings` using the
selected backend. Unsupported datasets, filters, dimensions, and metrics fail
with actionable errors; unavailable data never becomes a fabricated zero.

```sh
gauge query --local --dataset findings --dimensions kind,effect --metrics finding_count,affected_runs
gauge query --hosted --dataset findings --dimensions kind,effect --metrics finding_count,affected_runs
gauge query search "authentication failed" --eval <id> --local
```

Findings queries use the current published analysis, so reanalysis is not double
counted. `finding_count` counts findings; `affected_runs` counts distinct runs.
Missing analysis differs from an analyzed run with no findings. Transcript search
scans selected evidence files and returns run/turn references. No transcript
index or background indexing process is maintained.

Every read supports `-o json` for scripting. `GAUGE_API_TOKEN` overrides
stored credentials (useful in CI). Exit codes: `0` ok · `1` error ·
`2` usage · `3` billing-blocked · `4` needs your input (`optimizations watch`).

## Support

Questions or problems: [support@withgauge.com](mailto:support@withgauge.com).


### Git-authored Agent Preference

A committed Markdown case may declare `preference` instead of `criteria`.
Use exactly one; the Markdown body is always the coding agent's user request.

```markdown
---
preference:
  kind: open-ended
config:
  agents:
    - agent: CODEX_CLI
  sampleCount: 5
  inputs: [docs]
---

I need product analytics for a small SaaS application.
We need funnels, retention analysis, and EU data residency.
What should we use?
```

Here `docs` names an input declared in `gauge.json`. Existing repository/persona
settings and automatic path filters apply unchanged. Add `branded: true` when an
open-ended prompt names a brand. For a comparison, use:

```yaml
preference:
  kind: head-to-head
  brandA: PostHog
  brandB: Amplitude
```

Write both brands in the prompt itself; metadata is only for analysis and never
rewrites the task. `gauge run --verify`, `--dry-run`, and `gauge run` support mixed experience
and preference cases.

Preference uses the existing app analyst: ranked picks for open-ended cases,
and a winner (or neither) for head-to-head. Results are advisory. Preference-only
GitHub checks finish neutral; experience criteria still gate mixed case sets.
`gauge run wait --check` exits successfully for `MEASURED` or `PASSED`;
input, execution, and analysis errors exit 1. Results describe the
candidate revision and do not infer a base/head delta.

## Local process lifecycle

`gauge run --local` runs in the foreground. Ctrl+C (or SIGTERM) stops the
queue, cancels active sessions, waits for cleanup, and exits with code 130.
Partial results and traces remain under `.gauge/runs`. Successful sessions
remove their containers and temporary credentials; the Docker image stays cached.

Use `gauge run --detach --local` to keep a batch running after the CLI exits.

Use `gauge run --local --runtime-image my-runtime:dev` to select a compatible
custom image, including with `--dry-run` or `--detach`. Derive from the standard
runtime to add Python or other system dependencies; see the
[Python example](https://github.com/gauge-sh/gauge-cli/tree/main/examples/runtime-python).
Preserve the runtime's tools, contract label, PATH, host-user permissions, and
entrypoint behavior. Gauge validates
the image before accepting a batch and pins its immutable ID for queued sessions.
A detached supervisor drains the queue and exits when the batch settles. The
launch prints its batch ID and these commands, to run from the same repository:

```sh
gauge run status --batch <batch-id> --local
gauge run wait --batch <batch-id> --local
gauge run cancel --batch <batch-id> --local
```

`gauge run wait --batch <batch-id> --local` blocks until the batch settles
(`completed`, `canceled`, `failed`, or `interrupted`), then prints each
session's state and the next step. It exits 0 once settled; `--check` exits 1
unless every session completed.

`gauge run status <run-id> --local` inspects a single session;
`gauge run cancel <run-id> --local` cancels only that run. All support `-o json`.
Batch cancellation is persisted before workers are contacted, including during
startup. A pending cancellation returns nonzero; inspect status before retrying.

After an interruption, `gauge cleanup --local` retries cleanup for recorded
interrupted sessions or sessions with incomplete cleanup in this repository.
It preserves evidence and recovered work, and makes recovered results visible
in `gauge run list`. It leaves live sessions, other repositories, unrelated
containers, and cached images alone. Recovery checks Gauge's container label
and workspace mount before removing a remaining container. Uncertain worker
ownership is reported rather than signaling a potentially reused PID.

Local workers have a 30-minute turn deadline and a 60-second supervisor
response deadline, so losing a supervisor cannot leave an idle worker forever.
Cleanup cannot discover sessions whose `.gauge` records were deleted; keep
those records until cleanup has succeeded.
