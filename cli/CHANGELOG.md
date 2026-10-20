# Changelog

## Unreleased

### Fixed

- Input directories skip symlinks and special files instead of failing on them.
- A workspace inside a Git-ignored directory, such as `.gauge/`, reads its own
  `gauge.json` and cases.
- A files glob into `.gauge/` (or another excluded directory) names the
  exclusion. A glob with no match says "No files match", not "No committed files".
- A local run that fails because the agent exits shows the agent's last stderr
  line and prints the path to `agent.stderr.log`.
- A local run stopped because the agent asked a question says so. Before, it
  showed `canceled` with no reason.
- `gauge run` rejects a repeated `--eval` or `--preference`. Before, it kept
  only the last id.

## 0.22.0 — 2026-10-20

### Removed

- Removed `run fork-plan` and its unused response schemas.
- Removed the retired `optimizations invocation` command, unused `repos add --ref`,
  inline `keys set --key`, and aliases `credentials`, `optimize`, and `run --stdin`.
  Use `connections`, `optimizations`, and `run --apply -`; supply keys through
  stdin or `GAUGE_PROVIDER_KEY`.
- Removed `eval tag` and `preference tag`; use `edit --tag` or `--clear-tags`.
- Removed `instructions --install` and `--dir`. Install the Gauge skill with
  `install-skill` and read current guidance through `instructions <topic>`.
- Removed unused copied schemas and ordinary source comments. Release bundles
  omit generated source paths.
- Cleaned up source imports and test fixtures for public development.

### Changed

- Local verification, launch, and saved measurements reject hosted-only MCP
  settings consistently. Guidance explains hosted setup, access checks, credits,
  and the limits of local alternatives without silently changing backends.
- First-run guidance creates a saved measurement before previewing or launching.
  Saved-measurement instructions cover rerunning changed inputs and explain
  which input and preview capabilities require case files/specs on hosted Gauge.
- Backend selection is independent of login and shared cases: explicit flags,
  private `.gauge/config.json`, user preference, then local. `gauge.json` holds
  shared project inputs and optional case discovery; it does not accept `mode`.
- `gauge init` works without Git or an account, creates private SQLite state, and
  scaffolds shared `gauge-cases/` only with `--cases`.
- CLI case runs snapshot working-tree definitions and selected filesystem inputs
  for both local and hosted execution. GitHub checks continue using committed
  files. The default shared case directory is `gauge-cases/`.
- In local mode, hosted-only commands say they need hosted Gauge and print the
  next step, not an organization or login error.
- `gauge models list` in local mode lists the agents local runs support.
- `gauge install-skill` run by a coding agent installs for that agent at project
  scope without prompts and prints the install path and skills.sh audits instead
  of the installer's full output. Without a detectable agent, non-interactive
  runs require `--agent`.
- Root help groups hosted-only commands, and the README has a local and hosted
  capability table.
- `gauge feedback` works without an account. Signed out, it sends the
  feedback anonymously and with no org. Error output shows the "Hit friction?"
  line in local mode too.
- A rate-limited request says when to try again, and a 5xx says it is a Gauge
  server error.

### Added

- Local saved evals and preference prompts have durable IDs and revisions in
  `.gauge/gauge.sqlite`; launches preserve their configuration and provenance.
- Coding agents publish structured local analysis with `gauge run analysis save`.
  Findings, criteria, products, and evidence are validated and versioned; session
  transcripts and diffs remain files. `run insight` shows findings on both backends.
- `gauge query` selects local or hosted analytics with capability discovery and
  explicit unsupported-field errors. Both support current-analysis findings and
  analysis coverage; local transcript search scans selected artifact files.
- `gauge run repair --local` repairs session summaries from artifacts while
  preserving authored measurements and analyses.

- `gauge init` recommends the Gauge agent skill as the first setup step,
  using `gauge install-skill`. The command forwards installer prompts and supports
  explicit agent targets, global scope, noninteractive installation, and copies.

- Native ARM64 local runtime support, including Apple Silicon Docker daemons.
  Runtime releases test both architectures on native runners and pin one
  multi-platform image digest. Linux is the container OS, not a host requirement.
- `gauge run --runtime-image` selects a custom local image, checks its contract,
  and preserves its immutable identity for queued and detached sessions.
- Local credential profiles support native logins and API-key references, with
  actual-target preflight, redacted inspection, and stable detached selections.
