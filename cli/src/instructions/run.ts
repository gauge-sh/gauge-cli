const SNAPSHOTS = `Preview JSON separates the source \`path\` from \`gaugeArchive\` hash/bytes in \`inputSnapshots\`. The Gauge delivery archive contains the selected files; for npm it contains the .tgz, so its hash/size differ from the raw .tgz. Launch takes a fresh snapshot; preview does not reserve bytes or prove an eval passed.`;

export const RUN = `---
name: gauge-run
description: Write Gauge eval cases, choose models and judging criteria, and
  launch runs. Read before writing cases or starting runs; includes a migration example.
---

# Run

- Launch with \`gauge run\` (this repo's gauge-cases/ cases), \`gauge run --eval <id>\` or \`--preference <id>\` (saved: \`gauge instructions eval\` or \`gauge instructions preference\`), or \`gauge run --apply <file>\` (\`-\` for stdin) with JSON: a case spec (\`cases\`: Markdown cases as JSON, each with criteria or preference; \`gauge run --example\`) or a battery spec (\`prompts\`: saved prompts and schedules; \`gauge run --example --format battery\`). Follow a launch with \`gauge run wait <request-id>\` (exits 0 once settled; \`--check\` exits 1 unless PASSED or MEASURED), \`gauge run status <request-id>\` (one snapshot), \`gauge run watch <run-id>\`, or \`gauge run get <run-id> --logs\`. For one launch with other agents or sample counts, pass \`--agent\` and \`--samples\` with \`--eval\` or \`--preference\`; do not edit or copy the eval set or preference prompt for a smoke test.
- Measure one meaningful developer outcome. Record the learning goal, reproducible starting state, observable finish line, and execution budget; a coherent migration can span browser and server workflows.
- Write the prompt as a real user's request, in their language. Describe their goal, relevant context, and intended outcome. Preserve constraints they actually supplied; do not assume technical expertise or invent features, UI actions, business rules, commands, filenames, or verification recipes. Leave discovery and implementation choices to the agent.
- Align a small set of independently assessable criteria with the requested outcome and existing application. Accept equivalent supported approaches and execution evidence; remove hidden requirements when revising the prompt.
- Keep repository revisions, credentials, connections, runtime setup, and budgets in supported configuration or fixtures where possible. Inspect \`gauge eval create --help\` and \`gauge run --help\` for current controls; do not assume proposed limits are enforced.
- For shared Markdown cases, preview with \`gauge run --dry-run\` before \`gauge run\`; \`gauge-cases/**/*.md\` cases are discovered automatically and \`--files\` overrides discovery with paths/globs. Root \`gauge.json\` can attach existing GitHub Actions artifacts and committed files; Gauge consumes them without building. Website inputs route a canonical HTTPS origin to an existing public preview; sources are GitHub Deployments or an existing provider PR comment with exact author, readiness pattern, and candidate SHA. Comments without commit identity and private or path-prefixed previews are unsupported.
- Native command inputs use \`type: "binary"\`, \`platform: "linux-x64"\`, selected \`paths\`, and a \`commands\` map from command names to explicit relative ELF executable files. CI must upload already unpacked files. Gauge restores executable permissions and exposes declared commands on PATH; compatible system libraries are required, nested archives and arbitrary installers are unsupported.
- Automatic GitHub PR checks support root \`gauge.json\` \`checks.paths\` as a repo-wide gate and per-case frontmatter \`config.checks.paths\` as a narrower filter. Both accept positive repository-relative globs. Cases without filters run when the repo-wide gate passes; changes to \`gauge.json\` select all cases and edits to a case select that case. Explicit CLI launches and GitHub reruns ignore both filters. Failed/unfinished previous checks, changed target branches, and unavailable diffs run conservatively. \`config.inputs\` selects inputs, not triggers.
- Pilot before scaling; confirm before spending credits. Creating definitions does not authorize launching runs. Report sample counts and distinguish incorrect behavior, missing evidence, environment failures, and budget exhaustion.
- Gauge tests artifacts from the PR's successful build; preserve CI's existing checkout settings, including the default merge checkout. Fork PRs are disabled by default. In Gauge's GitHub settings, check **Allow fork pull requests**; a workspace member then follows the GitHub check link to authorize that revision using workspace credits and connections. New revisions and explicit reruns need fresh approval. Inputs still determine readiness.
- For authenticated MCP access, connect the account in Gauge, complete OAuth in the browser when required, and put the versioned server reference in case \`config.mcpRefs\`. Gauge manages session credentials; keep tokens out of prompts and Git.
- To test local build output without the GitHub App, use \`gauge run --input name=path --yes -o json\`. Repeat \`--input\` for each input. This uses current evaluation files, including edits; other inputs keep their configured sources. Skills accept directories or archives, npm packages accept .tgz files, and file/binary inputs accept directories. Use \`gauge run wait <id> --check -o json\` for the verdict, criterion results, and session links; with \`--check\`, failed checks exit 1 and stdout is only the JSON.
- Before committing setup changes, run \`gauge run --verify -o json\` for a local working-tree checklist. Only attempted static checks are scored yes, no, or unknown; unknown means a specific declaration could not be resolved. Informational findings (such as zero cases) are separate. JSON includes a version, static status (passed/failed/incomplete), summary counts, global/per-input checks with stable IDs, facts, info, and excluded capabilities in notChecked. Exit 1 means a definite problem; exit 0 can still contain unknowns. Live delivery, account settings, and sandbox execution are outside this command's scope. It requires no login or PR and launches no sessions.

## Definition and input snapshots

Interactive CLI runs read working-tree case definitions in both backends, including
uncommitted edits and new files. Selected filesystem inputs are packaged for local
execution or hosted upload. Explicit remote artifacts retain their declared sources.
Content digests identify what ran; a nearby Git SHA does not mean edited bytes were
committed. GitHub-triggered checks fetch the committed revision. None of this changes
the separately configured consumer repository where the test agent works.

${SNAPSHOTS}

## Model selection

Choose a roster for the question and budget. For exploratory testing, start with a diverse panel of open models; reserve a smaller set of Claude Code and Codex sessions for calibration and confirmation. Do not automatically use only Claude Opus and GPT Sol. Honor an explicitly requested model or harness when that experience is the measurement.

- **Breadth:** Open models make repetition and coverage across tasks, repositories, personas, skills, and MCP configurations more affordable. Select several available model families rather than treating one model as representative.
- **Confirmation:** Use frontier sessions to investigate disagreements and confirm consequential findings. Periodically repeat a subset of open-model cases with frontier targets and investigate meaningful drift.
- **Limits:** Gauge's proxy evidence comes from Agent Preference comparisons. Similar product choices do not establish equal coding ability or identical eval pass rates. Calibrate on your own tasks before generalizing.
- **Controls:** Run \`gauge models list -o json\` for the current organization catalog. A target combines a model and harness; select supported pairs in case \`config.agents\`, or with repeated \`--agent pi:<model>\`, \`opencode:<model>\`, \`claude-code:<model>\`, or \`codex:<model>\` on \`gauge eval create|edit\` or \`gauge preference create|edit\`. Pin catalog identifiers explicitly; omitting a model uses the harness default. Treat the harness as part of the comparison.
- **Comparison:** Keep each case's prompt, fixture, criteria, and other settings fixed when comparing targets. Budget for targets × samples per case; inspect per-target results and execution evidence rather than only a pooled score. For before/after questions, use \`gauge run compare --baseline <key=value> --candidate <key=value>\` (keys: request, batch, eval, revision, experiment, trial, agent, model, since, until); do not join runs by hand. Each run has an \`evalRevision\`, and each case has its own. When compare warns that one eval or case ran under several revisions, it was edited between runs, so pick one with \`revision=<hash>\`. Run compare after \`gauge run wait\` settles. Optimization trial runs test a changed configuration: selectors other than \`trial=<trialId>\` leave them out, and a run's \`optimizationTrial\` names its trial.

Background: [Open models as preference proxies](https://www.withgauge.com/blog/open-models-useful-proxies-data-from-1000-sessions/).

## Git-authored Agent Preference
Replace \`criteria\` with \`preference: { kind: open-ended }\`, adding \`branded: true\` when the prompt names brands. For a comparison use \`preference: { kind: head-to-head, brandA: PostHog, brandB: Amplitude }\`. Specify exactly one of criteria/preference; the body remains the task and must name the comparison brands itself.
Existing per-case settings, inputs, and path filters apply. The app's preference analyst reports advisory choices; competitor selections never fail criteria. Preference-only checks finish neutral; mixed case sets retain experience gating. With \`--check\`, the wait command succeeds for MEASURED/PASSED and fails on operational errors. No base/head delta is inferred.

## Migration prompt and criteria

This example tests migration of an existing feature-flag application across browser and server workflows. Its starting repository contains the application, while attached connections supply destination credentials. The source account's targeting configuration is unavailable.

### Keep the substantial task

A bad version of this migration prompt would add specific features, such as a flag selector, an account switcher, or an activity log. It might also specify exact UI layouts, clicks to perform, SDK calls, or files to edit. Those directions assume the user already knows the implementation and add requirements beyond their goal.

Use the kind of language a user would naturally use to ask for a change. For example, "Let me pass a feature to the CLI and get instructions for it" describes the desired behavior without prescribing command registration or rendering code. Keep details the user actually requests; do not add exact specifications or UI/UX actions just to make grading easier.

> Migrate this app from its current feature-flag provider to the replacement provider while preserving its existing functionality. Get it running locally, verify the migration works, and explain any limitations.

If the user also asks for a complete replacement, carry that decision into the rubric. Do not add backward compatibility or a gradual production rollout solely because a migration guide recommends them.

### Define observable success

Inspect the starting application and relevant migration guidance before drafting criteria. For this application, success means existing browser and server workflows continue to work through the destination provider, live evaluations drive the running UI, and active dependencies on the source provider are removed when full replacement is requested. The rubric can assess behavior present in the source without dictating SDK methods, edited files, or an exact test sequence.

Suitable criteria for this fixture:

- **Complete migration:** Required flags and code references are accounted for. The active integration uses the destination provider, and the app no longer needs the source provider at runtime when full replacement is requested. A separate demo or hardcoded replacement is insufficient.
- **Preserved behavior:** Existing browser/server workflows, context changes, and server-provided initial values continue to work. Available configuration is preserved or differences explained. Exact historical targeting parity cannot be established without source rules.
- **Verified working application:** Execution evidence connects live flag evaluation from the destination provider to the running app's behavior across its browser and server workflows. A build or standalone SDK probe alone does not demonstrate the migration.
- **Appropriate product surfaces:** Supported SDKs/providers fit the browser and server runtimes; supported management interfaces handle configuration; credentials fit each surface. Equivalent approaches are acceptable, and using every tool is unnecessary.

Keep environment identifiers, credential mappings, repository revision, and resource isolation in supported connection or fixture mechanisms where possible. Authoring notes and source limitations must not become an extra implementation checklist.

Missing source rules limit the parity claim. Record that uncertainty and assess observable application behavior; do not replace it with an invented targeting contract. If account-configuration migration is the requested outcome, prepare the required source data before calling the fixture ready.
`;

