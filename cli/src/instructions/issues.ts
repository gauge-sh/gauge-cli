export const ISSUES = `---
name: gauge-issues
description: Find the friction agents hit with your product and their
  objections to it, ranked by impact. Read before choosing what to improve.
---

# Issues

An issue is the same finding across many sessions. Each issue is friction,
which agents hit in any session, or an objection, which agents raise when they
pass on your product in a preference session. Findings is an alternative term
for issues. Gauge groups each analyzed run's findings into issues per product.

## Find and read

    gauge issues list -o json                  # every issue, most sessions first
    gauge issues list --type friction -o json  # or --type objection
    gauge issues get <id> -o json         # the issue's findings, runs, and agents
    gauge run insight <run> -o json       # one run's findings with their issue

Friction shows impact by effect: BLOCKED, EXTRA_WORK, RECOVERED, or UNKNOWN.
Objection shows where agents went instead. Some findings are not in an issue
yet; \`issues list\` counts them.

## Close and recheck

Each issue is open, fixed, or muted. \`issues list\` shows open issues;
\`--status fixed\`, \`--status muted\`, or \`--status all\` shows the others.

    gauge issues fix <id>                 # done; it reopens if agents hit it again
    gauge issues mute <id>                # not relevant; it never reopens
    gauge issues reopen <id>              # back to open (also unmutes)
    gauge issues recheck <id>             # preview the past runs it would repeat
    gauge issues recheck <id> --confirm   # rerun them; get shows which still show it

- Fix an issue after you ship a change for it. Gauge reopens it when a run
  that started after the fix shows it again, and marks it "came back".
- Mute an issue only when the user says it is irrelevant or by design. Muted
  issues still collect findings, so they never come back as new issues.
- \`recheck\` (alias \`verify\`) never prompts. Without \`--confirm\` it only
  previews: the past runs it would repeat, the latest per prompt, agent, and
  model, with the default 3 checked. Show the user the preview and ask before
  you add \`--confirm\`, because reruns spend credits. \`--run <runId>...\` picks
  others, at most 10. The result shows in \`gauge issues get <id>\` when the
  reruns are analyzed: "looks fixed" if none show the issue, "still seen in n
  of m" if some do. A recheck never closes an issue: tell the user the result,
  and run \`gauge issues fix <id>\` when they agree. A fixed issue that shows it
  again reopens.

## Choose what to improve

- Rank by sessions and effect. BLOCKED and EXTRA_WORK cost agents the most.
- Read the findings and their evidence before you name a cause.
- Prefer issues on surfaces the org owns: its docs, skills, and CLI.
- Improve an issue with \`gauge optimizations create --issue <id>\`:
  \`gauge instructions optimization\`.
`;