- `gauge local runtime inspect` reports Docker runtime readiness without a login
  or download; `gauge local runtime pull` installs the supported public image.
  CLI releases pin an anonymously qualified runtime digest.

- Anonymous command usage telemetry runs in an independent, short-lived worker.
  Use `gauge telemetry disable` or `GAUGE_TELEMETRY_DISABLED=1` to opt out.
- `gauge instructions init` covers workspace setup and backend preferences.
- `gauge instructions <command>` prints that command's help when no topic has
  its name. Topics end with their `gauge <command> -h`, and command help links
  back to its topic. Command help lists global options such as `--local` and
  `--hosted`.
- Local runs cancel and clean active sessions on Ctrl+C. Use `--detach` for
  a background batch, `run status` for live progress, `run cancel <id>` or
  `run cancel --batch <id>` to stop work, and `cleanup --local` to recover
  interrupted sessions while preserving results and cached images.

- `gauge run compare` takes `trial=<trialId>` to compare one optimization
  trial's runs, and names the trial behind each side's trial runs.
- `gauge run list` and `gauge run get` show `optimizationTrial` when an
  optimization trial launched the run.
- `gauge run compare --baseline <key=value> --candidate <key=value>` compares
  two sets of runs: pass rate, criteria, and median turns, cost, and duration,
  per agent and model. Selectors: request, batch, eval, revision, experiment,
  agent, model, since, until.
- `gauge run --eval <id>` and `--preference <id>` take `--agent` and
  `--samples` for one launch. The stored configuration stays unchanged.
- Runs show an `evalRevision` (in `gauge run list` and `gauge run get`): a hash
  of the prompt, repo, persona, agent context, and criteria. Edits to an eval
  start a new revision.
- `gauge run status <request-id>` prints a hosted launch request's progress once.
- `gauge run wait --batch <id> --local` waits for a local batch to settle, then
  prints each session's state and the next step. `--check` exits 1 unless every
  session completed. `gauge run --detach` prints this command.
- `gauge run compare` is hosted only. Local mode exits with a usage error.
- Local `gauge run` runs this repo's cases in local Docker, waits, and
  prints the next step: session analysis. It supports skill, CLI, SDK, and
  docs (`files`) inputs.
- `gauge run --apply -` reads a run spec from stdin.
- `gauge run --apply` takes a case spec: eval cases as JSON (`cases`), with no
  Markdown files. It supports local and hosted runs. Locally, criteria are optional;
  hosted cases need criteria or preference. Battery specs (`prompts`) stay
  hosted only. `--example` and `--schema` print the case spec local and the
  battery spec hosted.
- Local `gauge run --dry-run` plans locally: it needs no org and starts no
  sessions. It also warns about Docker, the runtime image, and agent logins.
- Local `gauge run --verify` checks inputs the way a local run reads
  them: from disk, with git-ignored files such as `.gauge/*.tgz`, and with no
  GitHub Actions workflow checks.

### Changed

- `gauge orgs use` asks the server to resolve the org. The CLI no longer
  checks membership itself.
- **Breaking:** `gauge run wait` exits 0 once the request settles, whatever
  the verdict. CI jobs that must fail on a failed verdict need `--check`, which
  exits 1 unless the verdict is `PASSED` or `MEASURED`, and prints
  no error line after the JSON. Text output lists each session's result.
- `gauge --help` shows grouped commands, examples, and short summaries.
- In a repo without gauge.json, `gauge --help` and `gauge instructions` tell
  agents to infer hosted or local from the user's context, and to ask when
  they are not sure. They list
  `gauge init --hosted` and `gauge init --local`, signed in or not.
- `gauge auth login` sets the default org when you belong to only one org.
- `gauge init` writes `mode: hosted` and your org when you are signed in, and
  `mode: local` when you are not. `--local` and `--hosted` override this.
- Before setup, `gauge --help` and `gauge instructions` offer two choices:
  set up local evals in this repo (`gauge init`), or use a Gauge account
  (`gauge auth login`).
- Local Claude Code runs reuse the Claude Code login on this machine, like
  Codex. `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` still work.

- Every error now prints a hint when one exists, a docs link, and a
  `gauge feedback` command. With `-o json`, errors are a JSON object on stderr.
  `error:` is red in a terminal (not with `NO_COLOR`).
