export const PREFERENCE = `---
name: gauge-preference
description: Save, edit, and schedule preference prompts that gauge run
  launches. Read before creating or changing a saved preference prompt.
---

# Preference prompts

A preference prompt groups sessions under a stable identity and an editable
template/defaults: which product do agents choose, and why? Local records live
in the workspace SQLite database; hosted records live in the organization.
Editing preserves identity and existing sessions; launches freeze the revision
and effective settings. \`gauge run --preference <id>\` launches one. Committed cases
in gauge-cases/ need no preference prompt.

## Find and read

    gauge preference list -o json
    gauge preference get <id> -o json
    gauge run list --preference <id> -o json    # its sessions with verdicts

Read \`gauge instructions session-analysis\` to analyze the sessions.

## Create and edit

    gauge preference create --kind open-ended --name <name> --text "<prompt>" --agent codex
    gauge preference edit <id> --market <marketId>

- A head-to-head prompt needs --brand-a and --brand-b. --branded marks an
  open-ended prompt that names a brand.
- Preference prompts support repository scenarios in either backend; personas
  require hosted execution:
  \`gauge preference scenarios add <id> --repo <url>\`.
  \`gauge preference markets\` lists the markets a prompt can measure.
- Attach gauge.json inputs at launch, not on the prompt: \`gauge run --preference <id> --local
  --input <name>\` uses the configured files, and \`--input <name>=<path or glob>\` replaces
  them. Repeat per input; preview with --dry-run. Hosted saved prompts support neither
  project inputs nor --dry-run; use hosted case files/specs for input snapshots and previews.
- --agent belongs to the prompt. Hosted --skill, --mcp, and --connection
  references require hosted execution.
  Read \`gauge instructions run\` to choose models.
- Hosted --setup-file/--teardown-file upload UTF-8 JS/TS files; import bindings from "@withgauge/session". For one launch only, pass the same flags to gauge run --hosted --preference <id>; saved configuration stays unchanged.
  Edits keep the other hook/params; --clear-setup/--clear-teardown/--clear-lifecycle remove hooks (see --help).
- Hosted --cadence daily|weekly|monthly and --samples schedule repeat runs that spend
  credits. Confirm the schedule with the user.
- For one launch with other agents or samples, use
  \`gauge run --preference <id> --agent ... --samples <n>\`.

Local prompts run on demand. Repository-only scenarios are supported locally;
hosted personas, markets, recurring schedules, and resource references are not. The user's coding
agent analyzes local sessions and publishes choices and findings through
\`gauge run analysis save\`; read \`gauge instructions session-analysis --local\`.
After an input change, rebuild/repack and rerun the same preference ID. Local launches
snapshot current input files into a new batch. Keep the prompt and model pins fixed;
analyze and compare baseline/candidate batches before claiming a preference change.
Creating or editing a measurement does not authorize additional paid launches.
`;
