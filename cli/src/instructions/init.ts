export const INIT = `---
name: gauge-init
description: Initialize a Gauge workspace, choose local or hosted execution,
  and optionally scaffold shared cases. Read before running gauge init.
---

# Init

\`gauge init\` creates shared configuration and private state in this directory. Git is optional.
Use \`gauge onboard\` separately to set up a hosted Gauge account.

## Choose a backend

- Local: agents run in Docker on this machine using native agent logins or API
  keys. No Gauge account is required.
- Hosted: agents run on Gauge using the selected organization's credits.
  Authenticate with \`gauge onboard\` or \`gauge auth login\` before launching.

Backend precedence is an explicit \`--local\` or \`--hosted\` flag, workspace
preference, user preference, then local. Signing in never changes this choice.
Run \`gauge init --hosted\` or \`gauge init --local\` to change the workspace
preference. The selection is private to this checkout.

## What it writes

    gauge.json             shared manifest: { "version": 2, "inputs": {} }
    .gauge/config.json     private backend preference
    .gauge/gauge.sqlite    local measurements, launches, summaries, and analyses
    .gauge/.gitignore      ignores workspace state, including the database
    AGENTS.md              a Gauge block pointing to these instructions

Plain init creates no cases. Add \`--cases\` to scaffold \`gauge-cases/\` when
shared, fully specified cases are useful. \`gauge.json\` can declare named
inputs, case paths, and GitHub checks; it never chooses the execution backend.
A configured org binds repository automation without forcing interactive runs
onto hosted Gauge. Commands find the nearest parent \`gauge.json\`.

Repeat init safely: it preserves measurements and existing shared configuration,
and refreshes the Gauge instructions block. Commit shared configuration, optional
cases, and agent guidance. Keep \`.gauge/\` private; it contains durable user data,
not just a disposable cache. Moving the workspace preserves its IDs. A fresh
clone or linked worktree starts with independent local measurements and history.
Credentials and user preferences remain in the user configuration directory.

## Next

For open-ended setup, read \`gauge instructions hillclimb\`: identify inputs, pilot, analyze, improve, and rerun; check docs/backend boundaries first.

Create a measurement before previewing: \`gauge eval create\` for task success or
\`gauge preference create\` for product choice, then \`gauge run --eval <id>\` or
\`--preference <id>\`. Read \`gauge instructions eval\` or \`gauge instructions preference\`.
Local saved launches support \`--dry-run\` and \`--input <name>\`. Hosted project
inputs and previews use case files/specs; read \`gauge instructions run\`.

Gauge recommends the gauge-agents skill for future sessions:
\`gauge install-skill\`. Coding agents install it for themselves in this project, without prompts.
`;
