import { LOGO_ART } from "../lib/logo";

const LOCAL_SETUP_PRESENTATION = `For the first local setup explanation, help users understand how Gauge OSS works before seeking any needed launch approval. Users cannot see CLI output. Show this explanation once during setup, starting with the logo:
Open with the FULL Gauge ASCII art below, including the dog, copied verbatim in a fenced text block.
Preserve the Braille characters and spacing in one code block with no blank lines between artwork rows; do not redraw it.
Add one sentence naming the planned case count, agent/model, and local Docker.
Draw a simple overview titled "How Gauge OSS works", with three boxes joined by arrows:
choose tasks + product inputs → agents try your product in local Docker sessions → this coding agent reviews the recorded sessions.
Use one or two short, plain-language lines per box. Make clear the runs happen on this machine, separately from this chat, and the review explains what worked and where agents struggled.
Keep the graphic conceptual: no actual prompts, implementation steps, rubric details, or findings. Do not expand the Docker box into a technical walkthrough.
Use aligned boxes with whitespace; place them side by side if they fit, or stack them on narrow displays. Below the graphic show cases × targets × samples = total sessions, without implying concurrency.
Follow with a compact table of case names, tasks, and success criteria. Use plain text in cells, with semicolons for multiple criteria; no HTML tags or nested lists.
Summarize changed files and routine setup in at most one line.
End with a short launch question, or the next step if launch is already approved.
Include only what will run, what success means, and what happens next. Explain checks
only on problems; omit rejected inputs, selection narration, and recaps unless requested.
Use the diagram to explain Gauge OSS and the table for this run's tasks/criteria; avoid repeating either in prose.
Show planned work as planned; honor existing approval without adding another approval step. For each approved launch, use the compact live update in \`gauge instructions run\` instead of repeating this diagram or full logo.`;

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

    .gauge/config.json     private backend preference
    .gauge/gauge.sqlite    local measurements, launches, summaries, and analyses
    .gauge/.gitignore      ignores workspace state, including the database

Plain init changes no tracked files. Add \`--cases\` when shared, fully specified
cases are useful; it also writes \`gauge.json\` ({ "version": 2, "inputs": {} }),
\`gauge-cases/\`, and an AGENTS.md block pointing to these instructions.
Create \`gauge.json\` yourself to declare named inputs, case paths, and GitHub
checks; it never chooses the execution backend. A configured org binds repository
automation without forcing interactive runs onto hosted Gauge. Commands find the
nearest parent \`gauge.json\` or \`.gauge/\`.

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

export const INIT_LOCAL = INIT.replace(
  "## Next\n",
  `## Explain the first local setup\n\n${LOCAL_SETUP_PRESENTATION}\n\n\`\`\`text\n${LOGO_ART}\n\`\`\`\n\n## Next\n`,
);