- Optimization verbs match the other groups: `optimizations update` is now
  `edit`, and `optimizations delete` and `optimizations trials remove` are now `rm`.

- Two command groups replace six. `gauge run` starts and reads runs;
  `gauge suite` manages eval sets and preference prompts. No API change.

  | Before | After |
  |---|---|
  | `gauge evals run` | `gauge run` |
  | `gauge evals run <id>` | `gauge run --eval <id>` |
  | `gauge preference run <id>` | `gauge run --preference <id>` |
  | `gauge apply -f <file>` | `gauge run --apply <file>` (`-` for stdin) |
  | `gauge evals verify`, `gauge evals plan` | `gauge run --verify`, `gauge run --dry-run` |
  | `gauge runs <verb>` | `gauge run <verb>` |
  | `gauge runs logs <id>` | `gauge run get <id> --logs` |
  | `gauge runs list --eval-set <id>` | `gauge run list --eval <id>` |
  | `gauge evals runs <id>` | `gauge run list --eval <id>`; verdicts in `gauge run get <run-id>` |
  | `gauge preference runs <id>` | `gauge run list --preference <id>` |
  | `gauge batches list`, `gauge batches get <id>` | `gauge run list --batch <id>` |
  | `gauge run-requests wait <id>` | `gauge run wait <id>` |
  | `gauge evals <verb> <id>` | `gauge suite <verb> eval <id>` |
  | `gauge preference <verb> <id>` | `gauge suite <verb> preference <id>` |
  | `gauge preference scenarios <verb> <id>` | `gauge suite scenarios <verb> <id>` |
  | `gauge preference markets` | `gauge suite markets` |

- Instruction topics: `run`, `suite`, `session-analysis`, `optimization`.
  `gauge instructions --install` removes the old `gauge-evals` and
  `gauge-preference` skills.
- Usage errors in subcommands exit 2.

### Removed

- `gauge canary` and `gauge catalog`.
- `gauge evals`, `gauge preference` (and `gauge visibility`), `gauge runs`,
  `gauge apply`, `gauge batches`, and `gauge run-requests`, with no aliases.
- The batch summary views of `gauge batches list` and `gauge batches get`.

## 0.21.0 — 2026-10-13

### Added

- `gauge feedback --message <text>` sends CLI feedback (`--kind friction|missing|bug|other`,
  `--command`) to the Gauge team.

### Changed

- `gauge runs insight` shows the session analysis: a products table
  (considered, chosen, rejected, install phase, rank, source) replaces the
  decisions table.
- Criterion verdicts can be "not assessed": `gauge evals runs` counts passed,
  failed, and not assessed; `gauge optimizations trial` marks them `?`.

### Removed

- `gauge runs fork` and `gauge runs fork-boundaries`.
- `--fork-run` and `--fork-boundary` on `gauge optimizations trials add`.
- `gauge preference synthesize`.

## 0.20.0 — 2026-10-09

### Changed

- `gauge billing status` and `gauge org get` show overage from the invoiced
  credit line (used and limit in dollars). The retired overage toggle and cap
  are no longer read.
- Both commands show the payment type: `invoice` or `card`.
- `gauge org get --output json` adds `paymentType` and `creditLine`.

## 0.19.0 — 2026-10-09

### Added

- `gauge optimizations baselines --eval <id>` (or `--preference`) discovers
  observed owned surfaces by run, with evidence, judging status, eligibility,
  and pagination.
- `gauge optimizations start --from-run <runId>` reuses the eligible baseline
  containing that run and inherits its harness/model.
- Docs page JSON includes content provenance; text output warns on scrape fallback.

### Changed

- Optimization instructions now cover discovery, baseline selection, reviewed
  rounds, automatic checkpoint reuse, exposure verification, and handoff.
- CLI change help describes the current v3 rule format. Retired invocation-ID
  reads direct consumers to authoring source references and run logs.

## 0.18.0 — 2026-10-09

### Added

- `gauge evals run` and `gauge evals plan` take repeatable `--input name=path`
  to supply locally built inputs (skill directories or archives, packed npm
  `.tgz`, file and binary directories) from any CI or workstation, without the
  GitHub App. Runs use your current evaluation files, including uncommitted
  edits; inputs without an override keep their configured source. See
  "Run from your own CI or local build" in the README.
- Publish v2.7.0 case schemas, which let `source` be omitted in `gauge.json`
  (defaults to Git).

### Changed

