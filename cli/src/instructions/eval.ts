export const EVAL = `---
name: gauge-eval
description: Save, edit, and schedule eval sets that gauge run launches. Read
  before creating or changing a saved eval set.
---

# Eval sets

An eval set groups sessions under a stable identity and an editable prompt,
criteria, and default settings: did the agent succeed? Local measurements live
in this workspace's SQLite database; hosted measurements live in the organization.
IDs are independent of names, directory paths, and Git commits.
\`gauge run --eval <id>\` launches one. Committed cases in gauge-cases/ need no
eval set.

## Find and read

    gauge eval list -o json
    gauge eval get <id> -o json
    gauge run list --eval <id> -o json    # its runs; gauge run get <run-id> shows verdicts

## Create and edit

    gauge eval create --name <name> --file prompt.md --criteria-file criteria.json --repo <url> --agent claude-code
    gauge eval edit <id> --criteria-file criteria.json

- Criteria JSON is [{"name":"...","rubric":"..."}]. Add "id" to edit a
  criterion in place; a list without ids replaces the whole set.
- Without --repo, local sessions start in an empty workspace; hosted uses the Gauge scaffold.
- Attach gauge.json inputs at launch, not on the eval: \`gauge run --eval <id> --local
  --input <name>\` uses the configured files, and \`--input <name>=<path or glob>\` replaces
  them. Repeat per input; preview with --dry-run. Hosted saved evals support neither
  project inputs nor --dry-run; use hosted case files/specs for input snapshots and previews.
- --agent belongs to the eval set. Hosted --skill, --mcp, and --connection
  references require hosted execution. Read
  \`gauge instructions run\` to choose models.
- Hosted --setup-file/--teardown-file upload UTF-8 JS/TS files; import bindings from "@withgauge/session".
  Edits keep the other hook/params; --clear-setup/--clear-teardown/--clear-lifecycle remove hooks (see --help).
- Hosted --cadence daily|weekly|monthly and --samples schedule repeat runs that spend
  credits. Confirm the schedule with the user.
- An edit to the prompt, criteria, repo, or persona starts a new eval revision
  (\`evalRevision\` in \`gauge run list\`). For one launch with other agents
  or samples, use \`gauge run --eval <id> --agent ... --samples <n>\`.

Local measurements run on demand; recurring schedules and hosted resource
references produce explicit capability errors locally. Each launch freezes the
measurement revision and effective settings; editing preserves existing sessions.
Analyze local results with \`gauge instructions session-analysis --local\`.
After an input change, rebuild/repack and rerun the same eval ID. Local launches
snapshot current input files into a new batch. Keep prompts, criteria, and model
pins fixed; analyze and compare baseline/candidate batches before claiming improvement.
Creating or editing a measurement does not authorize additional paid launches.
`;
