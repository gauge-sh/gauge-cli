# Gauge CLI

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/gauge-logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/gauge-logo-light.svg">
  <img alt="Gauge" src="docs/assets/gauge-logo-light.svg" width="800">
</picture>

[![Package checks](https://github.com/gauge-sh/gauge-cli/actions/workflows/checks.yml/badge.svg?branch=main)](https://github.com/gauge-sh/gauge-cli/actions/workflows/checks.yml)
[![npm version](https://img.shields.io/npm/v/%40withgauge%2Fcli)](https://www.npmjs.com/package/@withgauge/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**An open-source CLI for hillclimbing Agent Experience.**

Make your Skills, CLIs, SDKs, MCPs and docs easier for coding agents to discover and
use. Gauge runs real agents against your product, captures where they get stuck,
and lets your own coding agent test fixes before you publish them.

The full loop runs locally with Docker and your existing agent subscriptions or
API keys. **No Gauge account required.**

[Website](https://www.withgauge.com/agents/) ·
[Documentation](https://docs.withgauge.com/agents) ·
[Hosted Gauge](https://agents.withgauge.com) ·
[npm](https://www.npmjs.com/package/@withgauge/cli) ·
[Changelog](cli/CHANGELOG.md)

## Access Gauge Chat data

Use the same login and public organization slug for Chat and Agents:

```sh
gauge auth login
gauge orgs use acme
gauge chat categories list
gauge chat query datasets
```

Chat commands cover topics, prompts, tags, brands, reports, answers, and
citations. See [Gauge Chat commands](cli/README.md#gauge-chat) and
[organization selection and upgrade guidance](cli/README.md#organizations).
These commands use hosted Chat data and do not require Docker.

## What does Gauge find?

Gauge runs and analyzes coding sessions to find the issues that coding agents run into.

Common findings include:

- An interactive command blocks a coding agent
- An agent reaches for deprecated commands or outdated API patterns
- A Skill goes unused even when it should help with the task
- An agent confidently claims a limitation that does not exist
- An agent cannot figure out the intended workflow across multiple commands

The right fix might change error messages, Skill content, help text, code,
or documentation. The Gauge CLI lets you validate proposed fixes before release.

## Quickstart

Gauge is designed to be used by your coding agent. Point it at this repository
and ask it to get started, or follow the steps below in the project you want to
improve.

You need Node.js **22.13+**, npm, Docker running Linux containers, and
credentials for the agent you want to test. Gauge supports Claude Code, Codex,
Pi, and OpenCode. It can use native Claude/Codex logins or API keys; agent usage
is billed through your provider or subscription.

### 1. Install Gauge and its runtime

```sh
npm install -g @withgauge/cli
gauge local runtime pull
```

Gauge downloads the published Docker image pinned to your CLI release. The
image contains the agent harnesses and standard development tools.

### 2. Set up your project

From your project directory (Git is optional):

```sh
gauge init --local
```

This creates a shared `gauge.json` manifest and private `.gauge/` workspace,
including a SQLite database and local backend preference. It also adds guidance
to `AGENTS.md`. Plain init creates no cases; add `--cases` when you want shared
Markdown cases in `gauge-cases/`. Commit the manifest, optional cases, and agent
guidance. Keep `.gauge/` private: it contains durable measurements and analyses.

### 3. Install the skill

The [Gauge skill](https://github.com/gauge-sh/gauge-skills/tree/main/gauge-agents) teaches your coding agent where to find the CLI's instructions:

```sh
gauge install-skill
```

## How the improvement loop works

Hillclimbing means making a change, measuring whether it helped, and repeating.

1. **Define realistic tasks.** Your agent saves evals or preference prompts with
   stable identities, editable defaults, and observable outcomes. Use optional
   Markdown cases for fully specified measurements intended for sharing or CI.
2. **Test your current product.** In local mode, Gauge starts fresh Docker sessions
   and injects the working-tree version of your configured inputs.
   Each test agent sees the task and configured inputs within its sandbox.
   Local mode supports Skills, SDKs, CLIs, and files. Hosted compute adds support for
   docs, authenticated MCPs, and authenticated APIs.
3. **Find friction.** Gauge normalizes events from Claude Code, Codex, Pi, and
   OpenCode into consistent transcripts. In local mode, your agent reads the evidence,
   checks the outcome against the criteria, and identifies what slowed or
   blocked the task. It publishes structured Findings and judgments through
   `gauge run analysis save`. In hosted mode, this analysis happens automatically after each session.
   `gauge run insight` shows the evidence.
4. **Change and retest.** Your agent edits the product or its guidance and reruns
   the affected cases against the new artifacts.
5. **Analyze the evidence.** Check whether the original problem disappeared,
   whether the task succeeded, and whether the change introduced new friction.

Skills and file inputs are read from your working tree. For an npm CLI or SDK,
build and pack a new tarball before rerunning. Gauge installs these pre-release
artifacts in the test sessions, so you can validate a fix before publishing it.

The CLI handles execution and evidence collection. In local mode, your coding agent authors
the changes and analyzes the local results.

## A closer look at an eval

Saved evals and preference prompts live in `.gauge/gauge.sqlite` locally or in
your hosted organization. Shared file-based cases optionally live in `gauge-cases/`;
`gauge.json` declares project inputs and automation. Both measurement sources
support local and hosted execution, with the input differences described below.
Start with a saved local eval; use a shared case when the task is ready for
teammates or CI.

<details>
<summary>Example: test a release-notes Skill</summary>

Create `skills/release-notes/SKILL.md`:

```markdown
---
name: release-notes
description: Write release notes for a new version in the team's format.
---

Write RELEASE-NOTES.md with the version as its title, an Added section for new
features, and a Fixed section for bug fixes. Use one bullet per change.
```

For a fresh project, use this `gauge.json`:

```json
{
  "version": 2,
  "inputs": {
    "release-notes": {
      "type": "skill",
      "path": "skills/release-notes"
    }
  }
}
```

Save the task and criteria:

```sh
gauge eval create --local --name "Release notes" \
  --agent codex --samples 1 \
  --text "Write the release notes for version 1.2.0. We added dark mode and fixed a login crash." \
  --criterion "Team format: RELEASE-NOTES.md has a version 1.2.0 title, dark mode under Added, and the login crash fix under Fixed."
```

Use the returned eval ID to preview, then launch when ready:

```sh
gauge run --eval <eval-id> --local --input release-notes --dry-run
gauge run --eval <eval-id> --local --input release-notes
gauge instructions session-analysis --local
```

The preview checks local readiness without launching an agent. Your coding agent
then reads the session and publishes its analysis. After changing the Skill,
rerun the same eval ID: the new batch snapshots the current input files while
the baseline remains intact. Keep the task, criteria, and model pin fixed,
analyze both batches, then compare:

```sh
gauge run --eval <eval-id> --local --input release-notes
gauge run compare --local --baseline batch=<before-id> --candidate batch=<after-id>
```

For a choice study, use `gauge preference create --kind open-ended` with a task
that lets the agent choose its approach, then `gauge run --preference <id>`.
Supplying the Skill measures choice after that exposure, not discovery on the web.

For a shared or automated version of the eval, use the same input configuration
and create `gauge-cases/release-notes/basic.md`:

```markdown
---
criteria:
  - name: Release notes follow the team format
    rubric: RELEASE-NOTES.md has a version 1.2.0 title, dark mode under Added, and the login crash fix under Fixed.
config:
  agents:
    - agent: CODEX_CLI
  sampleCount: 1
  inputs: [release-notes]
---

Write the release notes for version 1.2.0. We added dark mode and fixed a login crash.
```

This case uses Codex; use `CLAUDE_CODE`, `PI`, or `OPENCODE` to test another
harness with its configured credentials. The agent starts in an empty workspace
with the Skill installed. The task does not explicitly tell it to use the Skill,
so the session also reveals whether it discovers the guidance.

```sh
gauge run --verify --local
gauge run --dry-run --local
gauge run --local
gauge run list --local -o json
```

Verification checks the config and cases. The dry run previews the sessions and
checks local runtime and credential readiness. Neither launches an agent.

Results, transcripts, and available diffs stay under `.gauge/`. Have your coding
agent follow `gauge instructions session-analysis --local` to assess each
criterion and report friction with supporting evidence.

After editing the Skill, rerun the case:

```sh
gauge run --local --files "gauge-cases/release-notes/*.md"
gauge run compare --local --baseline batch=<before-id> --candidate batch=<after-id>
```

Use the batch IDs printed by the runs. The comparison summarizes completion, available turns/duration, and published
criterion judgments. Read the findings and evidence to determine whether the fix worked.

</details>

## What is Gauge?

[Gauge](https://www.withgauge.com) helps teams improve how AI agents discover,
choose, and use their products. **Agent Experience** measures whether agents can
successfully use your product. **Agent Preference** examines which tools agents
choose for a task and why.

This CLI puts that work in the terminal where you and your coding agent already
work. Local execution supports the complete evaluate, analyze, fix, and retest
loop. The hosted platform adds managed infrastructure and shared measurement
over time.

## Local or hosted

Shared Chat/Agents login is the default for `gauge auth login` and
`gauge auth login --device`. See [shared CLI authentication](docs/shared-cli-auth.md)
for refresh, endpoint overrides, and compatibility details.

| | Local | Hosted Gauge |
| --- | --- | --- |
| Execution | Docker on your machine, using your agent credentials | Managed compute; sessions keep running when you close your laptop |
| Results and analysis | File evidence; SQLite measurements, judgments, and Findings authored by your coding agent | Shared results, automated judging, and tracking over time |
| Queries | Run summaries and Findings; supported fields are discoverable | Findings and additional reporting datasets |
| Product inputs | Skills, npm CLIs and SDKs, docs and files, web fixtures | Also native binaries, GitHub-resolved website previews, and authenticated MCPs/APIs |
| Iteration | Test working-tree changes and pre-release artifacts | Also controlled response rewriting and managed optimization trials |
| Automation | CLI scripts and local batches | Also scheduled measurements, GitHub App PR checks, and greater concurrency |
| Account | No Gauge account | Gauge workspace and credits |

[Web fixtures](docs/local-web-fixtures.md) let you test changes to content an
agent encounters, such as a docs page, without publishing them first. They
replace pages or route a site to a preview in both local and hosted runs.
Hosted Gauge's gateway also brokers credentials and can rewrite responses
separately for each session.

Project inputs on saved eval/preference launches, and `--dry-run` for those saved
measurements, are currently local-only. For hosted working-tree input snapshots
and previews, use case files or a case spec with `gauge run --hosted`.
For example, the shared case above supports `gauge run --hosted --dry-run`;
hosted previews contact Gauge and may upload inputs. Local and hosted saved
measurements have separate IDs and storage.

To move a project to hosted execution:

```sh
gauge onboard
gauge init --hosted
gauge instructions --hosted
```

`gauge onboard` signs you in and creates or selects a workspace.
`gauge init --hosted` changes this checkout's private backend preference; it does
not move local measurements or history into hosted storage. Hosted runs use workspace
credits. See the [documentation](https://docs.withgauge.com/agents) for hosted
setup, PR checks, and optimization workflows.

## Commands and documentation

The CLI bundles instructions for coding agents, so the guidance matches the
installed version:

```sh
gauge instructions
gauge instructions init
gauge instructions run
gauge instructions eval
gauge instructions preference
gauge instructions session-analysis
gauge instructions --list
gauge --help
gauge run --help
```

Use `-o json` on read commands for scripts and agent analysis. Check the runtime
with `gauge local runtime inspect`; configure provider credentials with
`gauge local profiles --help`. Update the CLI with `gauge update`.

See the [CLI reference](cli/README.md) for configuration, supported inputs,
credentials, background runs, cleanup, and CI usage.

## Telemetry

The installed CLI collects command usage by default: command name, timestamp,
CLI version, and a random installation ID. It excludes arguments, prompts, file
contents, and account identifiers. Disable collection with:

```sh
gauge telemetry disable
```

Or set `GAUGE_TELEMETRY_DISABLED=1` for a process or CI environment. See
[telemetry details](cli/README.md#anonymous-cli-telemetry) for storage, delivery,
and the distinction from authenticated API usage analytics.

## Development

From the repository root:

```sh
npm ci
npm ci --prefix cli
npm run check
```

`check` builds, typechecks, runs tests, and verifies packaged installs. It does
not require a Gauge account, Docker, a database, or another repository checkout.

| Directory | Contents |
| --- | --- |
| [`cli/`](cli) | CLI commands, bundled agent instructions, and API schemas |
| [`packages/local/`](packages/local) | Local Docker session runner and runtime Dockerfile |
| [`packages/agent-adapters/`](packages/agent-adapters) | Agent transports and evidence decoding |

For a CLI development loop after building, use
`npm run dev --prefix cli -- --help`.

Docker integration checks run in the [custom runtime workflow](.github/workflows/custom-runtime.yml).
The [runtime](.github/workflows/publish-runtime.yml) and
[CLI](.github/workflows/publish-cli.yml) release workflows validate and publish
versioned artifacts. Runtime releases produce a qualified manifest; commit it as
`cli/runtime-manifest.json` before releasing the CLI.

The shared libraries also have public npm releases, published by the
[agent adapters](.github/workflows/publish-agent-adapters.yml) and
[local execution](.github/workflows/publish-local-execution.yml) workflows from
`gauge-sh/gauge-cli`. Each package's npm trusted publisher must point to that
repository and its matching workflow.

See [Releasing](RELEASING.md) for repository setup, package permissions,
and the runtime-to-CLI release sequence.

## Support and contributions

Issues are welcome. Forking and building your own version is the preferred way
to customize Gauge. Only the Gauge team merges changes into this repository;
we periodically consider bringing community changes upstream. See
[CONTRIBUTING.md](CONTRIBUTING.md).

For account questions or private reports, contact
[support@withgauge.com](mailto:support@withgauge.com).

## License

[MIT](LICENSE).