- `gauge evals run` prints a `Wait:` hint that includes `--org`.
- `gauge evals verify` recognizes the default pull_request checkout (the merge
  commit) as a valid candidate checkout, since Gauge now tests the artifact
  built by your PR's successful CI run.

## 0.17.1 — 2026-10-08

### Removed

- Remove automatic global `gauge-agents` skill installation from CLI installs
  and upgrades. Install the optional skill explicitly using the README command.

## 0.17.0 — 2026-10-07

### Added

- Add Git-authored Agent Preference cases: `preference.kind: open-ended` or
  `head-to-head`, using the same analyst and results as app-authored prompts.
  GitHub reports advisory selections, and `run-requests wait` accepts
  `MEASURED` without treating competitor choices as failures.
- Publish v2.6.0 case schemas.
- Runs carry `triggeredBy` (`{ source, userId, email }`) naming what started
  them: `UI`, `API` (a token, as its user), `CADENCE`, `GITHUB`, and so on.
  `runs list`, `runs get`, `evals runs`, and `preference runs` show it.
- Runs carry `creditsCharged`: net credits debited for the run (refunds
  subtracted); null when the run was never billed.
- `gauge evals runs` and `gauge preference runs` take `--cursor` to page past
  the most recent runs, like `runs list`.

### Changed

- Use “open-ended” for preference kinds in CLI help and app authoring.
- `gauge evals runs -o json` and `gauge preference runs -o json` now print the
  page envelope `{ items, nextCursor? }` instead of a bare array, matching
  other `--cursor` commands.

## 0.16.0 — 2026-10-07

### Added

- Committed eval cases accept `config.checks.paths` to select automatic GitHub
  PR checks by changed files. Root `checks.paths` gates the suite; each case can
  narrow its own triggers. Explicit CLI runs and GitHub reruns bypass filters.
- Publish v2.5.0 configuration and case-frontmatter editor schemas. Upgrade the
  CLI before authoring per-case filters; CLI 0.15.0 rejects the new field.

## 0.15.0 — 2026-10-07

### Added

- `gauge evals verify` checks working-tree configuration, cases, inputs, and
  recognizable Actions workflow patterns local. Text and versioned JSON report
  yes/no/unknown results; definite problems exit 1. No login or sessions are
  required. Static verification does not prove CI output or installation.
- Native `binary` inputs consume unpacked Linux x86-64 ELF executables from Git
  or Actions artifacts, preserve companion files, and expose explicit commands.
- Website inputs route canonical origins to public HTTPS previews discovered
  through GitHub Deployments or configured PR comments with an exact author,
  identifying marker, and candidate commit/URL captures.
- GitHub PR checks support changed-file glob conditions and skip repositories
  with no configured cases.
- Agent Preference instructions describe investigation and evidence workflows.
- Run details include PR-input Skills alongside other installed Skills.
- `gauge optimizations handoff <id>` prints the web app's "Copy instructions
  for agent" text for the winning trial. `gauge instructions` points to it.
- `gauge optimizations trial`, `get`, and `watch` flag failed and timed-out
  sessions with their failure reason, separately from incomplete CLI evidence.
  Trials carry `failedSessions`; each run carries `failureReason` and `exitReason`.

### Changed

- Redesign committed `gauge.json` inputs around `type`, `source`, and `path`/`paths`.
  Each Actions input names its workflow; different inputs may use different workflows.
- Discover cases in `gauge-evals/**/*.md`. A committed organization and its GitHub
  App installation enable PR evaluations without `github.enabled`.
- Install npm packages into the environment (commands on PATH) or the consumer
  workspace (including libraries). Plan output explains installation and shows
  command names from captured metadata when available.
- Accept Skills as committed directories or selected ZIP/tar.gz artifacts, and
  publish versioned configuration and case-frontmatter editor schemas.
- Earlier pilot configs need migration from root `github` and input `use` fields;
  persisted execution plans and receipts remain readable.
- Git-native cases default to committed `gauge-evals/**/*.md`; `--files` accepts paths/globs.
  `plan` and `run` use committed HEAD; `verify` checks working files.
- v2 `gauge.json` inputs consume existing GitHub Actions artifacts or committed files
  as files, npm CLIs, or native Skills. Product builds and prepare/install scripts
  are removed. Plans show CI readiness; requests wait before billing and report
  actionable input errors and immutable receipt evidence.

