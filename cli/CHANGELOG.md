# Changelog

## Unreleased

### Fixed

- Selecting an organization by public slug now checks access even when it is
  absent from `gauge orgs`. Lookup outside the list requires Chat to be enabled.

### Changed

- **Breaking:** `gauge optimizations` drives the new optimizations: open one on an
  issue, a finding, or a goal; edit pages, skills, and CLI rules with
  `file add`, `file read`, `file write`, and `file rm`; read `authoring`
  guidance; keep `notes`; `launch` reruns of the source sessions; `watch` them;
  and `finish` with the result. Rounds, trials,
  baselines, diagnoses, adoption, and handoff are removed. Earlier CLI versions
  get an update message from the optimizations API.

### Removed

- `gauge actions`. `gauge status` no longer lists open actions.

### Added

- `gauge issues list` ranks every issue (the same finding across many
  sessions) by impact, with its type (friction or objection) and product;
  `--type` filters, and `gauge issues get <id>` lists an issue's findings and runs.
  `gauge run insight` shows each finding's id and issue. `gauge instructions
  issues` explains issues, also called findings, and how to choose one.
- `gauge run trace <id> --seq <n>` prints the trace around a seq,
  `gauge run web <id>` lists every URL the agent fetched, and
  `gauge run commands <id>` prints the shell output the agent saw.
- `optimizations file edit` changes part of a page with find/replace on its
  exact source; `file read --text` and `--query` show readable text or the
  source around a match. Page writes and edits print how much of the page was
  kept, and `launch` lists the changed files.
- `optimizations file write --cli` takes CLI rules as authored
  (`{schemaVersion: 3, target, rules, shippingIntent}`); Gauge seals them.

## 0.25.0 — 2026-10-26

### Added

- `gauge chat` commands to manage topics, prompts, tags, and brands, and read
  reports, answers, and citations. Sign in with `gauge auth login` or use an
  organization API key from Settings → API Keys.
- One login for Chat and Agents. The CLI keeps you signed in automatically.
- `web-fixture` inputs serve exact HTTPS pages, block missing pages under a
  scope, or route a site's origin to a preview, in both local and hosted runs.
  Declare one in `gauge.json`, select it with `config.inputs`, and override it
  with `--input name=path.json`. See [web fixture inputs](../docs/local-web-fixtures.md).
- Local runs that select a web fixture start a gateway container alongside the
  agent. The agent image needs no changes or proxy settings. `gauge local
  runtime inspect` and `pull` now cover the gateway image, and
  `--gateway-image` selects a custom build.

### Changed

- Choose an organization once for both Chat and Agents with `gauge orgs use`.
- **Upgrade:** Signing in updates your old saved default automatically if you
  have only one organization. Otherwise, choose from `gauge orgs` with
  `gauge orgs use <slug>`. Add `--project` to update an old project setting.
  Projects updated this way require CLI 0.25.0 or later.
- `gauge whoami` shows which account or API key you are using. `gauge auth
  status` checks your login or API key and its permissions.
- `gauge auth logout` signs out this CLI installation.
- Command telemetry requests send a `gauge-cli/<version>` User-Agent, matching
  Gauge API requests.
- Errors and help explain organization selection, sign-in recovery, permissions,
  and local runs in plain language, with commands to resolve the problem.

## 0.24.0 — 2026-10-21

### Added

- `gauge eval` and `gauge preference` list and get show who created each item
  (a "created by" column and `--json` field), and `list` accepts
  `--created-by <email|me>`. Shows `--` when no creator is available.
- `gauge usage` shows who started the session each ledger entry charges or
  refunds (a "started by" column and `--json` field).

### Changed

- Run skill sets no longer have a 32-skill limit.

### Fixed

- Antigravity runs no longer fail when the agent recovers from a transient API
  error. Only a run whose process exits with an error is marked as failed.
- `gauge run cancel --batch` no longer reports stopped runs as pending when a
  cancel races the batch's own shutdown.

## 0.23.0 — 2026-10-20

### Added

- Hosted Antigravity runs for enrolled organizations. Select
  `--agent antigravity:<model>` or use `ANTIGRAVITY` in case configuration;
  find available models with `gauge models list --hosted`.
- Input overrides accept globs, and files inputs accept single files.
- Previews list archived files and unused inputs, with flags to attach them.

### Changed

- **Breaking:** Saved evals and preference prompts no longer store project
  inputs. Attach inputs when launching locally with `--input <name>`;
  `create` and `edit` no longer accept `--input` or `--clear-inputs`.
  Previously saved inputs are not attached automatically.
- `--input <name>=<path>` replaces the configured files instead of applying
  the input's path filters within that directory. Overrides retain the input's
  type and settings and reject excluded directories such as `.gauge/`.

### Fixed

- Input directories skip symlinks and special files instead of failing.
- Workspaces inside Git-ignored directories load their own configuration
  and cases.
- Input errors distinguish excluded paths from globs with no matches.
- Failed local runs show the agent's last error and stderr log path. Runs
  stopped by an agent question explain why they ended.
- `gauge run` rejects repeated `--eval` or `--preference` flags.

## 0.22.0 — 2026-10-20

### Added

- Local Docker execution for eval and preference cases, using Skill, CLI,
  SDK, and files inputs. `--dry-run` checks readiness without starting sessions;
  `--verify` checks local inputs without a login.
- Local saved evals and preference prompts with durable IDs and revisions.
- Local session analysis with `gauge run analysis save`, findings through
  `run insight`, and analytics through `gauge query`.
- `gauge run repair --local` rebuilds session summaries while preserving
  measurements and analysis.
- Native ARM64 runtime support, including Apple Silicon, and custom local
  images through `gauge run --runtime-image`.
- Local credential profiles for native logins and API keys. Claude Code
  can reuse the host's existing login.
- `gauge local runtime inspect` checks readiness; `gauge local runtime pull`
  downloads the supported image.
- Background local batches with `--detach`, plus status, wait, cancellation,
  and cleanup commands. Ctrl+C cancels active sessions and preserves results.
- `gauge run compare` compares local or hosted runs by agent and model.
  Hosted comparisons include cost and duration; optimization trials can be
  selected with `trial=<id>`.
- Saved eval and preference launches accept `--agent` and `--samples`
  overrides without editing the saved configuration.
- Run details include eval revisions and optimization trial information.
  `gauge run status <request-id>` shows hosted request progress.
- JSON case specs through `gauge run --apply <file>` or `--apply -` for stdin.
  Cases support local and hosted execution; battery specs remain hosted-only.
- `gauge install-skill` installs the optional Gauge skill, with agent,
  project/global scope, and non-interactive options.
- Anonymous command usage telemetry. Opt out with `gauge telemetry disable`
  or `GAUGE_TELEMETRY_DISABLED=1`.

### Changed

- **Breaking:** `gauge run wait` exits 0 when a request settles, regardless
  of its verdict. Use `--check` in CI to fail unless the result is `PASSED`
  or `MEASURED`.
- **Breaking:** Run commands are grouped under `gauge run`; saved measurements
  use `gauge eval` and `gauge preference`. Use `run --eval <id>` or
  `run --preference <id>` to launch them, and `run get <id> --logs` for logs.
- Backend selection follows explicit `--local`/`--hosted` flags, workspace
  preference, user preference, then local. Shared `gauge.json` files no longer
  accept `mode`.
- `gauge init` works without Git or an account. Add `--cases` to scaffold
  shared cases in `gauge-cases/`.
- CLI case runs use current working-tree definitions and inputs, including
  uncommitted edits. GitHub checks continue using committed files.
- Local mode reports hosted-only features before attempting account setup.
  `gauge models list` shows locally supported agents.
- `gauge feedback` accepts anonymous reports without an account.
- `gauge auth login` selects the default organization when only one is available.
- Help and instructions explain setup, backend choices, and supported workflows.
  `gauge instructions <command>` falls back to command help when no topic exists.
- Errors include available hints and docs links; JSON errors go to stderr.
  Usage errors exit 2, and rate-limit errors report when to retry.
- Optimization commands use `edit` and `rm` in place of `update` and `delete`.

### Removed

- Legacy command groups `evals`, `runs`, `apply`, `batches`, and `run-requests`;
  use `eval`, `preference`, and `run`.
- `run fork-plan`, `optimizations invocation`, `repos add --ref`, and
  the `credentials`, `optimize`, and `run --stdin` aliases.
- `keys set --key`; supply keys through stdin or `GAUGE_PROVIDER_KEY`.
- `eval tag` and `preference tag`; use `edit --tag` or `--clear-tags`.
- `instructions --install` and `--dir`; use `install-skill`.
- `gauge canary` and `gauge catalog`.

## 0.21.0 — 2026-10-13

### Added

- `gauge feedback --message <text>` sends feedback to the Gauge team.

### Changed

- `gauge runs insight` shows products considered, chosen, and rejected.
- Criterion results distinguish failures from criteria that were not assessed.

### Removed

- `gauge runs fork`, `gauge runs fork-boundaries`, and the `--fork-run`
  and `--fork-boundary` options on optimization trials.
- `gauge preference synthesize`.

## 0.20.0 — 2026-10-09

### Changed

- Billing and organization details show invoice credit usage and limits,
  plus the payment type (`invoice` or `card`). Organization JSON adds
  `paymentType` and `creditLine`.

## 0.19.0 — 2026-10-09

### Added

- `gauge optimizations baselines` finds eligible baselines for an eval or
  preference prompt. `start --from-run <id>` reuses a baseline's agent and model.
- Docs page output reports content provenance and warns when using scraped content.

### Changed

- Optimization guidance covers baseline selection, reviewed rounds, and handoff.
- CLI change help documents the v3 rule format.

## 0.18.0 — 2026-10-09

### Added

- Repeatable `--input name=path` on eval plans and runs supplies local Skills,
  npm packages, files, and binaries without the GitHub App. Runs use current
  evaluation files, including uncommitted edits.
- v2.7.0 editor schemas allow input `source` to be omitted, defaulting to Git.

### Fixed

- Run hints include the selected organization.
- Verification accepts GitHub Actions' default PR merge checkout.

## 0.17.1 — 2026-10-08

### Removed

- Automatic global Skill installation during CLI installs and upgrades.
  Install the optional Gauge skill explicitly.

## 0.17.0 — 2026-10-07

### Added

- Committed Agent Preference cases with `open-ended` or `head-to-head` kinds,
  plus v2.6.0 editor schemas. Preference results are advisory, and request
  waits accept `MEASURED` as a successful result.
- Run details report who triggered a run and its net credits charged.
- Cursor pagination for eval and preference run lists.

### Changed

- Eval and preference run-list JSON uses `{ items, nextCursor? }` instead
  of a bare array.
- Preference help uses the term “open-ended.”

## 0.16.0 — 2026-10-07

### Added

- Per-case `config.checks.paths` filters for automatic GitHub PR checks,
  with v2.5.0 editor schemas. Explicit CLI launches and GitHub reruns ignore
  these filters. Upgrade from 0.15.0 before using the new field.

## 0.15.0 — 2026-10-07

### Added

- `gauge evals verify` checks configuration, cases, inputs, and recognizable
  GitHub Actions workflows without starting sessions. Definite problems exit 1.
- Native binary inputs for unpacked Linux x86-64 executables.
- Website inputs route canonical origins to public previews from GitHub
  Deployments or configured PR comments.
- Changed-file filters for GitHub PR checks; repositories without cases are skipped.
- Run details list Skills supplied by PR inputs.
- Optimization handoff instructions and clearer failed-session reporting.

### Changed

- **Breaking:** v2 `gauge.json` inputs use `type`, `source`, and `path`/`paths`
  to consume committed files or existing Actions artifacts. Migrate older
  root `github` and input `use` fields; product build and prepare/install
  scripts are no longer supported.
- Cases default to `gauge-evals/**/*.md`; `--files` accepts paths and globs.
  Plans and runs use committed HEAD; verification checks working files.
- npm inputs can install globally or in the consumer workspace. Skills can
  use committed directories or ZIP/tar.gz artifacts.
- Versioned editor schemas are available for configuration and case frontmatter.

### Removed

- `gauge optimizations estimate` and the `--effort`, `--samples`, `--rounds`,
  `--trials-per-round`, `--credit-cap`, and `--target-score` options.
  Optimizations run one round at a time without a round limit or budget.

## 0.14.0 — 2026-09-30

### Added

- `gauge update` installs the latest CLI globally through npm.
- Automatic global Gauge Skill installation during npm installs and upgrades;
  CI and `GAUGE_SKIP_SKILL_INSTALL=1` skip installation.
- Eval authoring guidance through `gauge instructions evals`.

### Changed

- `gauge instructions` shows an overview and points to full topic guidance.
- `gauge instructions optimization` loads the full optimization guide;
  `optimizations` remains an alias.
- Connection lists show both placeholder names for Basic authentication
  without exposing credentials.

## 0.13.0 — 2026-09-29

### Removed

- `gauge experiments` and `gauge optimizations resume`. Use `gauge optimizations`;
  resume legacy paused optimizations in the web app, or cancel them.

## 0.12.1 — 2026-09-29

### Added

- `gauge optimizations authoring <id>` lists editable surfaces and baseline
  commands; `invocation` shows an individual baseline invocation.
- `gauge optimizations cli-change` builds a CLI intervention from a JSON file.
- `gauge optimizations round preview` validates a round and shows its diff;
  `round save` saves drafts without launching sessions.
- `gauge optimizations trials remove` removes a pending draft trial.

## 0.12.0 — 2026-09-29

### Added

- `gauge evals plan` and `run --files` preview and launch committed Markdown
  cases without creating saved evals or changing schedules.
- `gauge run-requests wait <id>` waits for execution and judging, with JSON output.
- Optional root `gauge.json` configures the organization, product bundle,
  build steps, and GitHub PR cases.

## 0.11.2 — 2026-09-25

### Added

- `gauge runs regrade <id>` judges a finished session against the eval's
  current criteria without running another coding session.

### Changed

- Clearer help for evals, experiments, MCP, Skills, and optimizations.

### Removed

- Skill addition/removal options on optimization trials. Trials edit a Skill
  the baseline already loaded.

## 0.11.0 — 2026-09-21

### Added

- `gauge instructions [topic]` prints the agent guidance bundled with the CLI;
  `--list` names topics and `--install` writes a Skill file.
- Optimization workspace commands for creating drafts, launching rounds,
  continuing work, viewing activity, chatting, and deleting workspaces.
- Trial templates, edited Skill uploads, and idempotency keys to prevent
  duplicate trial creation on retries.
- Optimization details report the next action needed.
- `gauge connections list` shows available credential references without
  exposing secret values.

### Fixed

- Starting an optimization launches its baseline; candidates require an
  explicit launch. Credits are charged per session; `--credit-cap` records
  an estimate rather than enforcing a spending limit.
- Adoption and continuation accept trial keys as well as IDs.
- `watch` exits 4 when user input is needed; `--follow` keeps watching.
- Optimization lists include drafts by default; `--no-drafts` excludes them.
- Adoption asks for confirmation; `--yes` skips the prompt.

### Removed

- `gauge optimizations pause`; use `cancel` or `complete`. Legacy paused
  work remains recoverable through `resume` or `cancel`.
- `gauge optimizations propose`; author changes with `trials add` or use
  the optimization chat.

## 0.10.0 — 2026-09-11

### Added

- `gauge optimizations` manages trials that improve docs and Skills against
  eval or preference results, including baseline diagnosis, launch, monitoring,
  and adoption. Requires the organization's Optimizations feature.

### Changed

- `gauge experiments` becomes read-only for organizations using Optimizations.

## 0.9.0 — 2026-09-09

### Changed

- **Breaking:** Eval and preference configurations replace shared presets and
  cycles. Upgrade before using renamed commands.
- Eval creation and editing accept repository, persona, agent, resource,
  cadence, and sample settings directly. Omitted edit flags retain their values.
- Preference prompts have names and shared run settings; scenarios select
  repositories and personas.
- Run commands launch saved settings without changing schedules. Use
  repeatable `--scenario <id>` to select preference scenarios.
- `--agent` is optional when editing run settings; organization defaults apply.

### Added

- `gauge preference scenarios list|add|rm` manages scenario repositories and personas.

### Removed

- `gauge presets`, `gauge cycles`, and eval/preference preset attachment commands.
- `--preset` and `--one-off` on run commands.
- Eval and preference `pause`/`resume`, and `create --disabled`;
  use `--cadence none` to stop scheduled runs.
- The `run_preset` query dimension no longer applies to new runs.

## 0.8.0 — 2026-08-28

### Added

- `gauge models list` discovers available models, agents, providers, and capabilities.
- Preset and filter flags accept Pi and OpenCode.
- Run details show catalog model labels and selected versus observed providers.

## 0.7.0 — 2026-08-16

### Added

- Run presets configure repositories, personas, agents, model pins, Skills,
  and MCP servers. Evals and preference prompts can attach presets or launch
  one-off configurations.
- Commands to manage personas, Skills, MCP servers, dashboards, members,
  organization settings, and repository settings.
- `gauge status` shows an organization summary; `gauge actions` and
  `gauge impl` manage actions and implementations.
- `gauge preference synthesize` generates preference insights.
- Onboarding seeds starter evals and preference prompts from a site scan;
  `--no-seed` skips this step.
- Run details and queries include preset information.

### Removed

- Retired `gauge prompts`, `gauge schedules`, and `gauge topics` commands.
- Unused `--topic` filters on stats and queries.

### Fixed

- `gauge apply` reports batch IDs correctly.