export const RUN_LOCAL = `---
name: gauge-run
description: Write local Gauge eval and Agent Preference cases for this repo's
  skills, CLI, or SDK and verify them. Read before creating or editing cases.
---

# Run (local)

For a product hillclimb and docs exposure limits, read \`gauge instructions hillclimb\`.
## Choose a definition source

Save an ongoing measurement with \`gauge eval\` or \`gauge preference\`, then
launch it with \`gauge run --eval <id> --local\` or \`--preference <id>\`.
Read their instruction topics for create/edit flags. Saved measurements live in
\`.gauge/gauge.sqlite\` with stable identity and revision history. They require
no committed case files. The file-based examples below are for measurements
you intend to share or automate. Both sources work with local and hosted backends.

## How a run works

In local mode, with no Gauge account, each case starts a new coding agent in local Docker. That agent sees only:
- the case prompt,
- the case inputs from gauge.json (a skill, a packed CLI or SDK, or docs),
- its starting directory: empty, or a public repo from \`config.repoUrl\` and \`config.repoRef\`.
It does not see this repo, this conversation, or the user. Write each prompt for that starting state:
- Empty directory: ask for new work ("Create…", "Set up…"). Never write "my app" or "this project".
- Existing code: set \`config.repoUrl\` to a repo it can clone. Then the prompt can refer to that code.

## Pick the surface

| Surface | Input in gauge.json | Scenario | Local |
|---|---|---|---|
| Skill | \`skill\`, path to the skill directory | greenfield dir, skill installed in the agent | yes |
| CLI | \`npm-package\`, \`install: environment\` | greenfield dir, pack of this checkout | yes |
| SDK | \`npm-package\`, \`install: workspace\` | greenfield app in the SDK's language | yes |
| Docs | \`files\`, \`paths\` globs | docs given to the agent as files | yes |

Binary, website preview routing, and MCP inputs are hosted only. Supplied docs files test content use; they do not replace the canonical site or test its discovery. A reachable preview URL in the prompt is another content-only option, with the same discovery limitation. Choose the surface the user wants to test rather than adding a Skill to an existing CLI or SDK.

Add one \`inputs\` entry in gauge.json per surface or skill; keep every other key. An \`npm-package\` \`path\` is a glob that must match one packed .tgz. \`gauge run\` does not pack it: run \`npm pack\` after every change, and delete old .tgz files.

    "inputs": { "release-notes": { "type": "skill", "path": "skills/release-notes" },
                "cli": { "type": "npm-package", "path": "acme-cli-*.tgz", "install": "environment" } }

${SNAPSHOTS}

## Write good cases

- Measure one meaningful developer outcome. Record the learning goal, reproducible starting state, and observable finish line.
- Write the prompt as a real user's request, in their language. Describe their goal, relevant context, and intended outcome. Preserve constraints they actually supplied; do not assume technical expertise or invent features, UI actions, business rules, commands, filenames, or verification recipes. Leave discovery and implementation choices to the agent. Every file, app, or fact that the prompt names must exist in the starting state, or be in the prompt.
- Align a small set of independently assessable criteria with the requested outcome and existing application. Accept equivalent supported approaches and execution evidence; remove hidden requirements when revising the prompt.
- **CLI:** the package's commands are on PATH. Cover first use, a common workflow, and recovery from a mistake. Judge the result (files, output, state), not the exact commands or flags.
- **Skill:** the skill is installed. Ask for a task the skill should help with, but do not name the skill: the eval also shows whether the agent finds it. Judge the result, not whether the agent opened the skill.
- **SDK:** the agent starts in a new app that depends on the package. Ask for a feature a user would build with it. Judge that the app runs and makes real SDK calls, not mocks or hardcoded values.

Put each case in gauge-cases/<input>/<case>.md, one folder per surface. An eval case (\`criteria\`) asks: did the agent succeed? A preference case (\`preference\`) asks: which tool did the agent choose, and why? For a preference case, replace \`criteria\` with \`preference: { kind: open-ended }\`; add \`branded: true\` when the prompt names brands. To compare two tools, use \`preference: { kind: head-to-head, brandA: PostHog, brandB: Amplitude }\` and name both brands in the prompt. Your coding agent reads the evidence and publishes structured choices, criteria, and findings; use \`gauge instructions session-analysis --local\`.

    ---
    criteria:
      - name: Team format
        rubric: RELEASE-NOTES.md lists both changes in the team's format.
    config:
      agents:
        - agent: CLAUDE_CODE
      inputs: [release-notes]
    ---
    Write the release notes for version 1.2.0. We added dark mode and fixed a login crash.

\`config.agents\` is required: CLAUDE_CODE, CODEX_CLI, PI, or OPENCODE. For the first evals, use only the agent you are (Claude Code: CLAUDE_CODE; Codex: CODEX_CLI); its login is on this machine. Add agents only when the user asks. Omit \`models\` to use the agent's default. Use only keys hosted Gauge accepts; do not add a \`scenario\` key.

## Verify and run

    gauge run --verify -o json     # check the cases; fix every failure
    gauge run                      # every case in gauge-cases/
    gauge run --apply cases.json   # cases as JSON, no Markdown; each with criteria or preference ("-" for stdin; see --example)

This runs every case in local Docker and waits. It needs Docker, the public runtime (install with \`gauge local runtime pull\`; inspect with \`gauge local runtime inspect\`), and agent logins: \`codex login\` for Codex, Pi, and OpenCode; \`claude\` or \`ANTHROPIC_API_KEY\` for Claude Code. Then do its "Next" step. Ctrl+C cancels and cleans up; results and cached images remain. Use \`gauge run --detach --local\` for a background batch; it prints exact status/wait/stop commands. Inspect with \`gauge run status --batch <id> --local\`; block until it settles with \`gauge run wait --batch <id> --local\` (do not write a polling loop); stop with \`gauge run cancel --batch <id> --local\` (or \`gauge run cancel <run-id> --local\`). Clean up interrupted sessions with \`gauge cleanup --local\`; it preserves evidence and leaves active sessions alone. For stale or missing database session summaries, use \`gauge run repair --local\` to rebuild them from artifacts while preserving measurements and analyses. Keep .gauge/gauge.sqlite: it is durable data, not a disposable cache. Local credentials can use native logins or API keys. Configure references with \`gauge local profiles set work --agent CODEX_CLI --provider openai --auth api_key --env TEAM_OPENAI_KEY\`, then \`gauge local profiles use work\`. Pass the variable name, never a key value. Inspect with \`gauge local profiles inspect work -o json\`; update with \`set ... --replace\`, list with \`list\`, and remove references with \`remove <profile>\`. \`gauge run --local --profile work\` overrides defaults and must be compatible with every target. Dry-run reports each actual model’s credential readiness; local checks do not verify provider acceptance. Detached batches retain the selected references even if defaults change. For additional system tools,derive an image from the standard runtime and pass \`--runtime-image <image>\` to \`gauge run --local\` (also works with \`--dry-run\` and \`--detach\`). Build or pull that image first. Dry runs show its reference and immutable ID without starting a container; actual runs check required tools, selected harnesses, permissions and command forwarding before accepting the batch. Every queued session uses the frozen image ID even if its tag changes. Preserve runtime contract label \`sh.gauge.contract="1"\` and the base harnesses; an entrypoint must execute the supplied command.
`;