### Removed

- `gauge optimizations estimate`, and the `--effort`, `--samples`, `--rounds`,
  `--trials-per-round`, `--credit-cap`, and `--target-score` options on
  `start`, `start-draft`, `create`, `update`, and `continue`. Optimizations
  run one round at a time with no round limit or budget, as in the web app.

## 0.14.0 — 2026-09-30

### Added

- `gauge update` installs the latest published CLI globally through npm.
- npm installs and upgrades automatically install the upstream `gauge-agents`
  skill globally without prompts. CI and `GAUGE_SKIP_SKILL_INSTALL=1` skip the
  hook; skill installation failures do not fail CLI installation.
- `gauge instructions evals` prints eval authoring and model-selection guidance
  with a migration prompt and judging criteria example. The topic supports
  `--list` and `--install`.

### Changed

- `gauge instructions` now prints a Gauge overview, CLI setup and usage rules,
  and roughly 100 words of essential guidance per module, with commands for
  the full pages.
- `gauge instructions optimization` loads the full optimization page.
  `optimizations` remains an alias for existing callers.
- `gauge connections list` displays both username and password placeholder
  names for paired Basic-auth connections without exposing credential values.

## 0.13.0 — 2026-09-29

### Removed

- Removed `gauge experiments` and `gauge optimizations resume`; use
  `gauge optimizations`. Older CLIs get a 410 with an upgrade pointer from the
  retired `/experiments` and `/resume` endpoints. Resume a legacy paused
  optimization in the web app, or cancel it.
- `trials add --fork-boundary` help now points to `gauge runs fork-boundaries`.

## 0.12.1 — 2026-09-29

### Added

- `gauge optimizations authoring <id>` prints what the next round may change:
  intervention kinds, CLI targets and commands, baseline invocations, and the
  workspace `revision`. `gauge optimizations invocation <id> <invocationId>`
  prints one baseline CLI invocation.
- `gauge optimizations cli-change <id> --file change.json` builds a
  `CLI_INTERVENTION` bundle from `{targetId, commandId, selector, operations,
shippingIntent}`. Gauge supplies the catalog, hashes, and engine identity.
- `gauge optimizations round preview <id> --file round.json` validates a round
  and prints its diff and `previewDigest`. `gauge optimizations round save <id>
--file round.json --digest <d>` saves it as drafts and replaces every pending
  draft. Neither command launches.
- `gauge optimizations trials remove <id> <trialId>` drops one draft trial from
  the round that waits for launch.

## 0.12.0 — 2026-09-29

### Added

- `gauge evals plan --files <paths...>` previews committed Markdown cases and
  estimates their sessions; `gauge evals run --files <paths...> --yes` launches
  them without creating saved eval sets or changing their schedules. Each case
  carries its own agent, workspace, and judging configuration.
- `gauge run-requests wait <id>` follows the complete request through agent
  execution and judging and returns a settled result, including JSON output.
- Optional root `gauge.json` selects the organization and a shared product
  bundle. `product: {"type":"npm-cli"}` builds a committed pnpm CLI once per
  request and exposes its package bins in each case; `product.build` overrides
  the build command. A `prepare` script with an optional `install` script also
  supports other products. `github: {"enabled":true,"files":["evals/case.md"]}`
  declares explicit cases for GitHub PR runs.

## 0.11.2 — 2026-09-25

### Added

- `gauge runs regrade <id>` re-judges a finished eval session against its eval
  set's CURRENT criteria. Edit the criteria (`gauge evals edit --criteria-file`),
  then regrade — no second coding session.

### Changed

- Clarified `--help` text across `evals`, `experiments`, `mcp`, `skills`, and
  `optimizations` (no command behavior changed).

### Removed

- `optimizations trials add --skill-version`, `--remove-skill`, and `--kind`.
  An optimization edits a skill the baseline loaded; it never adds or removes
  one. The server refuses ADD_SKILL and REMOVE_SKILL.
- `trials template --kind` no longer offers ADD_SKILL or REMOVE_SKILL.

## 0.11.0 — 2026-09-21

### Added

- `gauge instructions [topic]` prints the CLI's agent instructions to stdout, as
  a skill file with frontmatter. With no topic it prints every topic under one
  frontmatter block; a topic reprints that group alone. `--list` names the
  topics, `--install` writes the file under `.claude/skills/`. The instructions
  ship with the CLI, so they cannot drift from the commands they describe.
  First topic: `optimizations`.
