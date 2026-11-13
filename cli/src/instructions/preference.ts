export const PREFERENCE = `---
name: gauge-preference
description: Design, save, edit, and schedule preference prompts that gauge run
  launches. Read before creating or changing a saved preference prompt.
---

# Preference prompts

A preference prompt measures which product agents choose for a job, and why. Local records live in workspace SQLite; hosted records live in the organization. Editing preserves identity and existing sessions; launches freeze the revision and effective settings. \`gauge run --preference <id>\` launches one. Committed cases in gauge-cases/ need no saved prompt.

## Design the prompt

- Inspect the product, existing measurements, and the user's goal. Map product areas to real use cases and relevant competitors. Define the specific decision being measured, such as a database choice rather than every product mentioned. Reuse measurements for reruns; use descriptive task names and tags for cohorts instead of a market per use case.
- Write a natural first-person request, usually one to three sentences. State the job and necessary context. Avoid arbitrary checklists, invented constraints that favor one vendor, and implementation recipes. Let a pinned fixture establish the existing stack; do not narrate it in the prompt.
- By default, explicitly ask the agent to **research**, make one clear recommendation, and stop before implementation. Keep selection and implementation in separate prompts. If the question is unaided choice, deliberately omit research and label that condition; preserve existing baselines when rerunning.
- Cover unbranded open-ended discovery and relevant head-to-heads for a new baseline. Do not name the target brand or encode its unique features in an unbranded task. A head-to-head names both alternatives in the task and configuration; keep the use case consistent across comparisons. Mark intentionally branded open-ended prompts as branded. Named comparisons measure choice among supplied options, not discovery.
- Example with a supplied project: "I want a hosted documentation site for this project. Research the options and recommend one. Don't build anything yet." For a head-to-head, replace "the options" with the actual two products. Keep operational setup and credentials in supported configuration, not in the task.
- Hosted personas should answer from realistic context and priorities without inventing facts, endorsing vendors, or authorizing implementation in recommendation-only studies. Treat personas, attached skills, and MCP access as experimental conditions, distinct from an unassisted baseline.
- Pilot before scaling. Check that agents research when requested, make a choice for the intended decision, and stop at recommendation. Read \`gauge instructions session-analysis\` for choice evidence, objections, friction, counts, and comparison limits; a product mention or overall rank alone does not establish the choice.

## Find, create, and edit

    gauge preference list -o json
    gauge preference get <id> -o json
    gauge run list --preference <id> -o json
    gauge preference create --kind open-ended --name <name> --text "<prompt>" --agent codex

- A head-to-head needs --brand-a and --brand-b. --branded marks an open-ended prompt that names a brand.
- Repository scenarios work in either backend: \`gauge preference scenarios add <id> --repo <url>\`. Personas and markets require hosted execution. \`gauge preference markets\` lists markets; \`gauge preference edit <id> --market <marketId>\` assigns one.
- Attach gauge.json inputs at launch, not on the prompt: \`gauge run --preference <id> --local --input <name>\` uses configured files; \`--input <name>=<path or glob>\` replaces them. Repeat per input; preview with --dry-run. Hosted saved prompts support neither project inputs nor --dry-run; use hosted case files/specs for input snapshots and previews.
- --agent belongs to the prompt. Hosted --skill, --mcp, and --connection references require hosted execution. Read \`gauge instructions run\` to choose models. Override one launch with \`gauge run --preference <id> --agent ... --samples <n>\`.
- Hosted --setup-file/--teardown-file upload UTF-8 JS/TS files; import bindings from "@withgauge/session". For one launch only, pass the same flags to gauge run --hosted --preference <id>; saved configuration stays unchanged. Edits keep the other hook/params; --clear-setup/--clear-teardown/--clear-lifecycle remove hooks (see --help).
- Hosted --cadence daily|weekly|monthly and --samples schedule repeat runs that spend credits. Confirm the schedule with the user. Local prompts run on demand; personas, markets, recurring schedules, and hosted resource references are unsupported locally.

## Analyze and rerun

Your coding agent analyzes local sessions and publishes choices and findings through \`gauge run analysis save\`; read \`gauge instructions session-analysis --local\`.
After an input change, rebuild/repack and rerun the same preference ID. Local launches snapshot current input files into a new batch. Keep prompts, fixtures, personas, and model pins fixed when testing an input change; analyze and compare baseline/candidate batches before claiming a preference change.
Creating or editing a measurement does not authorize additional paid launches; carry forward existing launch authorization.
`;