- `gauge --help` now tells a coding agent to run `gauge instructions` first.
- Optimization workspace commands: `create`, `update`, `start-draft`, `launch`,
  `continue`, `activity`, `chat`, and `delete`. `create` never launches work,
  even with a pinned target.
- `--trials-per-round` on optimization plans and continuation.
- `optimizations trials add --edit-skill <id> --skill-dir <path>` sends a skill
  bundle edited on disk. `optimizations skill-files <id>` prints the base.
- `optimizations trials template --kind <kind>` prints a fillable trial JSON
  skeleton for `trials add --file`.
- `optimizations trials add --idempotency-key <key>`. A retry with the same key
  returns the first call's trial and never buys a second set of sessions.
- Every optimization detail carries `nextAction`: the one step the workspace
  needs (`START`, `WAIT`, `AUTHOR_TRIAL`, `LAUNCH_ROUND`, `ADOPT`, `RESUME`,
  `NONE`). `get` and `watch` print it.
- `gauge connections list` (alias `gauge credentials list`): the credential
  ids `--connection <id>` accepts. Until now the flag took an id the CLI
  offered no way to read. The route is read-only and carries identity and
  reach only — handle, vendor, placeholder env var, allowed domains, static
  vs OAuth, and the last four characters of the value. No secret, secret
  reference, or OAuth token is expressible in the response.

### Fixed

- `start` launches the baseline in interactive mode; candidates require an
  explicit launch. Estimates include the baseline and all planned candidates.
  Credits are charged per session, not reserved up front; `--credit-cap` is a
  recorded estimate, not an enforced spending limit. Zero is accepted.
- `complete --adopt` and `continue --from` accept trial keys as well as IDs.
- `watch` exits when an optimization needs user input; `--follow` keeps polling.
  It now exits `4` in that case, so a script can tell "your turn" from "done".
- `optimizations list` includes draft workspaces by default; `--no-drafts`
  leaves them out. It replaces `--include-drafts`.
- `optimizations adopt` confirms first, like every other command that changes
  the moving baseline. `--yes` skips the prompt.
- Legacy paused optimizations remain visible through `list --status PAUSED`
  and recoverable through `resume` or `cancel`.

### Removed

- `gauge optimizations pause`. New work uses `cancel` or `complete`; `resume`
  remains available for legacy paused optimizations.
- `gauge optimizations propose`, with the `/propose` and `/rounds/current/replan`
  endpoints behind it. Model-written proposals live in the optimization chat;
  a CLI or API caller authors the change itself and sends it with `trials add`.

## 0.10.0 — 2026-09-11

### Added

- `gauge optimizations` (alias `gauge optimize`).
  Optimizations are Gauge-led hill climbs that change one owned surface per
  trial (a docs page, a skill, later an SDK or CLI version), re-run an eval or
  preference prompt, and adopt what improves the score. The group mirrors the
  product and the in-app agent one for one:
  `list`, `get`, `diagnose --eval|--preference`, `estimate`, `start --target
claude-code:<model> [--effort low|medium|high|xhigh]`, `watch`, `pause`,
  `resume`, `cancel`, `trials list|add|run`, `trial`, `change [--body]`,
  `adopt`, `propose`, `skill-files`, `page --url`.
  `start` prices the climb first and reserves the estimate as the credit cap
  unless `--credit-cap` is given; it and every launch take `--yes`.
  Orgs without the Optimizations feature answer 404 on the whole group.

### Changed

- `gauge experiments` is legacy. Orgs with Optimizations answer 409 on its
  writes; reads still work for old experiments.

## 0.9.0 — 2026-09-09

The CLI speaks the product's nouns, and each measurement owns its own run
configuration. An eval carries one configuration. A preference prompt carries
one set of run settings, and its scenarios are plain repository × persona
cells. Shared run presets and shared cycles are gone.

**Breaking.** The retired and renamed paths answer 403 with an upgrade
pointer, so upgrade before scripting against them.

### Changed

- `gauge evals create|edit` carry the complete run configuration directly:
  `--repo/--ref`, `--persona`, `--agent`, `--skill`, `--mcp`, `--connection`,
  `--cadence`, `--samples`. One eval is one configuration; copy the eval to
  measure the same prompt somewhere else.
- `gauge preference create` requires `--name` and takes the same run-settings
  flags, plus `--repo/--ref/--persona` for the prompt's first scenario.
  `gauge preference edit` accepts those flags with their `--clear-*`
  counterparts, and `--name` renames the prompt. Omitted flags keep their
  stored value.
- Run-settings flags no longer require `--agent`: pass `--cadence weekly`
  alone and the org's default roster applies.
- `gauge evals run` / `gauge preference run` launch the stored configuration
  without touching the cadence clock. `gauge preference run --scenario <id>`
  (repeatable) runs a subset; omit it and every scenario runs.
- `gauge preference list|get` display the prompt name. `gauge preference get`
  prints the prompt's cadence, roster, resources, and scenarios;
  `gauge evals get` prints an eval's resources. Both read cadence `NONE` back
  as `manual`.
- `gauge batches get` no longer prints a preset.

### Added

- `gauge preference scenarios list|add|rm` — manage a prompt's
  repository × persona cells. `add` takes `--repo`, `--ref`, `--persona`;
  omit all three for the empty project with the default persona.

### Removed

- `gauge presets …` and `gauge cycles …`. Configuration lives on the eval;
  cadence lives on the eval or the preference prompt.
- `gauge evals presets|attach|detach` and the `gauge preference` siblings —
  nothing attaches to or moves between shared rows any more.
- `--preset` and `--one-off` on the run commands. Run Now uses the owned
  configuration.
- `gauge evals pause|resume` and the `gauge preference` siblings, plus
  `--disabled` on `create`. The app has never had a pause switch, and nothing
  else in the product writes one. Take a measurement off a cadence with
  `--cadence none`.
- The `run_preset` dimension in `gauge query` is inert for new runs.

## 0.8.0 — 2026-08-28

### Added

- `gauge models list` discovers the organization's live model × harness ×
  provider catalog and its effective capabilities.
- Preset and filter flags accept the public `pi` and `opencode` harnesses.
- Run list/detail output includes catalog model labels and distinguishes the
  selected provider from an observed upstream provider.

## 0.7.0 — 2026-08-16

Run presets are now the CLI's unit of configuration, and the command set
reaches full parity with every scriptable surface in the product.

### Added

- `gauge presets list|get|create|edit|rm|promote|runs` — author and manage run
  presets (repo × persona × agent roster with per-agent model pins × skill
  refs × MCP refs). `--agent claude-code:opus-4-8,sonnet-4` expresses model
  pins; `--skill`/`--mcp` take strict `name@label` refs validated locally
  (exit 2), one version per asset.
- `gauge evals presets|attach|detach <id>` and the `gauge preference`
  siblings. **Attach prints the per-cycle run arithmetic and asks before
  acting**; `--yes` skips. (Renamed to `scenarios list|add|rm` in 0.9.0.)
- `gauge evals run <id> [--preset <id>]... [--one-off …]` and
  `gauge preference run <id> [--preset <id>]...` — run a subset of attached
  presets, or a one-off config without attaching. Both print what the launch
  mints first and take `--yes`.
- `gauge preference synthesize` — queue the Agent Preference insight
  synthesizer.
- `gauge personas list|get|add|edit|rm`, `gauge skills
list|get|add|edit|reingest|rm|runs`, `gauge mcp list|get|add|edit|rm`.
- `gauge status` — one-shot org summary (actions, visibility, agent
  experience).
- `gauge actions list|status`, `gauge impl get|set|patch`,
  `gauge members list` (roster + pending invites, read-only),
  `gauge org get` (settings snapshot, read-only), `gauge repos edit`,
  `gauge dashboards list|get|create|rename|rm|filters`,
  `gauge keys disable-byok`.
- `gauge onboard` now seeds starter eval sets and the Agent Preference portfolio
  from a site scan (skip with `--no-seed`).
- `gauge query` gains the `run_preset` dimension.
- `gauge evals get` / `gauge preference get` print attached presets;
  `gauge batches get` prints the preset a batch expanded from.

### Removed

- `gauge prompts`, `gauge schedules`, `gauge topics` — old-world surfaces
  retired server-side since 0.6.0 (they only ever printed a 403 pointer).
  Tags are the grouping primitive; cycles + presets are the execution config.
- The inert `--topic` filters on `gauge stats` and `gauge query`.

### Fixed

- `gauge apply` no longer prints `batch undefined` for expanded batteries.
